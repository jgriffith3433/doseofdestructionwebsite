// The GPU servers on AWS: EC2 g6e instances (an NVIDIA L40S, 48 GB each) that
// run ComfyUI. Launch one once; it installs itself (comfy/server/bootstrap.sh)
// and powers itself off when idle. Start and stop them from devtools after
// that. There can be several (a fleet, up to the GPU tab's "Servers to use"):
// the job queue runs one job on each ready server at a time.
// Everything this creates is tagged Project=dose-of-destruction.
//
// It can live in any region in REGIONS that has GPU quota: launch picks the
// first with quota and free capacity, or the region you name. Errors carry a
// kind (capacity, quota, auth, other) so devtools can say what to do next.
//
// Local state (each server's region, access token and SSH key) lives in
// .cache/gpu/, which is gitignored. Functions that act on one server take its
// instance id; without one they act on the newest.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  EC2Client,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  ServiceQuotasClient,
  GetServiceQuotaCommand,
  ListRequestedServiceQuotaChangeHistoryByQuotaCommand,
  RequestServiceQuotaIncreaseCommand,
} from '@aws-sdk/client-service-quotas';
import { ROOT, awsConfig, readEnv } from './env.mjs';

/**
 * Instance types that fit the models (they need at least a 48 GB GPU and
 * 32 GB of memory). Prices are on-demand list prices in the US regions, for
 * estimates only: your AWS bill is the authority.
 *
 * g6e: NVIDIA L40S, 48 GB. The cheapest fit, and so the one AWS most often
 * runs out of. g7e: NVIDIA RTX PRO 6000 Blackwell, 96 GB (AWS: up to 2.3x
 * g6e's inference speed, 1.85x the memory bandwidth), so a job costs about
 * the same and finishes sooner, and image and video models fit side by side.
 * A newer, separate pool of machines, offered in every region we use.
 */
export const TYPES = {
  // Cheapest first: "any" launches try them in this order. Wan video needs about
  // 34 GB of GPU memory and the image models 28 GB (docs/comfyui.md).
  'g6e.xlarge': { vcpus: 4, memory: 32, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 1.861 },
  'g6e.2xlarge': { vcpus: 8, memory: 64, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 2.242 },
  'g7e.2xlarge': { vcpus: 8, memory: 64, vram: 96, gpu: 'NVIDIA RTX PRO 6000 Blackwell, 96 GB', price: 3.36 },
  'g6e.4xlarge': { vcpus: 16, memory: 128, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 3.004 },
  'g7e.4xlarge': { vcpus: 16, memory: 128, vram: 96, gpu: 'NVIDIA RTX PRO 6000 Blackwell, 96 GB', price: 4.0 },
};
export const DEFAULT_TYPE = 'g6e.xlarge';
/** Regions the server may live in, most preferred first (the US first: cheapest). */
export const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-north-1', 'eu-central-1', 'ap-northeast-1'];
/** Rough price outside the US regions, relative to TYPES (estimates; your bill is the authority). */
const PRICE_FACTOR = { 'eu-north-1': 1.1, 'eu-central-1': 1.25, 'ap-northeast-1': 1.3 };
export const priceIn = (type, region) => (TYPES[type]?.price ?? TYPES[DEFAULT_TYPE].price) * (PRICE_FACTOR[region] ?? 1);
export const DISK_GB = 250;
export const DISK_PER_MONTH = DISK_GB * 0.08 + (300 - 125) * 0.04;
export const PORT = 8189;
// Running On-Demand G and VT instances, counted in vCPUs.
const QUOTA = { ServiceCode: 'ec2', QuotaCode: 'L-DB2E81BA' };
const TAG = { Key: 'Project', Value: 'dose-of-destruction' };
const NAME = 'dod-comfy';
const SG_NAME = 'dod-comfy';
const STATE_DIR = path.join(ROOT, '.cache', 'gpu');
const STATE_FILE = path.join(STATE_DIR, 'server.json');

/** An AWS error with what kind of problem it is and every attempt that led to it. */
export class GpuError extends Error {
  constructor(message, kind = 'other', attempts = []) {
    super(message);
    this.kind = kind;
    this.attempts = attempts;
  }
}

