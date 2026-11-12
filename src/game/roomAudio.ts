// Per-stage acoustics and the pan/KO maths for the mix (audio.ts plays them). Pure: no Web Audio here, so node can test it.
// The reverb impulse is generated from the room numbers in content/stages.json (`room`), never loaded from a file.

import { STAGES } from './sim/stage.ts';
import type { StageRoom } from './sim/stageMath.ts';

export type { StageRoom };

export const PAN_MAX = 0.8;
/** The wet share Low (phones) sends: half of High's. */
export const LOW_WET_SCALE = 0.5;
/** Low caps the impulse so the convolver stays light on a phone. */
export const LOW_MAX_SECONDS = 1.0;

export const DEFAULT_ROOM: StageRoom = { name: 'arena', seconds: 0.5, brightnessHz: 6000, wet: 0.15, preDelayMs: 15, density: 0.8, lowpassHz: 14000 };

export function roomOf(stageId: string | null | undefined): StageRoom {
  return STAGES.find((s) => s.id === stageId)?.room ?? DEFAULT_ROOM;
}

/** The wet share for a quality: High as authored (clamped to 10-25%), Low half. */
export function wetFor(room: StageRoom, low: boolean): number {
  const w = Math.min(0.25, Math.max(0.1, room.wet));
  return low ? w * LOW_WET_SCALE : w;
}

/** A page x (0 = left edge, 1 = right edge; beyond is off screen) to a stereo pan in -0.8 to 0.8. */
export function panFromScreen(x01: number): number {
  if (!Number.isFinite(x01)) return 0;
  return Math.max(-PAN_MAX, Math.min(PAN_MAX, (x01 * 2 - 1) * PAN_MAX));
}

/**
 * How a fighter knocked out of the blast zone sounds as they leave: `away` 0..1 from how far past the view they are
 * (an off-screen KO at the side is far; a top KO right over the screen is near). Returns the low-pass the sound sweeps
 * down to (Hz), the gain it falls to, and the seconds the fade takes.
 */
export function departing(offscreen: number): { cutoffHz: number; gain: number; seconds: number } {
  const away = Math.max(0, Math.min(1, offscreen));
  return { cutoffHz: 9000 - away * 8300, gain: 0.7 - away * 0.5, seconds: 0.9 + away * 0.8 };
}

/**
 * A stereo reverb impulse for a room, deterministic. A decaying noise tail (exp envelope: -60 dB at `seconds`) whose
 * brightness falls from bright to `brightnessHz`; low `density` thins the tail to separate slaps; a pre-delay first.
 */
export function makeImpulse(room: StageRoom, sampleRate: number, low = false): Float32Array[] {
  const seconds = Math.max(0.1, low ? Math.min(room.seconds, LOW_MAX_SECONDS) : room.seconds);
  const pre = Math.floor((room.preDelayMs / 1000) * sampleRate);
  const n = pre + Math.max(8, Math.floor(seconds * sampleRate));
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    let seed = 0x9e3779b9 ^ (room.name.length * 7919) ^ ((ch + 1) * 0x85ebca6b);
    for (const c of room.name) seed = (Math.imul(seed, 31) + c.charCodeAt(0)) | 0;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const buf = out[ch];
    const len = n - pre;
    let lp = 0;
    const hi = Math.min(0.95, (2 * Math.PI * 16000) / sampleRate);
    const lo = Math.min(0.95, (2 * Math.PI * Math.max(200, room.brightnessHz)) / sampleRate);
    for (let i = 0; i < len; i++) {
      const k = i / len;
      const env = Math.pow(10, (-3 * i) / (seconds * sampleRate)); // -60 dB at the end
      // Sparse rooms: most samples are silent, a few are slaps.
      const gate = room.density >= 1 || rnd() < 0.15 + 0.85 * room.density * room.density ? 1 : 0;
      const x = (rnd() * 2 - 1) * gate;
      const a = hi + (lo - hi) * Math.sqrt(k);
      lp += a * (x - lp);
      // A quick fade-in so the tail doesn't click.
      const fade = Math.min(1, i / 48);
      buf[pre + i] = lp * env * fade;
    }
  }
  // Normalise to equal energy so rooms differ by shape, not by level.
  let e = 0;
  for (const b of out) for (let i = 0; i < b.length; i++) e += b[i] * b[i];
  const g = e > 0 ? 1 / Math.sqrt(e / 2) * 0.35 : 1;
  for (const b of out) for (let i = 0; i < b.length; i++) b[i] *= g;
  return out;
}
