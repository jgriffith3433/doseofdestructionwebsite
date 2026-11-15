/**
 * How heavy a hit feels. The sim freezes both fighters for `lag` frames (hit-stop, step.ts applyHit, scaled to
 * damage); this decides the rest from the same damage: the impact effect and the camera shake. The one player
 * choice, Screen shake on or off, is saved in localStorage "dod.shake" and read live by the renderer.
 */

import { idiv, isqrt } from './sim/fixed.ts';

export type HitTier = 'light' | 'medium' | 'heavy';

/** Damage is in tenths of a percent (the same cut-offs pick hit-light / hit-medium / hit-heavy in main.ts). */
export const hitTier = (dmg: number): HitTier => (dmg < 70 ? 'light' : dmg < 130 ? 'medium' : 'heavy');

export interface Impact {
  /** Sparks thrown. */
  sparks: number;
  /** Star-shaped impact sprites, 0 for a light hit. */
  stars: number;
  /** A shockwave ring (heavy only). */
  ring: boolean;
  /** Camera shake added (0-1 scale of the renderer). */
  shake: number;
  /** A white screen flash (heavy only). */
  flash: number;
}

/** A notch more level on the biggest hits (damage in tenths of a percent): 1 up to a smash's 130, then up to 1.2 for a heavy's. */
export const hitGain = (dmg: number): number => (dmg <= 130 ? 1 : 1 + Math.min(0.2, (dmg - 130) / 400));

export const impactFor = (tier: HitTier, kb: number): Impact => {
  const push = Math.min(16, kb >> 3);
  if (tier === 'light') return { sparks: 5 + (push >> 3), stars: 0, ring: false, shake: Math.min(0.12, kb * 0.001), flash: 0 };
  if (tier === 'medium') return { sparks: 8 + (push >> 2), stars: 1, ring: false, shake: Math.min(0.3, 0.1 + kb * 0.002), flash: 0 };
  return { sparks: 12 + (push >> 1), stars: 2, ring: true, shake: Math.min(0.85, 0.35 + kb * 0.003), flash: 0.18 };
};

// ------------------------------------------------------------------ motion comfort
//
// Three player choices, read live by the renderer and the post chain (so every path honours them, not just the UI):
//  - Reduce motion (`dod.motion` on/off, default from the OS's prefers-reduced-motion): no KO slow-mo, no KO punch-in zoom,
//    and it sets the defaults of the other two.
//  - Screen shake 0-100% (`dod.shake`, a number; the old "on"/"off" still reads): scales every camera shake, 0 removes it.
//  - Flashes Full / Soft / Off (`dod.flash`): scales the full-screen flashes and the post chain's exposure punch.
// Whatever the choice, `FlashGate` allows at most 3 big flashes in any second (the photosensitivity guideline).

export type FlashMode = 'full' | 'soft' | 'off';

const SHAKE_KEY = 'dod.shake';
const FLASH_KEY = 'dod.flash';
const MOTION_KEY = 'dod.motion';

const store = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
};

const osReduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let motionChoice: boolean | null = ((): boolean | null => {
  const v = store(MOTION_KEY);
  return v === 'on' ? true : v === 'off' ? false : null;
})();
let shakeChoice: number | null = ((): number | null => {
  const v = store(SHAKE_KEY);
  if (v === 'off') return 0;
  if (v === 'on') return 100;
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
})();
let flashChoice: FlashMode | null = ((): FlashMode | null => {
  const v = store(FLASH_KEY);
  return v === 'full' || v === 'soft' || v === 'off' ? v : null;
})();
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const l of listeners) l();
};

/** Reduce motion: the player's choice, else the OS setting. */
export const reduceMotion = (): boolean => motionChoice ?? osReduced();
/** Screen shake 0-100: the player's choice, else 0 under Reduce motion and 100 without. */
export const shakeLevel = (): number => shakeChoice ?? (reduceMotion() ? 0 : 100);
/** Flashes: the player's choice, else Off under Reduce motion and Full without. */
export const flashMode = (): FlashMode => flashChoice ?? (reduceMotion() ? 'off' : 'full');

