// "Keep trying": repeats a launch or start that failed because AWS had no
// machines free (or quota was short), until it works, it fails some other
// way, or the time you allowed runs out. Started from devtools only.
//
// A start tries every stopped server, not just one: each can only start in its
// own zone, so a fleet spread over regions has better odds. With fallbackLaunch
// on, once no stopped server could start twice in a row, it launches a fresh
// server wherever machines are free (any 48 GB+ type: L40S or Blackwell).
//
// Its state is saved to .cache/gpu/retry.json, so a dev server restart
// (Vite restarts on config edits) picks it back up until its deadline,
// rather than silently dropping it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { fleetStatus, launchServer, startServer, GpuError } from './aws.mjs';
import { loadFleet } from './fleet.mjs';

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

  /** Starts any stopped server (else, with fallbackLaunch, launches a new one). */
  async startAny(s) {
    const all = await fleetStatus();
    const up = all.find((st) => ['running', 'pending'].includes(st.state));
    if (up) return { id: up.id, region: up.region };
    const attempts = [];
    let last = null;
    for (const st of all.filter((x) => x.state === 'stopped')) {
      try {
        return await startServer(st.id);
      } catch (e) {
        last = e;
        attempts.push(...(e.attempts?.length ? e.attempts : [{ region: st.region, zone: st.zone, code: e.name, kind: e.kind ?? 'other', message: e.message }]));
        if (!['capacity', 'quota'].includes(e.kind)) throw e;
      }
    }
    // Twice in a row nothing could start: launch where machines are free, if allowed.
    s.misses = (s.misses ?? 0) + 1;
    if (s.opts.fallbackLaunch && (s.misses >= 2 || !all.length)) {
      const r = await launchServer({ idleMinutes: s.opts.idleMinutes ?? loadFleet().idleMinutes, region: 'auto', type: 'auto', max: loadFleet().servers }).catch((e) => {
        throw new GpuError(`No stopped server could start, and a new one couldn't launch either: ${e.message}`, e.kind ?? 'capacity', [...attempts, ...(e.attempts ?? [])]);
      });
      return { ...r, launched: true };
    }
    if (!all.length) throw new GpuError('There is no GPU server to start.');
    const where = [...new Set(attempts.map((a) => `${a.region}${a.zone ? ` ${a.zone}` : ''}`))].join(', ');
    throw new GpuError(`No stopped server could start: AWS has no machines free in ${where}.${s.opts.fallbackLaunch ? ' Next round launches a new one where machines are free.' : ''}`, last?.kind ?? 'capacity', attempts);
  }

  async tick() {
    const s = this.state;
    if (!s?.active || this.suspended) return;
    s.tries++;
    const at = Date.now();
    try {
      const result = s.action === 'launch' ? await launchServer({ ...s.opts, max: loadFleet().servers }) : await this.startAny(s);
      s.log.push({ at, ok: true, message: result.launched || s.action === 'launch' ? `launched in ${result.region} ${result.zone ?? ''}` : `started ${result.id} in ${result.region}` });
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