/** capacity: AWS is out of these machines here right now. quota: the account may not run that many. */
export function classify(e) {
  const n = e?.name ?? e?.Code ?? '';
  if (['InsufficientInstanceCapacity', 'InsufficientCapacity', 'InsufficientHostCapacity', 'Unsupported'].includes(n)) return 'capacity';
  if (['VcpuLimitExceeded', 'InstanceLimitExceeded', 'MaxSpotInstanceCountExceeded'].includes(n)) return 'quota';
  if (['UnauthorizedOperation', 'AuthFailure', 'InvalidClientTokenId', 'SignatureDoesNotMatch', 'AccessDenied', 'AccessDeniedException', 'OptInRequired', 'UnrecognizedClientException'].includes(n)) return 'auth';
  return 'other';
}

const clients = new Map();
function ec2(region) {
  if (!clients.has(region)) clients.set(region, new EC2Client({ ...awsConfig(), region }));
  return clients.get(region);
}
function quotas(region) {
  return new ServiceQuotasClient({ ...awsConfig(), region });
}

export function localState() {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    st = {};
  }
  // Per server: its password and key. The first server was saved at the top level.
  st.servers ??= {};
  if (st.instanceId && st.token && !st.servers[st.instanceId]) {
    st.servers[st.instanceId] = { region: st.region, type: st.type, token: st.token, idleMinutes: st.idleMinutes, keyName: st.keyName, zone: st.zone, launchedAt: st.launchedAt };
  }
  return st;
}

/** What this machine saved about one server: { token, keyName, idleMinutes, ... }. */
function record(id) {
  return localState().servers[id] ?? {};
}

function saveRecord(id, patch) {
  const st = localState();
  saveState({ servers: { ...st.servers, [id]: { ...(st.servers[id] ?? {}), ...patch } } });
}

function saveState(patch) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...localState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The region in .env, if it's one we use. */
function homeRegion() {
  const r = readEnv().AWS_DEFAULT_REGION;
  return REGIONS.includes(r) ? r : REGIONS[0];
}

/** This machine's public IP, which the security group lets in. */
export async function myIp() {
  const r = await fetch('https://checkip.amazonaws.com');
  const ip = (await r.text()).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`Could not work out this machine's public IP (got "${ip}")`);
  return ip;
}

async function serversIn(region) {
  const r = await ec2(region).send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${TAG.Key}`, Values: [TAG.Value] },
      { Name: 'tag:Name', Values: [NAME] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'] },
    ],
  }));
  return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((instance) => ({ instance, region }));
}

let listCache = { at: 0, value: null };

/** Every project GPU server that isn't terminated, in every region, newest first. Cached for 5 s. */
export async function listServers({ force = false } = {}) {
  if (!force && listCache.value && Date.now() - listCache.at < 5000) return listCache.value;
  const all = (await Promise.all(REGIONS.map((r) => serversIn(r).catch(() => [])))).flat();
  const value = all.sort((a, b) => (b.instance.LaunchTime?.getTime() ?? 0) - (a.instance.LaunchTime?.getTime() ?? 0));
  listCache = { at: Date.now(), value };
  return value;
}

/** One server by instance id; without one, the newest (a running one first). */
export async function findServer(id) {
  const all = await listServers();
  if (id) return all.find((s) => s.instance.InstanceId === id) ?? null;
  return all.find((s) => ['running', 'pending'].includes(s.instance.State?.Name)) ?? all[0] ?? null;
}

/** The hourly price of a server (or of the default type). */
export async function currentPrice(id) {
  const s = await findServer(id).catch(() => null);
  return priceIn(s?.instance.InstanceType ?? DEFAULT_TYPE, s?.region);
}

const BASE = () => ({ types: TYPES, regions: REGIONS, defaultType: DEFAULT_TYPE, diskPerMonth: DISK_PER_MONTH, diskGb: DISK_GB });

/** What one server is doing: AWS state plus the install progress it reports. */
async function statusOf({ instance: i, region }) {
  const rec = record(i.InstanceId);
  const ip = i.PublicIpAddress ?? null;
  const keyName = i.KeyName ?? rec.keyName;
  const out = {
    exists: true,
    ...BASE(),
    id: i.InstanceId,
    region,
    type: i.InstanceType,
    state: i.State?.Name,
    reason: i.StateReason?.Message ?? null,
    ip,
    zone: i.Placement?.AvailabilityZone,
    launched: i.LaunchTime?.toISOString(),
    pricePerHour: priceIn(i.InstanceType, region),
    url: ip ? `http://${ip}:${PORT}` : null,
    user: 'dod',
    hasToken: Boolean(rec.token),
    idleMinutes: rec.idleMinutes ?? null,
    key: keyName ? path.join('.cache', 'gpu', `${keyName}.pem`) : null,
    boot: null,
  };
  if (i.State?.Name === 'running' && ip && rec.token) {
    try {
      const r = await fetch(`http://${ip}:${PORT}/dod/status.json`, { headers: authHeader(rec.token), signal: AbortSignal.timeout(4000) });
      out.boot = r.ok ? await r.json() : r.status === 401 ? { stage: 'locked out', detail: 'the server rejected the saved password' } : { stage: 'unreachable', detail: `HTTP ${r.status}` };
    } catch {
      out.boot = { stage: 'booting', detail: 'waiting for the server to answer (if this lasts, your IP may have changed: Refresh access)' };
    }
  } else if (i.State?.Name === 'running' && !rec.token) {
    out.boot = { stage: 'locked out', detail: 'this computer has no password for it (.cache/gpu/server.json): it was launched elsewhere' };
  }
  return out;
}

