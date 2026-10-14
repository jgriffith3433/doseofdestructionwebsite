// "Keep trying": repeats a launch or start that failed because AWS had no
// machines free (or quota was short), until it works, it fails some other
// way, or the time you allowed runs out. Started from devtools only.
//
// Its state is saved to .cache/gpu/retry.json, so a dev server restart
// (Vite restarts on config edits) picks it back up until its deadline,
// rather than silently dropping it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { launchServer, startServer } from './aws.mjs';

const RETRYABLE = new Set(['capacity', 'quota']);
const FILE = path.join(ROOT, '.cache', 'gpu', 'retry.json');

export class Retry {
  constructor({ onSuccess } = {}) {
    this.onSuccess = onSuccess;
    this.state = null;
    this.timer = null;
    this.suspended = false;
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (saved?.active && saved.until > Date.now()) {
        this.state = saved;
        saved.log.push({ at: Date.now(), ok: true, message: 'picked up again after a dev server restart' });
        // A short pause, so a try the old server had in flight can finish first.
        this.schedule(Math.max(5000, (saved.next ?? 0) - Date.now()));
      } else {
        this.state = saved?.active ? { ...saved, active: false, next: null, ended: 'timed out while the dev server was down' } : saved;
      }
    } catch {
      // Nothing saved.
    }
  }

  save() {
    if (this.suspended) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.state));
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.state.next = Date.now() + ms;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.save();
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
    this.save();
    void this.tick();
    return this.state;
  }

  stop(reason = 'stopped') {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.state?.active) {
      Object.assign(this.state, { active: false, next: null, ended: reason });
      this.save();
    }
  }

  /** The dev server is restarting: stop here without ending it, so the next server carries on. */
  suspend() {
    this.suspended = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    const s = this.state;
    if (!s?.active || this.suspended) return;
    s.tries++;
    const at = Date.now();
    try {
      const result = s.action === 'launch' ? await launchServer(s.opts) : await startServer();
      s.log.push({ at, ok: true, message: s.action === 'launch' ? `launched in ${result.region} ${result.zone}` : 'started' });
      Object.assign(s, { active: false, next: null, result, ended: 'done' });
      this.save();
      this.onSuccess?.(s);
      return;
    } catch (e) {
      if (this.suspended) return;
      const kind = e.kind ?? 'other';
      s.log.push({ at, ok: false, kind, message: e.message, attempts: e.attempts ?? [] });
      s.log = s.log.slice(-50);
      if (!RETRYABLE.has(kind)) {
        Object.assign(s, { active: false, next: null, error: { message: e.message, kind, attempts: e.attempts ?? [] }, ended: 'failed' });
        this.save();
        return;
      }
      if (Date.now() + s.every * 1000 > s.until) {
        Object.assign(s, { active: false, next: null, error: { message: `Gave up after ${s.tries} tries: ${e.message}`, kind, attempts: e.attempts ?? [] }, ended: 'timed out' });
        this.save();
        return;
      }
      this.schedule(s.every * 1000);
    }
  }
}
