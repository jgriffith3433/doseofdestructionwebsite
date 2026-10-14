// The GPU server on AWS: one EC2 g6e instance (an NVIDIA L40S, 48 GB) that
// runs ComfyUI. Launch it once; it installs itself (comfy/server/bootstrap.sh)
// and powers itself off when idle. Start and stop it from devtools after that.
// Everything this creates is tagged Project=dose-of-destruction.
//
// It can live in any region in REGIONS that has GPU quota: launch picks the
// first with quota and free capacity, or the region you name. Errors carry a
// kind (capacity, quota, auth, other) so devtools can say what to do next.
//
// Local state (region, instance id, access token, SSH keys) lives in
// .cache/gpu/, which is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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
 * Instance types that fit the models (they need the 48 GB GPU and at least
 * 32 GB of memory). Prices are on-demand list prices in the US regions, for
 * estimates only: your AWS bill is the authority.
 */
export const TYPES = {
  'g6e.xlarge': { vcpus: 4, memory: 32, gpu: 'NVIDIA L40S, 48 GB', price: 1.861 },
  'g6e.2xlarge': { vcpus: 8, memory: 64, gpu: 'NVIDIA L40S, 48 GB', price: 2.242 },
  'g6e.4xlarge': { vcpus: 16, memory: 128, gpu: 'NVIDIA L40S, 48 GB', price: 3.004 },
};
export const DEFAULT_TYPE = 'g6e.xlarge';
/** Regions the server may live in, most preferred first. Prices above hold for these. */
export const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
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
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
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

/** The project's GPU server in any region, if there is one (and it isn't terminated). */
export async function findServer() {
  // Look where it was last seen first; only search everywhere if it isn't there.
  const known = localState().region;
  if (known) {
    const here = await serversIn(known).catch(() => []);
    if (here.length) return newest(here);
  }
  const all = (await Promise.all(REGIONS.filter((r) => r !== known).map((r) => serversIn(r).catch(() => [])))).flat();
  const found = newest(all);
  if (found) saveState({ region: found.region });
  return found;
}

function newest(list) {
  return list.sort((a, b) => (b.instance.LaunchTime?.getTime() ?? 0) - (a.instance.LaunchTime?.getTime() ?? 0))[0] ?? null;
}

/** The hourly price for the server (or the default type when there isn't one). */
export async function currentPrice() {
  const s = await findServer().catch(() => null);
  return TYPES[s?.instance.InstanceType ?? DEFAULT_TYPE]?.price ?? TYPES[DEFAULT_TYPE].price;
}

/** What the server is doing: AWS state plus the install progress it reports. */
export async function serverStatus() {
  const found = await findServer();
  const st = localState();
  const base = { types: TYPES, regions: REGIONS, defaultType: DEFAULT_TYPE, diskPerMonth: DISK_PER_MONTH, diskGb: DISK_GB };
  if (!found) return { exists: false, ...base, type: DEFAULT_TYPE, pricePerHour: TYPES[DEFAULT_TYPE].price };
  const { instance: i, region } = found;
  const ip = i.PublicIpAddress ?? null;
  const out = {
    exists: true,
    ...base,
    id: i.InstanceId,
    region,
    type: i.InstanceType,
    state: i.State?.Name,
    reason: i.StateReason?.Message ?? null,
    ip,
    zone: i.Placement?.AvailabilityZone,
    launched: i.LaunchTime?.toISOString(),
    pricePerHour: TYPES[i.InstanceType]?.price ?? TYPES[DEFAULT_TYPE].price,
    url: ip ? `http://${ip}:${PORT}` : null,
    user: 'dod',
    hasToken: Boolean(st.token),
    idleMinutes: st.idleMinutes ?? null,
    key: st.keyName ? path.join('.cache', 'gpu', `${st.keyName}.pem`) : null,
    boot: null,
  };
  if (i.State?.Name === 'running' && ip && st.token) {
    try {
      const r = await fetch(`http://${ip}:${PORT}/dod/status.json`, { headers: authHeader(st.token), signal: AbortSignal.timeout(4000) });
      out.boot = r.ok ? await r.json() : r.status === 401 ? { stage: 'locked out', detail: 'the server rejected the saved password' } : { stage: 'unreachable', detail: `HTTP ${r.status}` };
    } catch {
      out.boot = { stage: 'booting', detail: 'waiting for the server to answer (if this lasts, your IP may have changed: Refresh access)' };
    }
  }
  return out;
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

/** Lets this machine's current IP in, for when it has changed since launch. */
export async function refreshAccess() {
  const ip = await myIp();
  const region = (await findServer())?.region ?? localState().region ?? homeRegion();
  const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG_NAME] }] }));
  const sg = r.SecurityGroups?.[0];
  if (sg) await allowOnly(region, sg, ip);
  return { ip, region };
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
  return name;
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
async function launchRegions(region, vcpus) {
  if (region && region !== 'auto') {
    if (!REGIONS.includes(region)) throw new GpuError(`Not a region the server uses: ${region}`);
    return [region];
  }
  const info = await regionsInfo();
  const order = [localState().region, homeRegion(), ...REGIONS].filter((r, i, a) => r && a.indexOf(r) === i);
  const ok = order.filter((r) => (info.find((x) => x.region === r)?.quota ?? 0) >= vcpus);
  if (!ok.length) {
    throw new GpuError(
      `No region has quota for ${vcpus} GPU vCPUs (${info.map((x) => `${x.region}: ${x.quota ?? '?'}`).join(', ')}). Request more in the Regions card.`,
      'quota',
    );
  }
  return ok;
}