/** One server's status; without an id, the newest (or { exists: false }). */
export async function serverStatus(id) {
  const found = await findServer(id);
  if (!found) return { exists: false, ...BASE(), type: DEFAULT_TYPE, pricePerHour: TYPES[DEFAULT_TYPE].price };
  return statusOf(found);
}

/** Every server's status, newest first. idleMinutes: bring ready servers' idle stop to this. */
export async function fleetStatus({ idleMinutes } = {}) {
  const list = await Promise.all((await listServers()).map(statusOf));
  if (idleMinutes) for (const st of list) if (st.state === 'running' && st.boot?.stage === 'ready' && st.idleMinutes !== idleMinutes) void setIdle(st.id, idleMinutes);
  return list;
}

const settingIdle = new Set();

/** Changes how long a running server waits idle before it stops itself (over SSH). */
export async function setIdle(id, minutes) {
  const m = Math.max(10, Math.min(240, Math.round(Number(minutes))));
  if (settingIdle.has(id)) return;
  settingIdle.add(id);
  try {
    await sshRun(`sudo sed -i -E 's/^IDLE_MINUTES=.*/IDLE_MINUTES=${m}/' /usr/local/bin/dod-idle.sh && grep -q '^IDLE_MINUTES=${m}$' /usr/local/bin/dod-idle.sh && echo ok`, id);
    saveRecord(id, { idleMinutes: m });
    console.log(`[gpu] ${id} now stops after ${m} idle minutes`);
  } catch (e) {
    console.warn(`[gpu] couldn't set the idle stop on ${id}: ${e.message}`);
  } finally {
    settingIdle.delete(id);
  }
}

/** Running and pending GPU vCPUs per region (what counts against the quota). */
async function vcpusInUse() {
  const used = {};
  for (const { instance: i, region } of await listServers()) {
    if (['running', 'pending'].includes(i.State?.Name)) used[region] = (used[region] ?? 0) + (TYPES[i.InstanceType]?.vcpus ?? 4);
  }
  return used;
}

export function authHeader(token) {
  return { Authorization: `Basic ${Buffer.from(`dod:${token}`).toString('base64')}` };
}

// ------------------------------------------------------------ regions

let regionCache = { at: 0, value: null };

/** Per region: GPU quota, open quota requests, and the zones offering each type. Cached for 5 minutes. */
export async function regionsInfo({ force = false } = {}) {
  if (!force && regionCache.value && Date.now() - regionCache.at < 5 * 60 * 1000) return regionCache.value;
  const value = await Promise.all(REGIONS.map(async (region) => {
    const out = { region, quota: null, requests: [], zones: {}, error: null };
    try {
      const q = await quotas(region).send(new GetServiceQuotaCommand(QUOTA));
      out.quota = q.Quota?.Value ?? 0;
    } catch (e) {
      out.error = `quota unreadable (${e.name})`;
    }
    try {
      const h = await quotas(region).send(new ListRequestedServiceQuotaChangeHistoryByQuotaCommand(QUOTA));
      out.requests = (h.RequestedQuotas ?? [])
        .sort((a, b) => (b.Created?.getTime() ?? 0) - (a.Created?.getTime() ?? 0))
        .slice(0, 3)
        .map((r) => ({ value: r.DesiredValue, status: r.Status, caseId: r.CaseId ?? null, created: r.Created?.toISOString() }));
    } catch {
      // The history is a nice-to-have.
    }
    try {
      const off = await ec2(region).send(new DescribeInstanceTypeOfferingsCommand({
        LocationType: 'availability-zone',
        Filters: [{ Name: 'instance-type', Values: Object.keys(TYPES) }],
      }));
      for (const o of off.InstanceTypeOfferings ?? []) (out.zones[o.InstanceType] ??= []).push(o.Location);
      for (const z of Object.values(out.zones)) z.sort();
    } catch (e) {
      out.error ??= `offerings unreadable (${e.name})`;
    }
    return out;
  }));
  regionCache = { at: Date.now(), value };
  return value;
}

