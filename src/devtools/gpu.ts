// The GPU service's API, shared by the GPU, AI Settings, Clips, Animations and Fighters tabs.

import { api } from './api.ts';

export interface InstanceType {
  vcpus: number;
  memory: number;
  vram: number;
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
  opts: { region?: string; type?: string; idleMinutes?: number; fallbackLaunch?: boolean };
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
  type: 'side' | 'pose' | 'i2v' | 'animate' | 'paint';
  /** Pose jobs: which pose. */
  pose?: string;
  fighter: string;
  clip?: string;
  /** Paint jobs: the stage and the piece of it. */
  stage?: string;
  piece?: string;
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
  /** The server it ran on. */
  server?: string;
  serverRegion?: string;
}

/** How many servers to use (devtools GPU tab, Scaling), saved in .cache/gpu/fleet.json. */
export interface FleetSettings {
  servers: number;
  /** Start stopped servers by themselves when jobs wait. */
  auto: boolean;
  /** Minutes idle before a server stops itself (running ones pick it up). */
  idleMinutes: number;
  max: number;
}

export interface GpuState {
  account: { account?: string; arn?: string; region?: string; quotas?: Record<string, number | string>; error?: string } | null;
  /** The ready server if there is one (for "is the GPU ready?"); every server is in servers. */
  server: GpuServer;
  servers: GpuServer[];
  fleet: FleetSettings;
  regions: RegionInfo[];
  retry: RetryState | null;
  lastFailure: Failure | null;
  jobs: GpuJob[];
  motions: { clip: string; size: number; mtime: number }[];
  motionsDir: string;
}

export type JobSpec = {
  type: GpuJob['type'];
  fighter?: string;
  stage?: string;
  piece?: string;
  clip?: string;
  pose?: string;
  prompt?: string;
  negative?: string;
  settings?: Record<string, unknown>;
  seed?: number;
  takes?: number;
  use?: GpuJob['use'];
  seconds?: number;
  /** animate only: 'library' (default), 'own' (the fighter's upload), or a recipe's video path. */
  motion?: string;
};

export interface ClipPlan {
  clip: string;
  status: 'missing' | 'outdated' | 'current' | 'manual' | 'needs-poses';
  /** needs-poses: the poses the fighter is missing. */
  poses?: string[];
  why?: string;
  type?: 'i2v' | 'animate';
  motion?: string;
  /** The job's own prompt template, when the clip was made with one. */
  template?: string;
  was?: string;
  now?: string;
}

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
  start: (keepTrying?: LaunchOptions['keepTrying'], id?: string, fallbackLaunch = false) => post<{ ok: true }>('/gpu/start', { confirm: true, keepTrying, id, fallbackLaunch }),
  act: (action: 'stop' | 'terminate' | 'access', id?: string) => post<{ ok: true }>(`/gpu/${action}`, action === 'terminate' ? { confirm: true, id } : { id }),
  fleet: (patch: Partial<Pick<FleetSettings, 'servers' | 'auto' | 'idleMinutes'>>) => post<{ ok: true; fleet: FleetSettings }>('/gpu/fleet', patch),
  /** Starts stopped servers until count are running. */
  scale: (count: number) => post<{ ok: true; started: string[]; failed: { id: string; region: string; message: string }[]; running: number; short: number }>('/gpu/scale', { confirm: true, count }),
  stopAll: () => post<{ ok: true; stopped: string[] }>('/gpu/stop-all', {}),
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
  choosePose: (fighter: string, pose: string, file: string) => post('/gpu/pose/choose', { fighter, pose, file }),
  discardPose: (fighter: string, file: string) => post('/gpu/pose/discard', { fighter, file }),
  /** Mirrors a pose image left to right, or turns it 90° (file: relative to the fighter's art folder). */
  flipPose: (fighter: string, file: string, op: 'flip' | 'cw' | 'ccw' = 'flip') => post('/gpu/pose/flip', { fighter, file, op }),
  promote: (fighter: string, clip: string) => post('/gpu/motion/promote', { fighter, clip }),
  useTake: (fighter: string, clip: string, file: string) => post<{ ok: true; log: string[] }>('/gpu/take/use', { fighter, clip, file }),
  discardTake: (fighter: string, file: string) => post('/gpu/take/discard', { fighter, file }),
  /** Per clip: missing, outdated (AI Settings moved on since it was generated), current or manual. */
  clipPlan: (fighter: string) => api.get<{ fighter: string; clips: ClipPlan[] }>(`/gpu/clip-plan?fighter=${fighter}`),
  /** A fighter's own driving videos, by clip. */
  ownMotions: (fighter: string) => api.get<{ motions: { clip: string; file: string; mtime: number }[] }>(`/gpu/motion/own?fighter=${fighter}`),
  ownMotionUrl: (fighter: string, clip: string, mtime = 0) => `/api/dev/gpu/motion/own/file?fighter=${fighter}&clip=${clip}&v=${mtime}`,
  uploadMotion: (fighter: string, clip: string, file: File) => api.upload(`/gpu/motion/upload?fighter=${fighter}&clip=${clip}&name=${encodeURIComponent(file.name)}`, file),
};

/** Whether the server can take jobs right now. */
export function ready(s: GpuServer | undefined): boolean {
  return !!s && s.exists && s.state === 'running' && s.boot?.stage === 'ready';
}

/** Non-human fighters: a human pose skeleton won't drive them, so they default to prompts. */
export const CREATURES = new Set(['chooser', 'evil-blue-bird', 'shutup-bot', 'spider-bot', 'yo-bot', 'yooba']);

/**
 * The default way to make a clip: from a prompt, so every fighter moves their
 * own way. A driving video is opt-in: per clip in the clip editor, or for a
 * whole fighter ("Make clips by: copying the motion library" in AI Settings).
 */
export function defaultMethod(fighter: string, clip: string, motions: GpuState['motions'], override?: string | null): 'animate' | 'i2v' {
  if (override === 'animate' && !CREATURES.has(fighter)) return motions.some((m) => m.clip === clip) ? 'animate' : 'i2v';
  return 'i2v';
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
      const booting = (cached?.servers ?? []).some((s) => s.boot?.stage !== 'ready' && s.state !== 'stopped');
      const busy = cached?.jobs.some((j) => j.status === 'running' || j.status === 'queued') || cached?.retry?.active || booting;
      timer = window.setTimeout(tick, busy ? 8000 : 20000);
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
