// The GPU service's API, shared by the GPU, AI Settings, Clips, Animations and Fighters tabs.

import { api } from './api.ts';

export interface InstanceType {
  vcpus: number;
  memory: number;
  gpu: string;
  price: number;
}

export interface GpuServer {
  exists: boolean;
  error?: string;
  id?: string;
  region?: string;
  type: string;
  types: Record<string, InstanceType>;
  regions?: string[];
  defaultType?: string;
  state?: string;
  reason?: string | null;
  ip?: string | null;
  zone?: string;
  launched?: string;
  url?: string | null;
  user?: string;
  hasToken?: boolean;
  idleMinutes?: number | null;
  key?: string | null;
  pricePerHour: number;
  diskPerMonth: number;
  diskGb?: number;
  boot?: { stage: string; detail: string; time?: number } | null;
}

export interface RegionInfo {
  region: string;
  quota: number | null;
  requests: { value: number; status: string; caseId: string | null; created?: string }[];
  zones: Record<string, string[]>;
  error: string | null;
}

/** One zone or region a launch tried. kind: ok | capacity | quota | auth | other. */
export interface Attempt {
  region: string;
  zone: string | null;
  code: string;
  kind: string;
  message: string;
}

export interface Failure {
  at?: number;
  message: string;
  kind: string;
  attempts: Attempt[];
}

export interface RetryState {
  active: boolean;
  action: 'launch' | 'start';
  opts: { region?: string; type?: string; idleMinutes?: number };
  every: number;
  started: number;
  until: number;
  next: number | null;
  tries: number;
  log: { at: number; ok: boolean; kind?: string; message: string; attempts?: Attempt[] }[];
  result: unknown;
  error: Failure | null;
  ended?: string;
}

export interface Resolved {
  prompt: string;
  negative: string;
  settings: Record<string, number | string | boolean>;
  size: number;
  fps: number;
  seconds: number;
  frames?: number | null;
}

export interface GpuJob {
  id: string;
  type: 'side' | 'i2v' | 'animate';
  fighter: string;
  clip?: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  detail: string;
  log: string[];
  created: number;
  started?: number;
  finished?: number;
  outputs?: string[];
  graphs?: string[];
  seeds?: number[];
  seed?: number;
  takes?: number;
  use?: 'auto' | 'replace' | 'pick';
  gpuSeconds?: number;
  cost?: number;
  prompt?: string;
  negative?: string;
  settings?: Record<string, unknown>;
  resolved?: Resolved;
  frames?: number;
}

export interface GpuState {
  account: { account?: string; arn?: string; region?: string; quotas?: Record<string, number | string>; error?: string } | null;
  server: GpuServer;
  regions: RegionInfo[];
  retry: RetryState | null;
  lastFailure: Failure | null;
  jobs: GpuJob[];
  motions: { clip: string; size: number; mtime: number }[];
  motionsDir: string;
}

export type JobSpec = {
  type: GpuJob['type'];
  fighter: string;
  clip?: string;
  prompt?: string;
  negative?: string;
  settings?: Record<string, unknown>;
  seed?: number;
  takes?: number;
  use?: GpuJob['use'];
  seconds?: number;
};

export type LaunchOptions = { region: string; type: string; idleMinutes: number; keepTrying?: { minutes: number; every?: number } };

/** Thrown for launch and start failures, with what kind of problem it was. */
export class GpuFailure extends Error {
  failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.failure = failure;
  }
}

async function post<T>(route: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/dev${route}`, { method: 'POST', body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 409 && data.kind) throw new GpuFailure({ message: data.error, kind: data.kind, attempts: data.attempts ?? [] });
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export const gpu = {
  state: () => api.get<GpuState>('/gpu'),
  launch: (o: LaunchOptions) => post<{ ok: true }>('/gpu/launch', { confirm: true, ...o }),
  start: (keepTrying?: LaunchOptions['keepTrying']) => post<{ ok: true }>('/gpu/start', { confirm: true, keepTrying }),
  act: (action: 'stop' | 'terminate' | 'access') => post<{ ok: true }>(`/gpu/${action}`, action === 'terminate' ? { confirm: true } : {}),
  stopRetry: () => post('/gpu/retry/stop', {}),
  refreshRegions: () => post<{ regions: RegionInfo[] }>('/gpu/regions/refresh', {}),
  quota: (region: string, value: number) => post<{ ok: true; status: string }>('/gpu/quota', { region, value }),
  /** extra: unsaved AI Settings edits to preview with. */
  preview: (job: JobSpec, extra: { generation?: unknown; actions?: Record<string, string>; seconds?: Record<string, number> } = {}) => post<Resolved>('/gpu/preview', { job, ...extra }),
  queue: (jobs: JobSpec[]) => post<{ ok: true; added: string[] }>('/gpu/jobs', { jobs }),
  cancel: (id: string) => post('/gpu/jobs/cancel', { id }),
  clear: () => post('/gpu/jobs/clear', {}),
  rerun: (id: string, sameSeed = false) => post<{ ok: true }>('/gpu/jobs/rerun', { id, sameSeed }),
  graphUrl: (name: string) => `/api/dev/gpu/graph?name=${encodeURIComponent(name)}`,
  chooseSide: (fighter: string, file: string) => post('/gpu/side/choose', { fighter, file }),
  promote: (fighter: string, clip: string) => post('/gpu/motion/promote', { fighter, clip }),
  useTake: (fighter: string, clip: string, file: string) => post<{ ok: true; log: string[] }>('/gpu/take/use', { fighter, clip, file }),
  discardTake: (fighter: string, file: string) => post('/gpu/take/discard', { fighter, file }),
};

/** Whether the server can take jobs right now. */
export function ready(s: GpuServer | undefined): boolean {
  return !!s && s.exists && s.state === 'running' && s.boot?.stage === 'ready';
}

/** Non-human fighters: a human pose skeleton won't drive them, so they default to prompts. */
export const CREATURES = new Set(['chooser', 'evil-blue-bird', 'shutup-bot', 'spider-bot', 'yo-bot', 'yooba']);

/** The default way to make a clip: copy the motion library for people, a prompt otherwise. */
export function defaultMethod(fighter: string, clip: string, motions: GpuState['motions'], override?: string | null): 'animate' | 'i2v' {
  if (override === 'i2v') return 'i2v';
  const hasMotion = motions.some((m) => m.clip === clip);
  if (override === 'animate') return hasMotion ? 'animate' : 'i2v';
  if (CREATURES.has(fighter)) return 'i2v';
  return hasMotion ? 'animate' : 'i2v';
}

export const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

let cached: GpuState | null = null;
const listeners = new Set<(s: GpuState) => void>();
let timer = 0;

/** Polls the GPU state while anything is listening. */
export function watchGpu(fn: (s: GpuState) => void): () => void {
  listeners.add(fn);
  if (cached) fn(cached);
  if (!timer) {
    const tick = async () => {
      try {
        cached = await gpu.state();
        listeners.forEach((l) => l(cached!));
      } catch {
        // The dev server may be restarting; try again next tick.
      }
      // Faster while something is happening.
      const s = cached?.server;
      const busy = cached?.jobs.some((j) => j.status === 'running' || j.status === 'queued') || cached?.retry?.active || (s?.exists && s.boot?.stage !== 'ready' && s.state !== 'stopped');
      timer = window.setTimeout(tick, busy ? 4000 : 15000);
    };
    void tick();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };
}

export async function refreshGpu(): Promise<GpuState> {
  cached = await gpu.state();
  listeners.forEach((l) => l(cached!));
  return cached;
}

export function gpuSnapshot(): GpuState | null {
  return cached;
}