/** Asks AWS for more GPU quota in a region. Free; AWS reviews it. */
export async function requestQuota(region, value) {
  if (!REGIONS.includes(region)) throw new GpuError(`Not a region the server uses: ${region}`);
  const want = Math.round(Number(value));
  if (!(want >= 4 && want <= 64)) throw new GpuError('Ask for between 4 and 64 vCPUs');
  try {
    const r = await quotas(region).send(new RequestServiceQuotaIncreaseCommand({ ...QUOTA, DesiredValue: want }));
    regionCache.at = 0;
    return { region, value: r.RequestedQuota?.DesiredValue, status: r.RequestedQuota?.Status };
  } catch (e) {
    if (e.name === 'ResourceAlreadyExistsException') throw new GpuError(`${region} already has a quota request open. Wait for AWS to answer it.`, 'quota');
    if (e.name === 'IllegalArgumentException' || e.name === 'InvalidParameterValueException') throw new GpuError(`AWS wouldn't take that request: ${e.message}`, 'quota');
    throw new GpuError(`${e.name}: ${e.message}`, classify(e));
  }
}

// ------------------------------------------------------------- set up

async function defaultVpc(region) {
  const r = await ec2(region).send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
  const id = r.Vpcs?.[0]?.VpcId;
  if (!id) throw new GpuError(`${region} has no default VPC. Create one in the VPC console there (Actions > Create default VPC).`);
  return id;
}

/** The security group: only this machine's IP may reach the proxy and SSH. */
async function ensureSecurityGroup(region, ip) {
  const vpc = await defaultVpc(region);
  const found = await ec2(region).send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'group-name', Values: [SG_NAME] }, { Name: 'vpc-id', Values: [vpc] }],
  }));
  let sg = found.SecurityGroups?.[0];
  if (!sg) {
    const made = await ec2(region).send(new CreateSecurityGroupCommand({
      GroupName: SG_NAME,
      Description: 'Dose of Destruction GPU server: ComfyUI proxy and SSH from the developer IP only',
      VpcId: vpc,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [TAG, { Key: 'Name', Value: SG_NAME }] }],
    }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  await allowOnly(region, sg, ip);
  return sg.GroupId;
}

/** Opens the proxy and SSH ports to one IP and closes them to any other. */
async function allowOnly(region, sg, ip) {
  const want = `${ip}/32`;
  const stale = [];
  for (const perm of sg.IpPermissions ?? []) {
    for (const range of perm.IpRanges ?? []) {
      if (range.CidrIp !== want) stale.push({ IpProtocol: perm.IpProtocol, FromPort: perm.FromPort, ToPort: perm.ToPort, IpRanges: [{ CidrIp: range.CidrIp }] });
    }
  }
  if (stale.length) await ec2(region).send(new RevokeSecurityGroupIngressCommand({ GroupId: sg.GroupId, IpPermissions: stale }));
  for (const port of [PORT, 22]) {
    const has = (sg.IpPermissions ?? []).some((p) => p.FromPort === port && (p.IpRanges ?? []).some((r) => r.CidrIp === want));
    if (has) continue;
    try {
      await ec2(region).send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: sg.GroupId,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: want, Description: 'devtools' }] }],
      }));
    } catch (e) {
      if (e.name !== 'InvalidPermission.Duplicate') throw e;
    }
  }
}

/** Lets this machine's current IP in (every region with a server), for when it has changed since launch. */
export async function refreshAccess() {
  const ip = await myIp();
  const regions = [...new Set((await listServers()).map((s) => s.region))];
  if (!regions.length) regions.push(localState().region ?? homeRegion());
  for (const region of regions) {
    const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG_NAME] }] }));
    const sg = r.SecurityGroups?.[0];
    if (sg) await allowOnly(region, sg, ip);
  }
  return { ip, regions };
}