/** Camera shake is on at all (any level above 0). */
export const screenShake = (): boolean => shakeLevel() > 0;
/** The factor every shake is multiplied by (0-1). */
export const shakeScale = (): number => shakeLevel() / 100;
/** The factor every full-screen flash's strength is multiplied by: Full 1, Soft 0.35, Off 0. */
export const flashScale = (): number => (flashMode() === 'full' ? 1 : flashMode() === 'soft' ? 0.35 : 0);

export const setReduceMotion = (on: boolean): void => {
  motionChoice = on;
  put(MOTION_KEY, on ? 'on' : 'off');
  changed();
};
export const setShakeLevel = (n: number): void => {
  shakeChoice = Math.max(0, Math.min(100, Math.round(n)));
  put(SHAKE_KEY, String(shakeChoice));
  changed();
};
export const setFlashMode = (m: FlashMode): void => {
  flashChoice = m;
  put(FLASH_KEY, m);
  changed();
};
/** Kept for callers that only flip shake on and off. */
export const setScreenShake = (on: boolean): void => setShakeLevel(on ? 100 : 0);

export const onScreenShake = (l: () => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const onMotionSettings = onScreenShake;

export const SHAKE_STORAGE_KEY = SHAKE_KEY;
export const FLASH_STORAGE_KEY = FLASH_KEY;
export const MOTION_STORAGE_KEY = MOTION_KEY;

/**
 * Photosensitivity gate: a big full-screen flash (or the post chain's exposure punch) starts only when fewer than
 * `MAX_FLASHES` have started in the last second. Calls within `MERGE_MS` of the last accepted start are the same flash
 * (a heavy hit's flash and its exposure punch), so they pass without using another slot.
 */
export const MAX_FLASHES_PER_SECOND = 3;
const MERGE_MS = 160;
const flashStarts: number[] = [];
let lastStart = -1e9;
let flashLog = { accepted: 0, refused: 0, maxPerSecond: 0 };

/** Asks to start a flash at `now` (ms). False when the mode is Off or the second is full. */
export const flashAllowed = (now: number): boolean => {
  if (flashScale() === 0) return false;
  if (now - lastStart >= 0 && now - lastStart < MERGE_MS) return true;
  while (flashStarts.length && now - flashStarts[0] >= 1000) flashStarts.shift();
  if (flashStarts.length >= MAX_FLASHES_PER_SECOND) {
    flashLog.refused++;
    return false;
  }
  flashStarts.push(now);
  lastStart = now;
  flashLog.accepted++;
  flashLog.maxPerSecond = Math.max(flashLog.maxPerSecond, flashStarts.length);
  return true;
};
export const flashStats = (reset = false) => {
  const out = { ...flashLog };
  if (reset) flashLog = { accepted: 0, refused: 0, maxPerSecond: 0 };
  return out;
};

// ------------------------------------------------------------------ damage numbers

/** The colour stops of the HUD damage number, by percent in tenths: white at 0, orange by 60%, red by 120%, deep red from 160%. */
const DAMAGE_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [600, [255, 150, 40]],
  [1200, [240, 40, 36]],
  [1600, [170, 14, 24]],
];

/** The damage number's colour (CSS rgb) at this damage (tenths of a percent). */
export const damageColor = (tenths: number): string => {
  const v = Math.max(0, tenths);
  let i = 1;
  while (i < DAMAGE_STOPS.length - 1 && v > DAMAGE_STOPS[i][0]) i++;
  const [a, ca] = DAMAGE_STOPS[i - 1];
  const [b, cb] = DAMAGE_STOPS[i];
  const k = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return `rgb(${ca.map((c, n) => Math.round(c + (cb[n] - c) * k)).join(', ')})`;
};

/** How hard the damage number shakes (px) and whether it pops, from the hit's damage and the fighter's damage after it (tenths). */
export const damageShake = (dmg: number, tenths: number): { amp: number; pop: boolean } => ({
  amp: Math.min(7, 2 + dmg / 40 + tenths / 400),
  pop: hitTier(dmg) === 'heavy',
});

// ------------------------------------------------------------------ launch trail

