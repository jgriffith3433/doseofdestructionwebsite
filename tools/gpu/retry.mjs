// "Keep trying": repeats a launch or start that failed because AWS had no
// machines free (or quota was short), until it works, it fails some other
// way, or the time you allowed runs out. Started from devtools only; the
// dev server stopping ends it.

import { launchServer, startServer } from './aws.mjs';

const RETRYABLE = new Set(['capacity', 'quota']);

export class Retry {
  constructor({ onSuccess } = {}) {
    this.onSuccess = onSuccess;
    this.state = null;
    this.timer = null;
  }

  /** action: 'launch' | 'start'. opts go to launchServer. */
  start({ action, opts = {}, minutes = 60, every = 180 }) {
    this.stop();
    const now = Date.now();
    this.state = {
      active: true,
      action,
      opts,
      every: Math.max(60, Math.min(900, every)),
      started: now,
      until: now + Math.max(5, Math.min(12 * 60, minutes)) * 60 * 1000,
      next: now,
      tries: 0,
      log: [],
      result: null,
      error: null,
    };
    void this.tick();
    return this.state;
  }

  stop(reason = 'stopped') {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.state?.active) Object.assign(this.state, { active: false, next: null, ended: reason });
  }

  async tick() {
    const s = this.state;
    if (!s?.active) return;
    s.tries++;
    const at = Date.now();
    try {
      const result = s.action === 'launch' ? await launchServer(s.opts) : await startServer();
      s.log.push({ at, ok: true, message: s.action === 'launch' ? `launched in ${result.region} ${result.zone}` : 'started' });
      Object.assign(s, { active: false, next: null, result, ended: 'done' });
      this.onSuccess?.(s);
      return;
    } catch (e) {
      const kind = e.kind ?? 'other';
      s.log.push({ at, ok: false, kind, message: e.message, attempts: e.attempts ?? [] });
      s.log = s.log.slice(-50);
      if (!RETRYABLE.has(kind)) {
        Object.assign(s, { active: false, next: null, error: { message: e.message, kind, attempts: e.attempts ?? [] }, ended: 'failed' });
        return;
      }
      if (Date.now() + s.every * 1000 > s.until) {
        Object.assign(s, { active: false, next: null, error: { message: `Gave up after ${s.tries} tries: ${e.message}`, kind, attempts: e.attempts ?? [] }, ended: 'timed out' });
        return;
      }
      s.next = Date.now() + s.every * 1000;
      this.timer = setTimeout(() => void this.tick(), s.every * 1000);
    }
  }
}