/** An SSH key for debugging the server, saved to .cache/gpu/. Key pairs belong to one region. */
async function ensureKeyPair(region) {
  const base = region === 'us-east-1' ? 'dod-comfy' : `dod-comfy-${region}`;
  const existing = await ec2(region).send(new DescribeKeyPairsCommand({ Filters: [{ Name: 'key-name', Values: [base] }] }));
  if (existing.KeyPairs?.length && fs.existsSync(path.join(STATE_DIR, `${base}.pem`))) return base;
  // A key without its private half here is no use; make a fresh one with a new name.
  const name = existing.KeyPairs?.length ? `${base}-${Date.now()}` : base;
  const made = await ec2(region).send(new CreateKeyPairCommand({
    KeyName: name,
    KeyType: 'ed25519',
    TagSpecifications: [{ ResourceType: 'key-pair', Tags: [TAG] }],
  }));
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${name}.pem`), made.KeyMaterial, { mode: 0o600 });
  lockKey(path.join(STATE_DIR, `${name}.pem`));
  return name;
}

/**
 * Windows' ssh refuses a key other accounts can read (file modes don't apply
 * there), so give only this user read access.
 */
function lockKey(file) {
  if (process.platform !== 'win32') return;
  spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:R`], { stdio: 'ignore' });
}

/** The newest AWS Deep Learning Base GPU image (NVIDIA driver preinstalled) in a region. */
async function gpuImage(region) {
  const r = await ec2(region).send(new DescribeImagesCommand({
    Owners: ['amazon'],
    Filters: [
      { Name: 'name', Values: ['Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*'] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['x86_64'] },
    ],
  }));
  const img = (r.Images ?? []).sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))[0];
  if (!img) throw new GpuError(`Could not find the AWS Deep Learning Base GPU image in ${region}.`);
  return img;
}

/** Fills in bootstrap.sh from comfy/models.json. */
export function userData(token, idleMinutes) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'comfy', 'models.json'), 'utf8'));
  const script = fs
    .readFileSync(path.join(ROOT, 'comfy', 'server', 'bootstrap.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll('__TOKEN__', token)
    .replaceAll('__IDLE_MINUTES__', String(idleMinutes))
    .replaceAll('__COMFY_TAG__', manifest.comfyui.tag)
    .replaceAll('__COMFY_REPO__', manifest.comfyui.repo)
    .replace('__NODES__', manifest.nodes.map((n) => `${n.repo} ${n.commit}`).join('\n'))
    .replace('__MODELS__', manifest.models.map((m) => `${m.dir} ${m.file} ${m.url}`).join('\n'));
  // cloud-init accepts gzipped user data, which keeps us well under EC2's 16 KB limit.
  return zlib.gzipSync(Buffer.from(script)).toString('base64');
}

/** The regions to try, in order: the one asked for, or every region with enough quota. */
async function launchRegions(region, vcpus, type) {
  if (region && region !== 'auto') {
    if (!REGIONS.includes(region)) throw new GpuError(`Not a region the server uses: ${region}`);
    return [region];
  }
  const info = await regionsInfo();
  const used = await vcpusInUse();
  const free = (r) => (info.find((x) => x.region === r)?.quota ?? 0) - (used[r] ?? 0);
  // Where AWS says machines are free first (its spot placement score, 1 to 10: a
  // free hint that tracks on-demand capacity well), then where the most quota is
  // free, so a fleet spreads out; the home region breaks ties.
  const { scoresFor } = await import('./capacity.mjs');
  const score = type ? await scoresFor(type).catch(() => ({})) : {};
  const order = [homeRegion(), ...REGIONS].filter((r, i, a) => a.indexOf(r) === i);
  const ok = order.filter((r) => free(r) >= vcpus).sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0) || free(b) - free(a));
  if (!ok.length) {
    throw new GpuError(
      `No region has ${vcpus} GPU vCPUs of quota free (${info.map((x) => `${x.region}: ${(x.quota ?? 0) - (used[x.region] ?? 0)} of ${x.quota ?? '?'} free`).join(', ')}). Stop a server, or request more in the Regions card.`,
      'quota',
    );
  }
  return ok;
}

/**
 * Creates a server (another one, if there are some). Costs money from here
 * on: see TYPES. type 'auto' tries every type in TYPES (all 48 GB L40S
 * machines), best first, in every region with quota free for it. max: how
 * many servers there may be in all.
 */
