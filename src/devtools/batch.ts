// Runs a long list of ElevenLabs generations (sounds, voice lines) without
// babysitting: a few at a time, waiting out throttling and retrying, skipping
// lines that fail for their own reasons, and stopping on things that won't
// fix themselves (out of credits, bad key). One batch at a time, shown in a
// panel in the corner with a Stop button.

import { h } from '../game/ui/dom.ts';
import { ApiError, log } from './api.ts';
import { toast } from './ui.ts';

export interface BatchJob<T> {
  label: string;
  items: T[];
  name: (item: T) => string;
  /** Generates one item. Throws on failure. */
  run: (item: T) => Promise<void>;
  /** Called after every finished item, e.g. to re-render the table. */
  progress?: () => void;
}

export interface BatchResult {
  done: number;
  failed: { name: string; error: string }[];
  stopped: string | null;
}

const LIMIT_KEY = 'dod-eleven-concurrency';
/** Consecutive throttles before giving up on the batch. */
const MAX_THROTTLES = 12;

let current: { stop: (why: string) => void } | null = null;

export const batchRunning = (): boolean => current !== null;

function savedLimit(): number {
  try {
    const n = Number(localStorage.getItem(LIMIT_KEY));
    return n >= 1 && n <= 10 ? n : 2;
  } catch {
    return 2;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function kind(e: unknown): 'throttled' | 'fatal' | 'failed' {
  if (!(e instanceof ApiError)) return e instanceof TypeError ? 'throttled' : 'failed'; // TypeError: fetch itself failed
  if (e.code === 'throttled' || e.status === 429 || e.status === 503) return 'throttled';
  if (e.code === 'quota' || e.code === 'auth') return 'fatal';
  return 'failed';
}

export async function runBatch<T>(job: BatchJob<T>): Promise<BatchResult> {
  if (current) {
    toast('Another batch is still running.', 'error');
    return { done: 0, failed: [], stopped: 'busy' };
  }
  const queue = job.items.slice();
  const total = queue.length;
  const result: BatchResult = { done: 0, failed: [], stopped: null };
  let limit = savedLimit();
  let active = 0;
  let pausedUntil = 0;
  let throttles = 0;
  let note = '';

  // ----------------------------------------------------------- panel
  const bar = h('div', { class: 'batch-fill' });
  const counts = h('div', { class: 'batch-counts' });
  const status = h('div', { class: 'batch-note muted' });
  const limitInput = h('input', { type: 'number', min: 1, max: 10, value: limit, class: 'input', title: 'Generations at once. ElevenLabs allows 2–15 depending on your plan.' });
  limitInput.addEventListener('change', () => {
    limit = Math.max(1, Math.min(10, Math.round(Number(limitInput.value)) || 1));
    limitInput.value = String(limit);
    try {
      localStorage.setItem(LIMIT_KEY, String(limit));
    } catch {
      /* fine */
    }
    paint();
  });
  const stopBtn = h('button', { type: 'button', class: 'btn small danger', onclick: () => stop('you stopped it') }, 'Stop');
  const panel = h(
    'div',
    { class: 'batch' },
    h('div', { class: 'row' }, h('strong', {}, job.label), h('span', { class: 'spacer' }), h('label', { class: 'muted' }, 'At once ', limitInput), stopBtn),
    h('div', { class: 'batch-track' }, bar),
    counts,
    status,
  );
  document.body.append(panel);

  function paint(): void {
    const finished = result.done + result.failed.length;
    bar.style.width = `${total ? (finished / total) * 100 : 100}%`;
    counts.textContent = `${result.done} of ${total} done${result.failed.length ? ` · ${result.failed.length} failed` : ''}${queue.length ? ` · ${queue.length} to go` : ''}`;
    const wait = Math.ceil((pausedUntil - Date.now()) / 1000);
    status.textContent = result.stopped ? `Stopped: ${result.stopped}` : wait > 0 ? `Throttled by ElevenLabs, waiting ${wait}s (now ${limit} at once)…` : note;
  }
  const ticker = setInterval(paint, 500);

  function stop(why: string): void {
    if (result.stopped) return;
    result.stopped = why;
    queue.length = 0;
    paint();
  }
  const unload = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener('beforeunload', unload);
  current = { stop };

  // ----------------------------------------------------------- work
  async function worker(): Promise<void> {
    for (;;) {
      if (result.stopped || !queue.length) return;
      if (active >= limit || Date.now() < pausedUntil) {
        await sleep(250);
        continue;
      }
      const item = queue.shift() as T;
      const name = job.name(item);
      active++;
      note = `Generating ${name}…`;
      try {
        await job.run(item);
        result.done++;
        throttles = 0;
      } catch (e) {
        const k = kind(e);
        const msg = (e as Error).message;
        if (k === 'throttled' && !result.stopped) {
          throttles++;
          queue.unshift(item);
          // Back off harder the longer it keeps happening, and ask for less at once.
          const wait = Math.min(120, Math.max((e as ApiError).retryAfter ?? 0, 5 * 2 ** Math.min(throttles - 1, 4)));
          pausedUntil = Math.max(pausedUntil, Date.now() + wait * 1000);
          if (limit > 1) limit--;
          log(`  throttled on ${name}, waiting ${wait}s then trying again with ${limit} at once`, 'error');
          if (throttles >= MAX_THROTTLES) stop(`ElevenLabs kept throttling (${msg})`);
        } else if (k === 'fatal') {
          result.failed.push({ name, error: msg });
          log(`  ${name}: ${msg}`, 'error');
          stop(msg);
        } else {
          result.failed.push({ name, error: msg });
          log(`  ${name} failed: ${msg}`, 'error');
        }
      } finally {
        active--;
        paint();
        job.progress?.();
      }
    }
  }

  log(`\n▶ ${job.label}: ${total} to generate`);
  paint();
  await Promise.all(Array.from({ length: 10 }, worker));

  // ----------------------------------------------------------- done
  clearInterval(ticker);
  window.removeEventListener('beforeunload', unload);
  current = null;
  const summary = `${job.label}: ${result.done} of ${total} done${result.failed.length ? `, ${result.failed.length} failed` : ''}${result.stopped ? ` (stopped: ${result.stopped})` : ''}`;
  log(summary, result.failed.length || result.stopped ? 'error' : 'ok');
  for (const f of result.failed) log(`  ✖ ${f.name}: ${f.error}`, 'error');
  stopBtn.remove();
  limitInput.closest('label')?.remove();
  note = result.failed.length ? `Failed: ${result.failed.slice(0, 3).map((f) => f.name).join(', ')}${result.failed.length > 3 ? '…' : ''}. Run it again to retry them.` : 'Finished.';
  paint();
  panel.querySelector('.row')?.append(h('button', { type: 'button', class: 'btn small', onclick: () => panel.remove() }, 'Close'));
  if (!result.failed.length && !result.stopped) setTimeout(() => panel.remove(), 6000);
  return result;
}
