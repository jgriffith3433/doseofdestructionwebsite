// Talks to the dev-server API in tools/devApi.mjs, and holds what every tab
// shares: the fighter list, the selected fighter, and the console.

import type { FighterEntry } from '../game/sim/fighterDefs.ts';
import type { Clip } from '../game/render/anims.ts';
import { h } from '../game/ui/dom.ts';

export interface Manifest {
  refHeight: number;
  idleScale?: number;
  version?: number;
  clips: Record<string, Clip>;
}

/** What made a generated file: saved beside it as .json. */
export interface Recipe {
  job: string;
  type: 'side' | 'i2v' | 'animate';
  seed: number;
  prompt: string;
  negative: string;
  settings: Record<string, number | string | boolean>;
  size: number;
  fps: number;
  frames?: number;
  created: number;
}

export interface FighterState {
  id: string;
  folder: string | null;
  sources: { file: string; size: number; mtime: number }[];
  clipSources: Record<string, { file: string; size: number; mtime: number }>;
  clipOptions: Record<string, ClipOptions>;
  /** Generated side views: candidates, and the chosen one (_side.png). */
  sides: { file: string; chosen: boolean; size: number; mtime: number; recipe: Recipe | null }[];
  /** Generated clip takes waiting in anims/_takes/, newest last. */
  takes: { clip: string; seed: number; file: string; size: number; mtime: number; recipe: Recipe | null }[];
  manifest: Manifest | null;
  art: { img: number; thumb: boolean; large: boolean };
}

export interface ClipOptions {
  start?: number;
  end?: number;
  flip?: boolean;
  fps?: number;
  normalize?: boolean;
  tolerance?: number;
}

export interface DevState {
  artRoot: string;
  artRootExists: boolean;
  elevenLabs: boolean;
  running: string | null;
  fighters: FighterState[];
}

export interface ClipList {
  loops: string[];
  once: string[];
  moves: string[];
  unstanding: string[];
  labels: Record<string, string>;
}

const API = '/api/dev';

async function check<T>(r: Response): Promise<T> {
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!r.ok) {
    const b = body as { error?: string; code?: string; retryAfter?: number } | null;
    throw new ApiError(b?.error ?? `${r.status} ${r.statusText}`, r.status, b?.code, b?.retryAfter);
  }
  return body as T;
}

/** A failed dev-server call. code is set by routes that know more, e.g. throttled, quota or auth. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const api = {
  state: () => fetch(`${API}/state`, { cache: 'no-store' }).then((r) => check<DevState>(r)),
  content: <T>(name: string) => fetch(`${API}/content/${name}`, { cache: 'no-store' }).then((r) => check<T>(r)),
  save: (name: string, data: unknown) =>
    fetch(`${API}/content/${name}`, { method: 'POST', body: JSON.stringify(data) }).then((r) => check<{ ok: true }>(r)),
  post: <T = { ok: true }>(route: string, body: unknown) =>
    fetch(`${API}${route}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => check<T>(r)),
  get: <T>(route: string) => fetch(`${API}${route}`, { cache: 'no-store' }).then((r) => check<T>(r)),
  upload: <T = { ok: true }>(route: string, file: Blob) => fetch(`${API}${route}`, { method: 'POST', body: file }).then((r) => check<T>(r)),
  sourceUrl: (fighter: string, file: string, mtime = 0) =>
    `${API}/source?fighter=${encodeURIComponent(fighter)}&file=${encodeURIComponent(file)}&v=${mtime}`,
};

// --------------------------------------------------------------- console

let consoleEl: HTMLElement | null = null;
let busyEl: HTMLElement | null = null;
const busyListeners = new Set<(task: string | null) => void>();
let running: string | null = null;

export function mountConsole(output: HTMLElement, busy: HTMLElement): void {
  consoleEl = output;
  busyEl = busy;
}

export function log(text: string, kind: 'info' | 'ok' | 'error' | 'out' = 'info'): void {
  if (!consoleEl) return;
  const line = h('span', { class: `log ${kind}` }, text.endsWith('\n') ? text : `${text}\n`);
  consoleEl.append(line);
  // Keep the console bounded.
  while (consoleEl.childNodes.length > 2000) consoleEl.firstChild?.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

export function onBusy(fn: (task: string | null) => void): void {
  busyListeners.add(fn);
}

export function isBusy(): boolean {
  return running !== null;
}

function setBusy(task: string | null): void {
  running = task;
  if (busyEl) {
    busyEl.hidden = !task;
    busyEl.textContent = task ? `Running ${task}…` : '';
  }
  busyListeners.forEach((fn) => fn(task));
}

/** Runs a project script on the dev server, streaming its output to the console. Resolves to the exit code. */
export async function runTask(task: string, opts: { fighter?: string; clip?: string; mode?: string; file?: string } = {}, label = task): Promise<number> {
  if (running) {
    log(`Wait for ${running} to finish first.`, 'error');
    return -1;
  }
  setBusy(label);
  log(`\n▶ ${label}`, 'info');
  try {
    const r = await fetch(`${API}/run`, { method: 'POST', body: JSON.stringify({ task, ...opts }) });
    if (!r.ok || !r.body) {
      const err = await check<{ error: string }>(r).catch((e: Error) => ({ error: e.message }));
      log(err.error ?? `${r.status}`, 'error');
      return -1;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let code = -1;
    let tail = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      tail = (tail + text).slice(-200);
      log(text, 'out');
    }
    const m = /\[exit (-?\d+)\]\s*$/.exec(tail);
    if (m) code = Number(m[1]);
    log(code === 0 ? `✔ ${label} finished` : `✖ ${label} failed (exit ${code})`, code === 0 ? 'ok' : 'error');
    return code;
  } catch (e) {
    log((e as Error).message, 'error');
    return -1;
  } finally {
    setBusy(null);
  }
}

// ----------------------------------------------------------------- store

type Listener = () => void;

/** Everything the tabs share. Tabs re-render from it when it changes. */
export const store = {
  state: null as DevState | null,
  fighters: [] as FighterEntry[],
  clips: null as ClipList | null,
  selected: '',
  listeners: new Set<Listener>(),

  async refresh(): Promise<void> {
    const [state, fighters, clips] = await Promise.all([api.state(), api.content<FighterEntry[]>('fighters'), api.content<ClipList>('anim-clips')]);
    this.state = state;
    this.fighters = fighters;
    this.clips = clips;
    if (!this.selected || !fighters.some((f) => f.id === this.selected)) this.selected = fighters[0]?.id ?? '';
    this.emit();
  },

  fighterState(id?: string): FighterState | undefined {
    const key = id ?? store.selected;
    return store.state?.fighters.find((f) => f.id === key);
  },

  entry(id?: string): FighterEntry | undefined {
    const key = id ?? store.selected;
    return store.fighters.find((f) => f.id === key);
  },

  select(id: string): void {
    this.selected = id;
    this.emit();
  },

  on(fn: Listener): void {
    this.listeners.add(fn);
  },

  emit(): void {
    this.listeners.forEach((fn) => fn());
  },
};

/** Asks for a file with a hidden input. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Makes an element accept dropped files. */
export function dropTarget(el: HTMLElement, onFile: (file: File) => void): void {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('dragover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

export function thumb(id: string, mtime = 0): string {
  return `/characters/thumb/${id}.webp?v=${mtime}`;
}