export async function launchServer({ idleMinutes = 30, region = 'auto', type = DEFAULT_TYPE, max = 4 } = {}) {
  if (type !== 'auto' && !TYPES[type]) throw new GpuError(`Not an instance type the server uses: ${type}`);
  const existing = await listServers({ force: true });
  if (existing.length >= max) throw new GpuError(`There are already ${existing.length} GPU servers (the most "Servers to use" allows). Start one of them instead, or raise the setting.`);
  const ip = await myIp();
  const token = crypto.randomBytes(24).toString('base64url');
  const data = userData(token, idleMinutes);
  const attempts = [];
  const setups = new Map();

  /** The security group, key and image a region needs (once per region). */
  const setupFor = async (r) => {
    if (!setups.has(r)) {
      setups.set(r, (async () => {
        const [sg, key, image] = await Promise.all([ensureSecurityGroup(r, ip), ensureKeyPair(r), gpuImage(r)]);
        const vpc = await defaultVpc(r);
        const subnets = await ec2(r).send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'default-for-az', Values: ['true'] }] }));
        return { sg, key, image, subnets: subnets.Subnets ?? [] };
      })());
    }
    return setups.get(r);
  };

  const types = type === 'auto' ? Object.keys(TYPES) : [type];
  for (const t of types) {
    let regions;
    try {
      regions = await launchRegions(region, TYPES[t].vcpus, t);
    } catch (e) {
      attempts.push({ region: region === 'auto' ? 'any' : region, zone: null, type: t, code: 'quota', kind: 'quota', message: e.message });
      continue;
    }
    for (const r of regions) {
      let setup;
      let candidates;
      try {
        setup = await setupFor(r);
        const offered = await ec2(r).send(new DescribeInstanceTypeOfferingsCommand({
          LocationType: 'availability-zone',
          Filters: [{ Name: 'instance-type', Values: [t] }],
        }));
        const zones = new Set((offered.InstanceTypeOfferings ?? []).map((o) => o.Location));
        candidates = setup.subnets.filter((s) => zones.has(s.AvailabilityZone));
        if (!candidates.length) throw new GpuError(`${r} has no default subnet in a zone offering ${t}`, 'capacity');
      } catch (e) {
        const kind = e.kind ?? classify(e);
        attempts.push({ region: r, zone: null, type: t, code: e.name, kind, message: e.message });
        if (kind === 'auth') throw new GpuError(`The AWS keys aren't allowed to set up the server in ${r}: ${e.message}`, 'auth', attempts);
        continue;
      }

      // First let AWS choose the zone (its own advice when one is full), then try each zone.
      for (const subnet of [null, ...candidates]) {
        try {
          const res = await ec2(r).send(new RunInstancesCommand({
            ImageId: setup.image.ImageId,
            InstanceType: t,
            MinCount: 1,
            MaxCount: 1,
            KeyName: setup.key,
            ...(subnet ? { SubnetId: subnet.SubnetId } : {}),
            SecurityGroupIds: [setup.sg],
            UserData: data,
            InstanceInitiatedShutdownBehavior: 'stop',
            BlockDeviceMappings: [{
              DeviceName: setup.image.RootDeviceName ?? '/dev/sda1',
              Ebs: { VolumeSize: DISK_GB, VolumeType: 'gp3', Iops: 3000, Throughput: 300, DeleteOnTermination: true },
            }],
            TagSpecifications: [
              { ResourceType: 'instance', Tags: [TAG, { Key: 'Name', Value: NAME }] },
              { ResourceType: 'volume', Tags: [TAG, { Key: 'Name', Value: NAME }] },
            ],
          }));
          const id = res.Instances?.[0]?.InstanceId;
          const zone = res.Instances?.[0]?.Placement?.AvailabilityZone ?? subnet?.AvailabilityZone ?? 'any';
          saveState({ region: r, securityGroup: setup.sg, image: setup.image.ImageId });
          saveRecord(id, { region: r, type: t, token, idleMinutes, keyName: setup.key, zone, launchedAt: new Date().toISOString() });
          listCache.at = 0;
          attempts.push({ region: r, zone, type: t, code: 'ok', kind: 'ok', message: 'launched' });
          return { id, region: r, zone, type: t, image: setup.image.Name, attempts };
        } catch (e) {
          const kind = classify(e);
          attempts.push({ region: r, zone: subnet?.AvailabilityZone ?? 'any zone', type: t, code: e.name, kind, message: e.message });
          if (kind === 'auth') throw new GpuError(`The AWS keys aren't allowed to launch ${t} in ${r}: ${e.message}`, 'auth', attempts);
          if (kind === 'quota') break; // the rest of this region's zones share the quota
          if (kind !== 'capacity') throw new GpuError(`${r} ${subnet?.AvailabilityZone ?? 'any zone'} ${t}: ${e.name}: ${e.message}`, kind, attempts);
        }
      }
    }
  }
  throw failure(type === 'auto' ? `any 48 GB GPU machine (${types.join(', ')})` : type, attempts);
}

