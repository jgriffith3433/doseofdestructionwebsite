// The GPU fleet, through Hawkes Gen (C:\Projects\hawkesgen, http://127.0.0.1:8790).
//
// Hawkes Gen owns the AWS servers, ComfyUI, the job queue that shares them
// between every game, the keys and the costs. This module gives devApi.mjs the
// same functions it used to import from aws.mjs, fleet.mjs, retry.mjs,
// capacity.mjs and check.mjs, so the GPU tab works as before while the work
// happens in Hawkes Gen. Start Hawkes Gen first (hawkesgen\auto-start.bat).
//
// The old aws.mjs, comfy.mjs and workflows.mjs stay only because Sick Of It's
// Tools/Art/art.mjs still imports them; devtools no longer does.

import { HawkesGen, HawkesGenError } from './hawkesgen.mjs';

export const gen = new HawkesGen({ project: 'doseofdestruction' });
export const GpuError = HawkesGenError;

// Filled from Hawkes Gen on every fleet read; the values below are only until the first one.
export let TYPES = { 'g6e.xlarge': { vcpus: 4, memory: 32, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 1.861 } };
export let DEFAULT_TYPE = 'g6e.xlarge';
export let DISK_PER_MONTH = 27;
export let FLEET_MAX = 16;

let last = null;
let settings = { servers: 4, auto: false, idleMinutes: 60 };

/** Every server's status (Hawkes Gen's /v1/fleet), newest first. */
export async function fleetStatus() {
  last = await gen.fleet();
  TYPES = last.types ?? TYPES;
  DEFAULT_TYPE = last.defaultType ?? DEFAULT_TYPE;
  DISK_PER_MONTH = last.diskPerMonth ?? DISK_PER_MONTH;
  FLEET_MAX = last.settings?.max ?? FLEET_MAX;
  settings = { servers: last.settings.servers, auto: last.settings.auto, idleMinutes: last.settings.idleMinutes };
  if (last.error) throw new HawkesGenError(last.error, { kind: 'auth' });
  return last.servers;
}

/** The fleet settings (servers, auto start, idle minutes) as of the last read. */
export const loadFleet = () => ({ ...settings });

/** Saves fleet settings in Hawkes Gen; returns them right away. */
export function saveFleet(patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  settings = { ...settings, ...clean };
  gen.fleetSettings(clean).then((r) => { settings = { ...settings, ...r.settings }; }).catch((e) => console.warn(`[gpu] couldn't save fleet settings in Hawkes Gen: ${e.message}`));
  return { ...settings };
}

const act = (action, body = {}) => gen.fleetAction(action, body);

export const launchServer = (opts = {}) => act('launch', { confirm: true, ...opts });
export const startServer = (id) => act('start', { confirm: true, id });
export const stopServer = (id) => act('stop', { id });
export const terminateServer = (id) => act('terminate', { confirm: true, id });
export const refreshAccess = () => act('access');
export const fixServer = async (id) => (await act('fix', { confirm: true, id })).health;
export const serverHealth = (id) => gen.request(`/fleet/health${id ? `?id=${id}` : ''}`);
export const serverLog = async (lines, id) => (await gen.request(`/fleet/log?lines=${lines ?? 40}${id ? `&id=${id}` : ''}`)).log;
export const regionsInfo = async ({ force = false } = {}) => (await gen.request(`/fleet/regions${force ? '?refresh=1' : ''}`)).regions;
export const requestQuota = (region, value) => gen.request('/fleet/quota', { method: 'POST', body: { region, value } });
export const capacityScores = async () => (await gen.request('/fleet/capacity')).scores;

/** The AWS account Hawkes Gen uses (who the keys belong to, GPU quota). */
export async function checkAccount() {
  if (!last) await fleetStatus().catch(() => {});
  return last?.account ?? { error: 'Hawkes Gen has not read the account yet' };
}

/** "Keep trying" runs in Hawkes Gen; this mirrors its state for the GPU tab. */
export class Retry {
  get state() {
    return last?.retry ?? null;
  }
  start({ action, opts, minutes, every }) {
    const p = act(action, { confirm: true, ...opts, keepTrying: { minutes, every } });
    p.catch((e) => console.warn(`[gpu] keep trying: ${e.message}`));
    return { active: true, action, opts, every, started: Date.now(), until: Date.now() + minutes * 60000, next: Date.now(), tries: 0, log: [] };
  }
  stop() {
    act('retry-stop').catch(() => {});
  }
  suspend() {}
}

/**
 * Claude through Hawkes Gen (llm.json): images (file paths) and a prompt in,
 * JSON matching schema out. Hawkes Gen holds the key and counts the cost.
 */
export async function askClaude({ prompt, system, images = [], schema, maxTokens = 16000, effort = 'high', labels }) {
  const job = await gen.run('llm.json', {
    params: { prompt, system, schema, maxTokens, effort },
    inputs: images.length ? { images } : {},
    labels,
    timeoutMs: 15 * 60 * 1000,
  });
  return { value: job.result?.value, usage: job.result?.usage ?? {}, model: job.result?.model };
}

/** Does Hawkes Gen answer, and does it have a Claude key? */
export async function claudeAvailable() {
  try {
    return (await gen.health()).providers?.anthropic === true;
  } catch {
    return false;
  }
}