/** The look of a launch's smoke trail: none for a light hit, grey smoke for a medium one, white for a heavy one, a coloured streak when the launch will KO. */
export type TrailKind = 'none' | 'grey' | 'white' | 'streak';

export interface Trail {
  kind: TrailKind;
  /** Frames between puff batches (1 = every frame), puffs per batch and the puff size in scene units: all grow with the knockback. */
  every: number;
  puffs: number;
  size: number;
}

/** What smoke trail a launch throws, from the hit's tier and knockback (the same numbers as the impact) and the KO prediction. */
export const trailFor = (tier: HitTier, kb: number, ko: boolean): Trail => {
  if (tier === 'light' && !ko) return { kind: 'none', every: 0, puffs: 0, size: 0 };
  const big = Math.min(1, kb / 90);
  const kind: TrailKind = ko ? 'streak' : tier === 'heavy' ? 'white' : 'grey';
  // Polish pass: smoke is a faint hint behind the fighter, not a cloud (every 3rd or 2nd frame, 1-2 small puffs); the KO streak keeps its rate.
  return { kind, every: ko ? 1 : tier === 'heavy' ? 2 : 3, puffs: 1 + Math.floor(big * 1.5), size: 0.12 + big * 0.2 };
};

// ------------------------------------------------------------------ kill cue

/** The blast zone, in world units (the stage's `blast`). */
export interface BlastBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LaunchInput {
  /** Victim position when the launch starts, fixed-point (the sim's FX = 1000 per unit). */
  x: number;
  y: number;
  /** The launch velocity (fixed-point per frame), after DI and the ground bounce. */
  kx: number;
  ky: number;
  /** Gravity per frame and the fall-speed cap, fixed-point. */
  gravity: number;
  fallSpeed: number;
  blast: BlastBox;
  /** The victim's air speed (fixed-point per frame): once hit-stun ends they can steer back toward the stage against the launch. */
  drift?: number;
  /** Floors the victim lands on, and solid blocks (depth set: the launch bounces off their sides and underside): x range and top y in world units. A launch that comes down onto one is a bounce, not a KO. */
  floors?: { x1: number; x2: number; y: number; depth?: number }[];
}

/** Knockback speed bleeds off by this much per frame (the sim's KB_DECAY), fixed-point. */
export const KB_DECAY_PER_FRAME = 300;
const FXU = 1000;
const PREDICT_FRAMES = 240;

/**
 * Pure "will this launch KO": flies the victim along the launch (knockback bleeding off linearly, gravity pulling
 * down to the fall-speed cap) and says whether they pass the blast zone before landing on a floor. It only calls a KO the launch itself carries out of the zone (a fighter left falling can still recover). It ignores DI,
 * jumps and air dodges, so it is a prediction: the sim's KO is the truth, the cue only has to be right for the
 * usual finishing hit.
 */
export const predictLaunchKo = (p: LaunchInput): boolean => {
  // Integer math only: the sim calls this (the extra hit-stop depends on it), so every peer must agree.
  let kx = p.kx;
  let ky = p.ky;
  let x = p.x;
  let y = p.y;
  let vy = 0;
  const b = p.blast;
  const stun = Math.round(isqrt(kx * kx + ky * ky) / 4250);
  for (let i = 0; i < PREDICT_FRAMES; i++) {
    const sp = isqrt(kx * kx + ky * ky);
    if (sp <= KB_DECAY_PER_FRAME) {
      // The knockback is spent inside the stage: the fighter has control back and can recover, so no KO is called.
      return false;
    } else {
      kx -= idiv(kx * KB_DECAY_PER_FRAME, sp);
      ky -= idiv(ky * KB_DECAY_PER_FRAME, sp);
    }
    vy = Math.max(vy - p.gravity, Math.min(vy, -p.fallSpeed));
    const py = y;
    x += kx;
    y += vy + ky;
    if (p.drift && i >= stun) x -= x > 0 ? p.drift : -p.drift;
    if (x <= b.left * FXU || x >= b.right * FXU || y >= b.top * FXU || y <= b.bottom * FXU) return true;
    if (p.floors) {
      for (const f of p.floors) {
        if (f.depth && x >= (f.x1 - 40) * FXU && x <= (f.x2 + 40) * FXU && y < (f.y - 1) * FXU && y > (f.y - f.depth) * FXU) return false;
      }
    }
    if (vy + ky < 0 && p.floors) {
      for (const f of p.floors) if (x >= f.x1 * FXU && x <= f.x2 * FXU && py >= f.y * FXU && y <= f.y * FXU) return false;
    }
  }
  return false;
};