/** One error out of every failed attempt. */
function failure(type, attempts) {
  const kinds = new Set(attempts.map((a) => a.kind));
  const where = [...new Set(attempts.map((a) => a.region))].join(', ');
  if (kinds.size === 1 && kinds.has('capacity')) return new GpuError(`AWS has no ${type} free right now in ${where}. This usually clears within minutes to hours; try again or keep trying.`, 'capacity', attempts);
  if (kinds.has('quota') && !kinds.has('capacity')) return new GpuError(`The account's GPU quota is too low for ${type} in ${where}. Request more in the Regions card.`, 'quota', attempts);
  if (kinds.has('capacity')) return new GpuError(`No capacity or quota for ${type} in ${where} right now.`, 'capacity', attempts);
  return new GpuError(`Couldn't launch ${type}: ${attempts.map((a) => `${a.region}${a.zone ? ` ${a.zone}` : ''}: ${a.code}`).join(', ')}`, 'other', attempts);
}

async function requireServer(id) {
  const s = await findServer(id);
  if (!s) throw new GpuError(id ? `There is no GPU server ${id}.` : 'There is no GPU server yet. Launch one first.');
  return s;
}

export async function startServer(id) {
  const { instance: i, region } = await requireServer(id);
  await refreshAccess();
  if (i.State?.Name === 'stopped') {
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
      listCache.at = 0;
    } catch (e) {
      const kind = classify(e);
      const attempts = [{ region, zone: i.Placement?.AvailabilityZone, code: e.name, kind, message: e.message }];
      if (kind === 'capacity') throw new GpuError(`AWS has no ${i.InstanceType} free in ${i.Placement?.AvailabilityZone} right now, so the server can't start. It stays where it is (with its models); try again or keep trying.`, 'capacity', attempts);
      if (kind === 'quota') throw new GpuError(`${region} has no GPU quota free for another running server. Stop one there, or request more quota.`, 'quota', attempts);
      throw new GpuError(`${e.name}: ${e.message}`, kind, attempts);
    }
  } else if (i.State?.Name !== 'running' && i.State?.Name !== 'pending') {
    throw new GpuError(`The server is ${i.State?.Name}; wait for it to finish, then start it.`);
  }
  return { id: i.InstanceId, region, was: i.State?.Name };
}

export async function stopServer(id) {
  const { instance: i, region } = await requireServer(id);
  if (i.State?.Name === 'running' || i.State?.Name === 'pending') await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
  listCache.at = 0;
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Deletes a server and its disk (models included). Launching again re-downloads everything. */
export async function terminateServer(id) {
  const { instance: i, region } = await requireServer(id);
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  const st = localState();
  const servers = { ...st.servers };
  delete servers[i.InstanceId];
  saveState({ servers, ...(st.instanceId === i.InstanceId ? { instanceId: null, token: null } : {}), terminatedAt: new Date().toISOString() });
  listCache.at = 0;
  return { id: i.InstanceId, region };
}

/** Base URL and auth for talking to ComfyUI on one server (the first ready one without an id). */
export async function comfyEndpoint(id) {
  if (!id) {
    const [first] = await comfyEndpoints();
    if (first) return first;
  }
  const st = await serverStatus(id);
  if (!st.exists) throw new Error('There is no GPU server. Launch it in the GPU tab.');
  if (st.state !== 'running') throw new Error(`The GPU server is ${st.state}. Start it in the GPU tab.`);
  if (st.boot?.stage !== 'ready') throw new Error(`The GPU server is still setting up (${st.boot?.stage ?? 'booting'}: ${st.boot?.detail ?? ''}).`);
  return { id: st.id, region: st.region, price: st.pricePerHour, url: st.url, headers: authHeader(record(st.id).token) };
}

/** Every server ready for jobs: [{ id, region, price, url, headers }]. */
export async function comfyEndpoints() {
  return (await fleetStatus())
    .filter((st) => st.state === 'running' && st.boot?.stage === 'ready')
    .map((st) => ({ id: st.id, region: st.region, price: st.pricePerHour, url: st.url, headers: authHeader(record(st.id).token) }));
}

/** Runs a command on the server over SSH with its saved key; resolves to its output. */
async function sshRun(remote, id) {
  const found = await findServer(id);
  if (!found) throw new GpuError('There is no GPU server.');
  const ip = found.instance.PublicIpAddress;
  if (!ip) throw new GpuError(`The server is ${found.instance.State?.Name}; it has no address until it runs.`);
  const keyName = found.instance.KeyName ?? record(found.instance.InstanceId).keyName ?? localState().keyName;
  const key = path.join(STATE_DIR, `${keyName}.pem`);
  if (!fs.existsSync(key)) throw new GpuError(`The SSH key ${keyName}.pem isn't in .cache/gpu/.`);
  lockKey(key);
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', `ubuntu@${ip}`, remote]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new GpuError(`Couldn't run ssh (${e.message}). Install OpenSSH, or read the log in the AWS console.`)));
    child.on('close', (code) => {
      if (code === 0 || out) resolve(out);
      else reject(new GpuError(/permission|unprotected|bad permissions/i.test(err)
        ? `ssh refused the key file's permissions. In PowerShell: icacls "${key}" /inheritance:r /grant:r "$env:USERNAME:R"`
        : `ssh failed: ${err.trim().split('\n').pop() || `exit ${code}`} (if your IP changed, Refresh access; if the server is overloaded, wait or reboot it)`));
    });
  });
}