/** Creates the server. Costs money from here on: see TYPES. */
export async function launchServer({ idleMinutes = 30, region = 'auto', type = DEFAULT_TYPE } = {}) {
  if (!TYPES[type]) throw new GpuError(`Not an instance type the server uses: ${type}`);
  const existing = await findServer();
  if (existing) throw new GpuError(`A GPU server already exists in ${existing.region}. Start it instead of launching another.`);
  const ip = await myIp();
  const token = crypto.randomBytes(24).toString('base64url');
  const data = userData(token, idleMinutes);
  const attempts = [];

  for (const r of await launchRegions(region, TYPES[type].vcpus)) {
    let setup;
    try {
      const [sg, key, image] = await Promise.all([ensureSecurityGroup(r, ip), ensureKeyPair(r), gpuImage(r)]);
      const offered = await ec2(r).send(new DescribeInstanceTypeOfferingsCommand({
        LocationType: 'availability-zone',
        Filters: [{ Name: 'instance-type', Values: [type] }],
      }));
      const zones = new Set((offered.InstanceTypeOfferings ?? []).map((o) => o.Location));
      const vpc = await defaultVpc(r);
      const subnets = await ec2(r).send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'default-for-az', Values: ['true'] }] }));
      const candidates = (subnets.Subnets ?? []).filter((s) => zones.has(s.AvailabilityZone));
      if (!candidates.length) throw new GpuError(`${r} has no default subnet in a zone offering ${type}`, 'capacity');
      setup = { sg, key, image, candidates };
    } catch (e) {
      const kind = e.kind ?? classify(e);
      attempts.push({ region: r, zone: null, code: e.name, kind, message: e.message });
      if (kind === 'auth') throw new GpuError(`The AWS keys aren't allowed to set up the server in ${r}: ${e.message}`, 'auth', attempts);
      continue;
    }

    for (const subnet of setup.candidates) {
      try {
        const res = await ec2(r).send(new RunInstancesCommand({
          ImageId: setup.image.ImageId,
          InstanceType: type,
          MinCount: 1,
          MaxCount: 1,
          KeyName: setup.key,
          SubnetId: subnet.SubnetId,
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
        saveState({ region: r, instanceId: id, type, token, idleMinutes, keyName: setup.key, securityGroup: setup.sg, image: setup.image.ImageId, zone: subnet.AvailabilityZone, launchedAt: new Date().toISOString() });
        attempts.push({ region: r, zone: subnet.AvailabilityZone, code: 'ok', kind: 'ok', message: 'launched' });
        return { id, region: r, zone: subnet.AvailabilityZone, type, image: setup.image.Name, attempts };
      } catch (e) {
        const kind = classify(e);
        attempts.push({ region: r, zone: subnet.AvailabilityZone, code: e.name, kind, message: e.message });
        if (kind === 'auth') throw new GpuError(`The AWS keys aren't allowed to launch ${type} in ${r}: ${e.message}`, 'auth', attempts);
        if (kind === 'quota') break; // the rest of this region's zones share the quota
        if (kind !== 'capacity') throw new GpuError(`${r} ${subnet.AvailabilityZone}: ${e.name}: ${e.message}`, kind, attempts);
      }
    }
  }
  throw failure(type, attempts);
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

async function requireServer() {
  const s = await findServer();
  if (!s) throw new GpuError('There is no GPU server yet. Launch one first.');
  return s;
}

export async function startServer() {
  const { instance: i, region } = await requireServer();
  await refreshAccess();
  if (i.State?.Name === 'stopped') {
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
    } catch (e) {
      const kind = classify(e);
      const attempts = [{ region, zone: i.Placement?.AvailabilityZone, code: e.name, kind, message: e.message }];
      if (kind === 'capacity') throw new GpuError(`AWS has no ${i.InstanceType} free in ${i.Placement?.AvailabilityZone} right now, so the server can't start. It stays where it is (with its models); try again or keep trying.`, 'capacity', attempts);
      throw new GpuError(`${e.name}: ${e.message}`, kind, attempts);
    }
  } else if (i.State?.Name !== 'running' && i.State?.Name !== 'pending') {
    throw new GpuError(`The server is ${i.State?.Name}; wait for it to finish, then start it.`);
  }
  return { id: i.InstanceId, region, was: i.State?.Name };
}

export async function stopServer() {
  const { instance: i, region } = await requireServer();
  if (i.State?.Name === 'running' || i.State?.Name === 'pending') await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Deletes the server and its disk (models included). Launching again re-downloads everything. */
export async function terminateServer() {
  const { instance: i, region } = await requireServer();
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  saveState({ instanceId: null, token: null, terminatedAt: new Date().toISOString() });
  return { id: i.InstanceId, region };
}

/** Base URL and auth for talking to ComfyUI through the proxy. */
export async function comfyEndpoint() {
  const st = await serverStatus();
  if (!st.exists) throw new Error('There is no GPU server. Launch it in the GPU tab.');
  if (st.state !== 'running') throw new Error(`The GPU server is ${st.state}. Start it in the GPU tab.`);
  if (st.boot?.stage !== 'ready') throw new Error(`The GPU server is still setting up (${st.boot?.stage ?? 'booting'}: ${st.boot?.detail ?? ''}).`);
  return { url: st.url, headers: authHeader(localState().token) };
}