/** Extra hit-stop frames on a hit that will end a stock: the match clock holds this long before the slow motion (presentation only, the sim is unchanged). */
export const KILL_EXTRA_HITSTOP = 4;

/** The kill cue's timing, in real seconds: punch in, hold in slow motion, ease back. */
export const KILL_CUE = {
  /** Slow motion lasts this long in real time (0.4-0.6 s) at this fraction of normal speed. */
  slowSeconds: 0.5,
  slowScale: 0.3,
  /** The camera closes in by this share of its distance, on the impact. */
  punchIn: 0.42,
  /** Seconds the punch-in takes to settle back after the slow motion. */
  easeBack: 0.45,
  /** A brief red tint over the screen (alpha) and a sharper ring. */
  redFlash: 0.32,
} as const;

/** Sim speed multiplier for a kill cue `t` seconds old: held still for the extra hit-stop, slow for the beat, then back up smoothly. */
export const killTimeScale = (t: number): number => {
  const hold = KILL_EXTRA_HITSTOP / 60;
  if (t < 0 || t >= hold + KILL_CUE.slowSeconds + 0.12) return 1;
  if (t < hold) return 0;
  if (t < hold + KILL_CUE.slowSeconds) return KILL_CUE.slowScale;
  const k = (t - hold - KILL_CUE.slowSeconds) / 0.12;
  return KILL_CUE.slowScale + (1 - KILL_CUE.slowScale) * k;
};

/** How far the punch-in is applied (0 to 1) `t` seconds after the impact: snaps in, holds, eases back. */
export const killPunch = (t: number): number => {
  if (t < 0) return 0;
  const hold = KILL_CUE.slowSeconds;
  if (t < 0.08) return t / 0.08;
  if (t < hold) return 1;
  const k = Math.min(1, (t - hold) / KILL_CUE.easeBack);
  return 1 - k * k * (3 - 2 * k);
};

/** Launch speed (world units per frame) above which a hit-stunned fighter tumbles. */
export const TUMBLE_SPEED = 8;

/** Squash on a hit, visual only: 8-15% for 2-4 frames by damage, and a 6 px-ish push back on light hits. */
export const reactionFor = (tier: HitTier, _kb: number): { frames: number; squash: number; push: number } =>
  tier === 'light' ? { frames: 2, squash: 0.08, push: 0.06 } : tier === 'medium' ? { frames: 3, squash: 0.115, push: 0 } : { frames: 4, squash: 0.15, push: 0 };

// ------------------------------------------------------------------ attack tells, swing trails and contact sparks

/** Specials and smashes (everything from the smashes up except normals) warn before their first active frame; normals draw a swing trail. */
export const isSmashMove = (move: number): boolean => move >= 4 && move <= 6;
export const isSpecialMove = (move: number): boolean => move >= 12;
export const isNormalMove = (move: number): boolean => move <= 3 || (move >= 7 && move <= 11);

/** The first active frame of a move: its first hitbox window, its projectile/trap release frame, or its counter window start. */
export const moveStartFrame = (m: { hits: readonly { start: number }[]; shot?: { frame: number }; counter?: { from: number } }): number =>
  m.hits[0]?.start ?? m.shot?.frame ?? m.counter?.from ?? 0;

/** The last active frame of a move: its last hitbox window, its shot release frame, or its counter window end. */
export const moveEndFrame = (m: { hits: readonly { end: number }[]; shot?: { frame: number }; counter?: { to: number } }): number =>
  m.hits.length ? m.hits[m.hits.length - 1].end : m.shot?.frame ?? m.counter?.to ?? 0;

/** How many frames the startup wind-up tell lasts before the first active frame (the full startup window `0 .. start - 1`). */
export const tellFrames = (start: number): number => Math.max(0, start);