/**
 * What the server is doing, over SSH: the setup log (the step lines and the
 * last raw lines), disk, memory, the GPU and ComfyUI.
 */
export async function serverLog(lines = 40, id) {
  const n = Math.max(10, Math.min(400, Number(lines) || 40));
  return sshRun([
    'echo "## steps"', 'sudo grep "^== " /var/log/dod-bootstrap.log | tail -n 30',
    'echo "## last lines"', `sudo tail -n ${n} /var/log/dod-bootstrap.log | grep -v -E "^(Requirement already satisfied|  Downloading|  Using cached)"`,
    'echo "## ComfyUI"', 'systemctl show -p ExecStart --value comfyui 2>/dev/null | grep -o "argv\[\]=[^;]*"', 'sudo journalctl -u comfyui --no-pager -n 15 2>/dev/null | cut -c1-220',
    'echo "## machine"', 'uptime', 'df -h / | tail -1', 'free -h | sed -n 2,3p',
    'nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "no GPU info"',
    'echo "ComfyUI service: $(systemctl is-active comfyui 2>/dev/null || echo not installed yet)"',
  ].join('; '), id);
}

/** The ComfyUI flags that work on these machines (docs/comfyui.md), and ones that break them. */
export const COMFY_FLAGS = { want: ['--disable-pinned-memory'], avoid: ['--highvram', '--disable-dynamic-vram', '--gpu-only'] };

/** Is the server set up the way docs/comfyui.md says works? Flags, memory, disk, GPU. */
export async function serverHealth(id) {
  const out = await sshRun([
    'echo "flags=$(systemctl show -p ExecStart --value comfyui 2>/dev/null | grep -o "main.py[^;]*" | head -1)"',
    'echo "active=$(systemctl is-active comfyui 2>/dev/null)"',
    "free -m | awk '/^Mem:/{print \"ram=\"$3\"/\"$2} /^Swap:/{print \"swap=\"$3\"/\"$2}'",
    "df -BG / | awk 'NR==2{print \"disk=\"$3\"/\"$2}'",
    'echo "gpu=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | tr -d " ")"',
  ].join('; '), id);
  const v = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...r]) => [k.trim(), r.join('=').trim()]));
  const flags = (v.flags ?? '').split(/\s+/).filter((f) => f.startsWith('--'));
  const missing = COMFY_FLAGS.want.filter((f) => !flags.includes(f));
  const bad = COMFY_FLAGS.avoid.filter((f) => flags.includes(f));
  const [gUsed, gTotal] = (v.gpu ?? '').split(',').map(Number);
  return {
    ok: !missing.length && !bad.length && v.active === 'active',
    active: v.active ?? 'unknown',
    flags,
    missing,
    bad,
    ram: v.ram ?? null,
    swap: v.swap ?? null,
    disk: v.disk ?? null,
    gpu: Number.isFinite(gTotal) ? { usedMb: gUsed, totalMb: gTotal } : null,
  };
}

/** Puts ComfyUI on the flags that work and restarts it. Queued jobs wait for it to come back. */
export async function fixServer(id) {
  const keep = '--listen 127.0.0.1 --port 8188 --disable-auto-launch';
  const want = `${keep} ${COMFY_FLAGS.want.join(' ')}`;
  await sshRun([
    `sudo sed -i -E "s|^(ExecStart=.*main\.py).*|\\1 ${want}|" /etc/systemd/system/comfyui.service`,
    'sudo systemctl daemon-reload', 'sudo systemctl restart comfyui',
    'for i in $(seq 1 45); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8188/system_stats | grep -q 200 && break; sleep 2; done',
  ].join(' && '), id);
  return serverHealth(id);
}
