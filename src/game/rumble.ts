/**
 * Rumble: what a hit feels like in the hands. The same weight tiers as hitFeel.ts (light, medium, heavy) plus the
 * KO, sent to the local player's pad (dual-rumble through the Gamepad's vibrationActuator) and to a phone
 * (navigator.vibrate). One Settings switch, Rumble, covers both: it is the saved `vibrate` flag of dod.touch
 * (touchSettings.ts), so a phone player's old Vibrate choice carries over. Off sends nothing at all.
 * Calm limits: with the system's reduced motion on, every pulse is short and soft (CALM_*), never a jolt.
 */

import { hitTier, type HitTier } from './hitFeel.ts';
import { touchSettings } from './touchSettings.ts';
import { pads } from './input/devices.ts';

export type RumbleKind = HitTier | 'ko';

export interface Rumble {
  /** Length in ms, the big (low-frequency) and small (high-frequency) motor strengths 0-1. */
  ms: number;
  strong: number;
  weak: number;
}

/** Light is a short buzz, medium a thump, heavy a hard jolt, a KO the longest and strongest. */
export const RUMBLE: Record<RumbleKind, Rumble> = {
  light: { ms: 40, strong: 0.1, weak: 0.4 },
  medium: { ms: 80, strong: 0.4, weak: 0.5 },
  heavy: { ms: 150, strong: 0.8, weak: 0.7 },
  ko: { ms: 340, strong: 1, weak: 0.9 },
};

/** Calm mode's ceiling: at most this long and this strong, scaled so the tiers still differ. */
export const CALM_MAX_MS = 60;
export const CALM_MAX_STRENGTH = 0.35;

export const rumbleFor = (kind: RumbleKind, calm: boolean): Rumble => {
  const r = RUMBLE[kind];
  if (!calm) return { ...r };
  const k = CALM_MAX_STRENGTH;
  const ms = Math.min(CALM_MAX_MS, Math.round(r.ms * 0.4));
  return { ms: Math.max(20, ms), strong: Number((r.strong * k).toFixed(3)), weak: Number((r.weak * k).toFixed(3)) };
};

export interface RumbleSent extends Rumble {
  kind: RumbleKind;
  calm: boolean;
  /** Whether a pad's actuator took it, and whether the phone's vibrator was asked. */
  pad: boolean;
  phone: boolean;
}

/** The rumbles sent (and the count of ones skipped because Rumble is off), for the playtest and the console. */
export const rumbleLog: RumbleSent[] = [];
export const rumbleStats = { suppressed: 0 };

export const rumbleOn = (): boolean => touchSettings().vibrate;

const calmNow = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Actuator = { playEffect?: (type: string, p: { startDelay: number; duration: number; weakMagnitude: number; strongMagnitude: number }) => Promise<unknown> };

/** Rumble the local player's pad and phone for a hit of this weight. Does nothing at all while Rumble is off. */
export const rumble = (kind: RumbleKind): RumbleSent | null => {
  if (!rumbleOn()) {
    rumbleStats.suppressed++;
    return null;
  }
  const calm = calmNow();
  const r = rumbleFor(kind, calm);
  let pad = false;
  let phone = false;
  try {
    const act = (pads()[0] as (Gamepad & { vibrationActuator?: Actuator | null }) | undefined)?.vibrationActuator;
    if (act?.playEffect) {
      void act.playEffect('dual-rumble', { startDelay: 0, duration: r.ms, weakMagnitude: r.weak, strongMagnitude: r.strong }).catch(() => {});
      pad = true;
    }
  } catch {
    // An actuator that refuses is not an error for the fight.
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(r.ms);
      phone = true;
    }
  } catch {
    // Unsupported or blocked: ignore.
  }
  const sent: RumbleSent = { ...r, kind, calm, pad, phone };
  rumbleLog.push(sent);
  if (rumbleLog.length > 200) rumbleLog.shift();
  try {
    window.dispatchEvent(new CustomEvent('dod:rumble', { detail: sent }));
  } catch {
    // No window (tests).
  }
  return sent;
};

/** The rumble for a landed or taken hit of `dmg` tenths of a percent. */
export const rumbleHit = (dmg: number): RumbleSent | null => rumble(hitTier(dmg));