/** 0..1 strength of the wind-up tell on `frame` of a move whose first active frame is `start` (0 outside `0 <= frame < start`): ramps up to the swing. */
export const tellAt = (frame: number, start: number): number => {
  const n = tellFrames(start);
  if (n <= 0 || frame < 0 || frame >= start) return 0;
  return Math.max(0.35, (frame + 1) / n);
};

/** Whether a fighter is currently in the visible wind-up tell of a smash or special (`ACT.ATTACK = 5`). */
export const inWindupTell = (action: number, move: number, frame: number, start: number): boolean =>
  action === 5 && (isSmashMove(move) || isSpecialMove(move)) && tellAt(frame, start) > 0;

export interface WindupPose {
  /** Horizontal and vertical scale multipliers for the wind-up coil (1 = neutral). */
  sx: number;
  sy: number;
  /** Lean/coil angle in radians (signed by facing). */
  rot: number;
  /** World-space horizontal and vertical shift in scene units for the wind-up pullback and charge tremor. */
  dx: number;
  dy: number;
  /** Emissive flash multiplier (> 1 during the wind-up tell). */
  flash: number;
}

/**
 * The visible wind-up tell (both a flash and a coiled pose change) for every smash and special during `0 <= frame < start`,
 * followed by a forward release snap on the first two active frames (`start .. start + 1`).
 */
export const windupPose = (frame: number, start: number, move: number, facing = 1): WindupPose => {
  if (!(isSmashMove(move) || isSpecialMove(move)) || start <= 0) {
    return { sx: 1, sy: 1, rot: 0, dx: 0, dy: 0, flash: 1 };
  }
  const dir = facing >= 0 ? 1 : -1;
  const t = tellAt(frame, start);
  if (t > 0) {
    const tremor = (frame & 1 ? 1 : -1) * 0.014 * t;
    // Up smash (5) and Up special (12) crouch deep before springing up.
    if (move === 5 || move === 12) {
      return {
        sx: 1 + 0.16 * t,
        sy: 1 - 0.15 * t,
        rot: -dir * 0.12 * t,
        dx: -dir * 0.025 * t + tremor,
        dy: -0.02 * t,
        flash: 1 + 0.95 * t,
      };
    }
    // Down smash (6) and Down special (15) rear back and gather before slamming down.
    if (move === 6 || move === 15) {
      return {
        sx: 1 - 0.11 * t,
        sy: 1 + 0.14 * t,
        rot: -dir * 0.15 * t,
        dx: -dir * 0.04 * t + tremor,
        dy: 0.02 * t,
        flash: 1 + 0.95 * t,
      };
    }
    // Forward smash (4), Neutral special (13) and Side special (14) coil and lean back away from the target.
    return {
      sx: 1 + 0.14 * t,
      sy: 1 - 0.12 * t,
      rot: -dir * 0.18 * t,
      dx: -dir * 0.055 * t + tremor,
      dy: -0.015 * t,
      flash: 1 + 0.95 * t,
    };
  }
  if (frame >= start && frame < start + 2) {
    return { sx: 0.92, sy: 1.09, rot: dir * 0.1, dx: dir * 0.035, dy: 0, flash: 1 };
  }
  return { sx: 1, sy: 1, rot: 0, dx: 0, dy: 0, flash: 1 };
};

export interface ContactCore {
  /** Size of the bright core in scene units, how many frames it is drawn in front of the hurt fighter, and the least it may be across on screen (CSS px). */
  size: number;
  frames: number;
  minPx: number;
}

/** The bright core at the point of contact, by tier. Heavy is at least 26 CSS px across so it reads on a phone at 844x390 (the bar is 24). */
export const coreFor = (tier: HitTier): ContactCore =>
  tier === 'light' ? { size: 0.2, frames: 2, minPx: 12 } : tier === 'medium' ? { size: 0.32, frames: 2, minPx: 18 } : { size: 0.5, frames: 3, minPx: 26 };

/** The spark flash behind the fighter, sized by tier (scene units). */
export const sparkSizeFor = (tier: HitTier): number => (tier === 'light' ? 0.4 : tier === 'medium' ? 0.62 : 0.95);
