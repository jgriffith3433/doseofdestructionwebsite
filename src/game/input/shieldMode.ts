/**
 * Shield: Hold (default) / Toggle (Settings → Shield, an assist for players who can't keep a button down).
 *
 * In Toggle one press of Shield raises the shield and it stays up with nothing held. The next Shield press, or a
 * jump, grab (Attack), roll (stick sideways) or spot-dodge (stick down), drops it. It works on keyboard, pad and
 * touch alike because it sits where those merge, `readLocal()`: the sim only ever sees an ordinary held SHIELD bit,
 * so online packets, rollback and replays carry exactly what the fighter did and nothing else changes.
 *
 * `latchShield` is pure (state + this frame's raw input in, the bits for the sim out). The one outside hint is
 * whether the fighter really is shielding (`setShieldActive`, from the match): a hit, a break, a KO or a press in the
 * air that never raised a shield lets go of the latch so it can't stay "on" with no shield.
 * Saved in localStorage "dod.shield" ("hold" | "toggle").
 */

import { BTN } from '../sim/input.ts';

export type ShieldMode = 'hold' | 'toggle';

export interface LatchState {
  /** The shield is latched up. */
  on: boolean;
  /** The Shield bit the player's hands had last frame. */
  rawShield: boolean;
  /** The press that dropped the latch is still down: keep it masked until let go. */
  masked: boolean;
  /** Raw bits and stick directions last frame, for edges. */
  prevButtons: number;
  prevSx: number;
  prevSy: number;
  /** Frames the latch has been up without the fighter shielding. */
  idle: number;
  /** A jump / grab / dodge fired this frame: the latch ends after it. */
  dropAfter: boolean;
}

export const newLatch = (): LatchState => ({ on: false, rawShield: false, masked: false, prevButtons: 0, prevSx: 0, prevSy: 0, idle: 0, dropAfter: false });

/** Frames the latch waits for the sim to enter Shield before it lets go (covers the buffer and one hit-stop). */
export const LATCH_GRACE = 12;

const sideways = (v: number): number => (Math.abs(v) > 60 ? Math.sign(v) : 0);

/**
 * One frame. `buttons` is the merged raw button bits, `sx`/`sy` the stick. Returns the button bits to give the sim.
 * `shielding`: the fighter is in Shield (or its stun) now.
 */
export function latchShield(s: LatchState, buttons: number, sx: number, sy: number, shielding: boolean): number {
  const raw = (buttons & BTN.SHIELD) !== 0;
  const pressed = raw && !s.rawShield;
  const edges = buttons & ~s.prevButtons;
  const rolled = sideways(sx) !== 0 && sideways(sx) !== sideways(s.prevSx);
  const spot = sy < -60 && s.prevSy >= -60;
  s.rawShield = raw;
  s.prevButtons = buttons;
  s.prevSx = sx;
  s.prevSy = sy;
  if (!raw) s.masked = false;

  // The move that ended the latch last frame has been seen by the sim: now the shield can go.
  if (s.dropAfter) {
    s.dropAfter = false;
    s.on = false;
    s.masked = raw;
  }

  if (s.on) {
    s.idle = shielding ? 0 : s.idle + 1;
    if (s.idle > LATCH_GRACE) {
      s.on = false;
      s.masked = raw;
    } else if (pressed) {
      // The second press puts it down at once.
      s.on = false;
      s.masked = true;
    } else if (edges & (BTN.JUMP | BTN.ATTACK) || rolled || spot) {
      // Jump, grab, roll, spot-dodge: the sim does it from Shield this frame, the latch lets go after.
      s.dropAfter = true;
    }
  } else if (pressed && !s.masked) {
    s.on = true;
    s.idle = 0;
  }

  let out = buttons & ~BTN.SHIELD;
  if (s.on) out |= BTN.SHIELD;
  return out;
}

const KEY = 'dod.shield';
export const SHIELD_KEY_NAME = KEY;

const read = (): ShieldMode => {
  try {
    return localStorage.getItem(KEY) === 'toggle' ? 'toggle' : 'hold';
  } catch {
    return 'hold';
  }
};

let current: ShieldMode = read();
const state = newLatch();
let shieldingNow = false;
const modeListeners = new Set<(m: ShieldMode) => void>();
const latchListeners = new Set<(on: boolean) => void>();
let announced = false;

export const shieldMode = (): ShieldMode => current;

export const setShieldMode = (mode: ShieldMode): void => {
  current = mode;
  releaseShieldLatch();
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of modeListeners) l(mode);
};

export const onShieldMode = (l: (m: ShieldMode) => void): (() => boolean) => {
  modeListeners.add(l);
  return () => modeListeners.delete(l);
};

/** Fires when the latch goes up or down (the touch Shield button shows it). */
export const onShieldLatch = (l: (on: boolean) => void): (() => boolean) => {
  latchListeners.add(l);
  return () => latchListeners.delete(l);
};

export const shieldLatched = (): boolean => state.on;

/** Whether the local fighter is in Shield right now (set after each sim tick). */
export const setShieldActive = (on: boolean): void => {
  shieldingNow = on;
};

/** Drop the latch (a new match, leaving a match, switching mode). */
export function releaseShieldLatch(): void {
  Object.assign(state, newLatch());
  announce();
}

function announce(): void {
  if (announced === state.on) return;
  announced = state.on;
  for (const l of latchListeners) l(state.on);
}

/** The local player's buttons for this frame, with Toggle applied. Called once per tick by readLocal. */
export function applyShieldMode(buttons: number, sx: number, sy: number): number {
  if (current === 'hold') {
    if (state.on || state.masked) releaseShieldLatch();
    return buttons;
  }
  const out = latchShield(state, buttons, sx, sy, shieldingNow);
  announce();
  return out;
}
