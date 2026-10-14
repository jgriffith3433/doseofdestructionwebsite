// GPU activity everywhere in devtools: a top-bar indicator (what's running,
// progress, time left; click for the GPU tab), the tab title, a toast and a
// desktop notification when a job finishes or fails. Jobs run on the dev
// server, so refreshing, switching tabs or playtesting doesn't stop them.

import { h, kids } from '../game/ui/dom.ts';
import { store } from './api.ts';
import { watchGpu, type GpuJob, type GpuState } from './gpu.ts';
import { toast } from './ui.ts';

/** Seconds one output usually takes, before there's history to go on. */
const TYPICAL: Record<GpuJob['type'], number> = { paint: 45, side: 30, i2v: 120, animate: 180 };

const active = (j: GpuJob) => j.status === 'queued' || j.status === 'running';

/** How many outputs a job makes. */
export function outputsOf(j: GpuJob): number {
  if (j.type === 'side') return Number((j.resolved?.settings as { count?: number } | undefined)?.count ?? (j.settings as { count?: number } | undefined)?.count ?? 4);
  return j.takes ?? 1;
}

/** Seconds per output for jobs like this one, from the ones that finished. */
function perOutput(j: GpuJob, all: GpuJob[]): number {
  const kind = j.type === 'paint' ? (j.piece === 'backdrop' ? 'backdrop' : 'piece') : j.type;
  const done = all.filter((x) => x.status === 'done' && x.type === j.type && x.gpuSeconds && x.outputs?.length && (j.type !== 'paint' || (x.piece === 'backdrop' ? 'backdrop' : 'piece') === kind));
  if (!done.length) return TYPICAL[j.type];
  const recent = done.slice(-5);
  return recent.reduce((n, x) => n + x.gpuSeconds! / x.outputs!.length, 0) / recent.length;
}

/** Where a job is: 0..1, seconds left, and words for it. */
export function progressOf(j: GpuJob, all: GpuJob[]): { fraction: number; left: number; label: string } {
  const total = outputsOf(j);
  const each = perOutput(j, all);
  if (j.status === 'queued') {
    // Everything ahead of it in the line, plus itself.
    const ahead = all.filter((x) => active(x) && x.created <= j.created && x.id !== j.id);
    const wait = ahead.reduce((n, x) => n + (x.status === 'running' ? progressOf(x, all).left : outputsOf(x) * perOutput(x, all)), 0);
    const place = ahead.length + 1;
    return { fraction: 0, left: wait + total * each, label: place > 1 ? `waiting, #${place} in line` : 'starting' };
  }
  if (j.status !== 'running') return { fraction: j.status === 'done' ? 1 : 0, left: 0, label: j.status };
  const done = j.outputs?.length ?? 0;
  const elapsed = j.started ? (Date.now() - j.started) / 1000 : 0;
  const fraction = Math.min(0.97, Math.max(done / total, elapsed / (each * total)));
  return { fraction, left: Math.max(5, each * total - elapsed), label: `${done} of ${total} done` };
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds / 5) * 5)}s`;
  return `${Math.round(seconds / 60)} min`;
}

export function jobName(j: GpuJob): string {
  if (j.type === 'paint') return `${j.piece} (${j.stage})`;
  const who = store.fighters.find((f) => f.id === j.fighter)?.name ?? j.fighter;
  return j.type === 'side' ? `${who} side views` : `${who} ${j.clip}`;
}

/** A thin progress bar. */
export function bar(fraction: number, cls = ''): HTMLElement {
  const fill = h('i', {});
  fill.style.width = `${Math.round(fraction * 100)}%`;
  return h('span', { class: `progress ${cls}` }, fill);
}

// ------------------------------------------------------------ top bar

let el: HTMLButtonElement;
let lastState: GpuState | null = null;
const baseTitle = document.title;

/** Asks once for desktop notifications (call from a click). */
export function askToNotify(): void {
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    // Not supported here.
  }
}

function notify(title: string, body: string): void {
  toast(`${title}: ${body}`);
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification(title, { body, tag: 'dod-gpu' });
  } catch {
    // Not supported here.
  }
}

function render(s: GpuState): void {
  const running = s.jobs.find((j) => j.status === 'running');
  const queued = s.jobs.filter((j) => j.status === 'queued');
  const server = s.server;
  let text = '';
  let fraction: number | null = null;
  let tone = '';
  if (running || queued.length) {
    const j = running ?? queued[0];
    const p = progressOf(j, s.jobs);
    const rest = queued.length - (running ? 0 : 1);
    text = running ? `${jobName(j)} · ${Math.round(p.fraction * 100)}% · ${duration(p.left)} left${rest > 0 ? ` · +${rest} queued` : ''}` : `${queued.length} queued · ${server.exists && server.boot?.stage === 'ready' ? 'starting' : 'waiting for the GPU'}`;
    fraction = running ? p.fraction : null;
    tone = 'busy';
  } else if (s.retry?.active) {
    text = 'Finding a GPU…';
    tone = 'busy';
  } else if (server.exists && server.state === 'running') {
    text = server.boot?.stage === 'ready' ? 'GPU ready' : `GPU setting up: ${server.boot?.detail ?? 'booting'}`;
    tone = server.boot?.stage === 'ready' ? 'ok' : 'busy';
  }
  el.hidden = !text;
  el.className = `activity ${tone}`;
  el.title = 'GPU jobs run on the dev server: you can refresh, switch tabs or playtest. Click for the GPU tab.';
  el.replaceChildren(...kids(h('span', { class: 'dot' }), h('span', { class: 'text' }, text), fraction !== null && bar(fraction)));
  const n = s.jobs.filter(active).length;
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
}

/** Puts the indicator in the top bar and starts watching. */
export function mountActivity(container: HTMLElement): void {
  el = h('button', { type: 'button', class: 'activity', hidden: true, onclick: () => { askToNotify(); location.hash = 'gpu'; } });
  container.append(el);
  watchGpu((s) => {
    const prev = lastState;
    lastState = s;
    if (prev) {
      for (const j of s.jobs) {
        const before = prev.jobs.find((x) => x.id === j.id);
        if (!before || before.status === j.status) continue;
        if (j.status === 'done') notify(`${jobName(j)} finished`, j.detail || 'Ready to look at.');
        else if (j.status === 'failed') notify(`${jobName(j)} failed`, j.detail || 'See the GPU tab.');
      }
      if (!prev.server.exists && s.server.exists) notify('GPU server launched', `In ${s.server.region}. Setup takes 10 to 25 minutes.`);
      if (prev.server.boot?.stage !== 'ready' && s.server.boot?.stage === 'ready') notify('GPU server ready', 'Queued jobs start now.');
      if (s.jobs.some((j) => j.status === 'done' && prev.jobs.find((x) => x.id === j.id)?.status !== 'done')) void store.refresh();
    }
    render(s);
  });
  // Progress moves between polls.
  setInterval(() => lastState && render(lastState), 1000);
}
