// How a fighter is built from its spec: the shared moveset, scaled by size and
// tuning, and physics converted to FX integers. Pure functions and types, with
// no content loaded, so devtools can use them without pulling in the roster.
//
// Units: world units (the Foundry floor is 1120 wide), frames at 60 per second.
// Damage is in tenths of a percent (85 = 8.5%). Angles are degrees in the
// fighter's facing space: 0 is forward, 90 is up, 180 is backward, 270 is down.

import { FX } from './fixed.ts';
import type { FighterStyle } from '../artStyle.ts';

export interface Look {
  name: string;
  /** Main colour hue in degrees to turn (outfit looks), or -1 to tint the grey mid-tones (dark fighters). Omitted: unchanged. */
  from?: number;
  /** Degrees either side of `from` that are recoloured (soft edge). */
  range?: number;
  /** Outfit looks: degrees the hue turns. Neutral looks: the hue the greys take. */
  hue?: number;
  sat?: number;
  val?: number;
  /** Wins with this fighter needed to use it (0: open). */
  wins: number;
}

export const CLASSIC: Look = { name: 'Classic', wins: 0 };



export interface Hitbox {
  x: number;
  y: number;
  r: number;
  dmg: number;
  angle: number;
  bkb: number;
  kbg: number;
  /** A command grab: goes through shields, hits only a fighter on the same floor, and pulls them `pull` units in front. */
  grab?: number;
  pull?: number;
}

export interface HitWindow {
  start: number;
  end: number;
  boxes: Hitbox[];
  /** Hits the same fighter again when this window opens (a flurry's jabs). */
  rehit?: number;
}

/** Sets the fighter's velocity every frame from `from` to `to` (a dash, a recovery's climb). Speeds are FX units per frame. */
export interface Drive {
  from: number;
  to: number;
  /** Forward is positive. Null leaves that axis alone. */
  vx: number | null;
  vy: number | null;
  /** The stick steers vx by up to this many units per frame. */
  steer?: number;
  /** Angled recovery: vx is aimed by the stick (forward when it is neutral), at this speed. */
  aim?: number;
}

/** What a move puts in the world: a thrown projectile (kind 0) or a placed trap (kind 1). Integers, in FX units where noted. */
export interface ShotDef {
  kind: number;
  frame: number;
  /** Offset from the fighter (world units, forward is positive). */
  x: number;
  y: number;
  /** FX units per frame, forward is positive. */
  vx: number;
  vy: number;
  /** FX units per frame squared, pulling down. */
  g: number;
  life: number;
  /** Frames before a trap can go off. */
  arm: number;
  r: number;
  dmg: number;
  angle: number;
  bkb: number;
  kbg: number;
  /** How many of this fighter's may exist at once. */
  max: number;
  /** Look: 0 thrown board, 1 placed trap, 2 orb. */
  style: number;
}

/** A counter: while frames `from` to `to` last, a hit on the fighter is turned back on the attacker. */
export interface CounterDef {
  from: number;
  to: number;
  /** Percent of the blocked hit's damage that comes back (never below box.dmg). */
  mult: number;
  box: Hitbox;
}

export interface Impulse {
  frame: number;
  /** World units per frame, forward is positive. Null leaves that axis alone. */
  vx: number | null;
  vy: number | null;
  /** When set, the stick steers vx by up to this many units per frame. */
  steer?: number;
}

export interface Move {
  name: string;
  total: number;
  hits: HitWindow[];
  impulses?: Impulse[];
  landingLag?: number;
  /** Ends in a helpless fall (up special). */
  helpless?: boolean;
  /** First frame the move can grab a ledge. */
  ledgeFrom?: number;
  /** Gravity is ignored before this frame. */
  floatUntil?: number;
  drive?: Drive[];
  shot?: ShotDef;
  counter?: CounterDef;
  /** Only the first one in the air since the last landing gets its motion (neutral special, dash). */
  airLimited?: boolean;
  /** Archetype, for the renderer's effects: dash leaves a trail, counter flashes. */
  kind?: SpecialKind;
  /** Clips to try after the move's own, best first (the renderer's stand-ins). */
  clips?: string[];
}

export type SpecialKind = 'projectile' | 'dash' | 'counter' | 'grab' | 'trap' | 'flurry' | 'recovery';

export const MOVE = {
  JAB: 0,
  FTILT: 1,
  UTILT: 2,
  DTILT: 3,
  FSMASH: 4,
  USMASH: 5,
  DSMASH: 6,
  NAIR: 7,
  FAIR: 8,
  BAIR: 9,
  UAIR: 10,
  DAIR: 11,
  UPB: 12,
  NSPECIAL: 13,
  /** Special with the stick sideways, and with it held down. */
  SSPECIAL: 14,
  DSPECIAL: 15,
} as const;

/** Animation clip name for each move, in MOVE order. */
export const MOVE_KEYS = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair', 'upb', 'nspecial', 'sspecial', 'dspecial',
] as const;

/** The four throws, in THROW order: forward, back, up, down. */
export const THROW = { FORWARD: 0, BACK: 1, UP: 2, DOWN: 3 } as const;
export const THROW_KEYS = ['fthrow', 'bthrow', 'uthrow', 'dthrow'] as const;
/** The existing clip each throw reuses: forward tilt, back air, up tilt, down tilt. */
export const THROW_CLIPS = ['ftilt', 'bair', 'utilt', 'dtilt'] as const;

/** One throw: the same shape as a hitbox's launch numbers, plus when the held fighter lets go and how long the throw lasts. */
export interface ThrowDef {
  name: string;
  dmg: number;
  angle: number;
  bkb: number;
  kbg: number;
  /** Frame of the throw the held fighter is released on, and the throw's total frames. */
  release: number;
  total: number;
}

export const AERIALS: ReadonlySet<number> = new Set([MOVE.NAIR, MOVE.FAIR, MOVE.BAIR, MOVE.UAIR, MOVE.DAIR]);

export interface Tuning {
  /** Multiplies every frame count. Above 1 is slower. */
  frames: number;
  damage: number;
  knockback: number;
  /** Multiplies how far forward hitboxes reach, and some of their size. */
  reach: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  /** Image under /characters/img/. */
  art: string;
  /** One or two words for the select screen. */
  role: string;
  blurb: string;
  /** Colour looks, Classic first (looks.ts). */
  looks: Look[];
  /** Art bible numbers (artStyle.ts): outline colour and the saturation / value remap. Render only, never in the sim. */
  style?: FighterStyle;
  width: number;
  height: number;
  weight: number;
  walkSpeed: number;
  groundAccel: number;
  groundFriction: number;
  airSpeed: number;
  airAccel: number;
  airFriction: number;
  gravity: number;
  fallSpeed: number;
  fastFallSpeed: number;
  jumpVel: number;
  shortHopVel: number;
  airJumpVel: number;
  airJumps: number;
  /** Kept for the select screen's stat bars. */
  tuning: Tuning;
  moves: Move[];
  /** The four throws of the shared grab (forward, back, up, down), scaled by this fighter's tuning. */
  throws: ThrowDef[];
  /** How far in front of the feet the grab reaches, from the jab's furthest hitbox edge. */
  grabReach: number;
  /** True when the fighter has its own specials: Special with a direction then picks side, up or down. */
  specials: boolean;
}

/** Playtest feedback: attacks felt slow. Every move's frame counts are scaled by this (1 = as authored). */
const MOVE_TIME = 0.65;

// The shared moveset, written for a fighter 110 units tall. Each character
// scales it by height and their own tuning.
function buildMoves(height: number, t: Tuning): Move[] {
  const s = height / 110;
  const f = (n: number) => Math.max(1, Math.round(n * t.frames * MOVE_TIME));
  const box = (x: number, y: number, r: number, dmg: number, angle: number, bkb: number, kbg: number): Hitbox => ({
    x: Math.round(x * s * t.reach),
    y: Math.round(y * s),
    r: Math.round(r * s * (1 + (t.reach - 1) * 0.5)),
    dmg: Math.round(dmg * t.damage),
    angle,
    bkb,
    kbg: Math.round(kbg * t.knockback),
  });
  const win = (start: number, end: number, ...boxes: Hitbox[]): HitWindow => ({ start: f(start), end: f(end), boxes });

  return [
    { name: 'Jab', total: f(18), hits: [win(3, 5, box(42, 62, 26, 30, 40, 20, 50))] },
    { name: 'Forward tilt', total: f(28), hits: [win(6, 9, box(58, 56, 30, 90, 35, 26, 95))] },
    { name: 'Up tilt', total: f(26), hits: [win(5, 10, box(14, 112, 34, 75, 85, 32, 110), box(30, 84, 26, 75, 85, 32, 110))] },
    { name: 'Down tilt', total: f(22), hits: [win(5, 7, box(58, 12, 26, 65, 80, 36, 70))] },
    { name: 'Forward smash', total: f(50), hits: [win(16, 19, box(72, 56, 36, 160, 38, 34, 108))] },
    { name: 'Up smash', total: f(48), hits: [win(12, 16, box(10, 128, 40, 150, 88, 34, 106))] },
    {
      name: 'Down smash',
      total: f(46),
      hits: [win(10, 12, box(62, 14, 30, 130, 30, 32, 100), box(-62, 14, 30, 130, 150, 32, 100))],
    },
    { name: 'Neutral air', total: f(36), hits: [win(5, 20, box(0, 56, 46, 80, 45, 24, 90))], landingLag: 7 },
    { name: 'Forward air', total: f(38), hits: [win(9, 12, box(56, 60, 34, 110, 40, 30, 100))], landingLag: 12 },
    { name: 'Back air', total: f(34), hits: [win(7, 10, box(-56, 56, 34, 120, 140, 30, 106))], landingLag: 10 },
    { name: 'Up air', total: f(32), hits: [win(6, 10, box(4, 128, 38, 90, 85, 30, 100))], landingLag: 8 },
    { name: 'Down air', total: f(44), hits: [win(14, 17, box(0, -4, 34, 120, 270, 20, 90))], landingLag: 18 },
    {
      name: 'Up special',
      total: f(50),
      hits: [win(4, 14, box(0, 80, 40, 60, 80, 50, 60))],
      impulses: [{ frame: f(4), vx: 0, vy: 20, steer: 6 }],
      helpless: true,
      ledgeFrom: 12,
      landingLag: 20,
    },
    {
      name: 'Neutral special',
      total: f(40),
      hits: [win(8, 16, box(52, 60, 34, 110, 40, 40, 80))],
      impulses: [{ frame: f(8), vx: 14, vy: null }],
      landingLag: 14,
      floatUntil: f(18),
      airLimited: true,
    },
  ];
}

/**
 * The shared throws (angles in the fighter's facing space), scaled by each fighter's damage and knockback tuning:
 * forward is the all-round one, back sends the other way, up is the kill throw off the top at high percent, and
 * down is the weak one that leaves the victim close by for a follow-up.
 */
function buildThrows(t: Tuning): ThrowDef[] {
  const f = (n: number) => Math.max(1, Math.round(n * t.frames * MOVE_TIME));
  const th = (name: string, dmg: number, angle: number, bkb: number, kbg: number, release: number, total: number): ThrowDef => ({
    name,
    dmg: Math.round(dmg * t.damage),
    angle,
    bkb,
    kbg: Math.round(kbg * t.knockback),
    release: f(release),
    total: Math.max(f(total), f(release) + 4),
  });
  return [
    th('Forward throw', 80, 38, 30, 92, 12, 34),
    th('Back throw', 90, 142, 32, 98, 14, 38),
    th('Up throw', 70, 88, 30, 90, 12, 34),
    th('Down throw', 60, 70, 24, 40, 10, 30),
  ];
}

/** The grab's reach: how far out the jab's furthest hitbox edge sits. */
function grabReachOf(jab: Move): number {
  let reach = 0;
  for (const w of jab.hits) for (const b of w.boxes) reach = Math.max(reach, b.x + b.r);
  return Math.max(40, reach);
}

// ------------------------------------------------------------------ specials
//
// A fighter's content/fighters.json entry may carry `specials: { neutral, side, up, down }`. Each names an
// archetype (`type`) and its numbers; compileSpecial() turns it into an ordinary Move (hit windows, a drive,
// a shot to spawn, a counter window) that the sim plays with the same attack machinery as every other move.
// Frame counts are written as played (not scaled by the fighter's `frames`); distances scale with height.

export type RecoveryVariant = 'straight' | 'angled' | 'glide';

export interface SpecialSpec {
  type: SpecialKind;
  /** Recovery only. */
  variant?: RecoveryVariant;
  name?: string;
  /** The clip to show when the fighter has none of its own for this move (nspecial, fsmash, dsmash, upb, roll). */
  clip?: string;
  /** Frame the effect starts on (the throw, the dash, the counter window, the grab, the first jab, the jump). */
  startup?: number;
  /** Frames the move lasts in all; when left out it is the startup, the active frames and `endlag`. */
  total?: number;
  endlag?: number;
  dmg?: number;
  angle?: number;
  bkb?: number;
  kbg?: number;
  /** Hit radius, and the hitbox's spot in front of and above the feet. */
  r?: number;
  x?: number;
  y?: number;
  /** Units per frame: a projectile's flight, a dash, a flurry's advance, a recovery's horizontal run. */
  speed?: number;
  /** A projectile's upward speed, or a recovery's climb. */
  rise?: number;
  /** A projectile's gravity, units per frame per frame (hundredths). */
  gravity?: number;
  life?: number;
  max?: number;
  arm?: number;
  style?: 'board' | 'trap' | 'orb';
  /** Dash and recovery: frames of motion. */
  duration?: number;
  /** Counter: frames the window stays open, and the percent of the blocked hit that comes back. */
  window?: number;
  mult?: number;
  /** Command grab: how far in front of the fighter the grabbed one is pulled. */
  pull?: number;
  /** Flurry: how many hits, the frames between them, and the last hit's damage and knockback. */
  hits?: number;
  interval?: number;
  finisherDmg?: number;
  finisherBkb?: number;
  finisherKbg?: number;
  /** Glide recovery: the fall speed while gliding. */
  glide?: number;
}

export interface SpecialsSpec {
  neutral?: SpecialSpec;
  side?: SpecialSpec;
  up?: SpecialSpec;
  down?: SpecialSpec;
}

const SHOT_STYLE = { board: 0, trap: 1, orb: 2 } as const;
const DEFAULT_CLIP: Record<SpecialKind, string> = {
  projectile: 'nspecial',
  dash: 'fsmash',
  counter: 'dsmash',
  grab: 'dsmash',
  trap: 'dsmash',
  flurry: 'fsmash',
  recovery: 'upb',
};

export const SPECIAL_KINDS: readonly SpecialKind[] = ['projectile', 'dash', 'counter', 'grab', 'trap', 'flurry', 'recovery'];

/** Turns a specials entry into a Move. Pure integer data out; the sim never looks at the spec again. */
export function compileSpecial(spec: SpecialSpec, slot: string, height: number, t: Tuning): Move {
  if (!SPECIAL_KINDS.includes(spec.type)) throw new Error(`specials.${slot}: unknown archetype "${spec.type}"`);
  const s = height / 110;
  const n = (v: number | undefined, d: number) => Math.round(v ?? d);
  const len = (v: number | undefined, d: number) => Math.max(1, Math.round(v ?? d));
  const dist = (v: number | undefined, d: number) => Math.round((v ?? d) * s * t.reach);
  const box = (dmg: number, angle: number, bkb: number, kbg: number, x: number, y: number, r: number): Hitbox => ({
    x: dist(x, 0),
    y: Math.round(y * s),
    r: Math.round(r * s * (1 + (t.reach - 1) * 0.5)),
    dmg: Math.round(dmg * t.damage),
    angle,
    bkb,
    kbg: Math.round(kbg * t.knockback),
  });
  const fxu = (v: number) => Math.round(v * FX);
  const clips = [spec.clip ?? DEFAULT_CLIP[spec.type]];
  const name = spec.name ?? `${slot[0].toUpperCase()}${slot.slice(1)} special`;
  const startup = len(spec.startup, 8);
  const base = { name, kind: spec.type, clips };

  switch (spec.type) {
    case 'projectile': {
      const life = len(spec.life, 60);
      return {
        ...base,
        total: len(spec.total, startup + 20),
        hits: [],
        shot: {
          kind: 0,
          frame: startup,
          x: dist(spec.x, 40),
          y: Math.round((spec.y ?? 62) * s),
          vx: Math.round((spec.speed ?? 12) * s * FX),
          vy: Math.round((spec.rise ?? 0) * s * FX),
          g: Math.round((spec.gravity ?? 0) * s * FX),
          life,
          arm: 0,
          r: Math.round((spec.r ?? 22) * s),
          dmg: Math.round((spec.dmg ?? 70) * t.damage),
          angle: n(spec.angle, 35),
          bkb: n(spec.bkb, 25),
          kbg: Math.round((spec.kbg ?? 70) * t.knockback),
          max: len(spec.max, 1),
          style: SHOT_STYLE[spec.style ?? 'board'],
        },
      };
    }
    case 'dash': {
      const dur = len(spec.duration, 14);
      const end = startup + dur;
      return {
        ...base,
        total: len(spec.total, end + len(spec.endlag, 14)),
        hits: [{ start: startup, end, boxes: [box(spec.dmg ?? 90, n(spec.angle, 40), n(spec.bkb, 30), spec.kbg ?? 90, spec.x ?? 40, spec.y ?? 44, spec.r ?? 30)] }],
        drive: [{ from: startup, to: end, vx: fxu((spec.speed ?? 11) * s), vy: null }],
        floatUntil: end,
        landingLag: 12,
        airLimited: true,
      };
    }
    case 'counter': {
      const win = len(spec.window, 22);
      return {
        ...base,
        total: len(spec.total, startup + win + len(spec.endlag, 18)),
        hits: [],
        counter: {
          from: startup,
          to: startup + win,
          mult: n(spec.mult, 150),
          box: box(spec.dmg ?? 60, n(spec.angle, 45), n(spec.bkb, 40), spec.kbg ?? 100, 0, 0, 0),
        },
        landingLag: 10,
      };
    }
    case 'grab': {
      const reach = box(spec.dmg ?? 110, n(spec.angle, 60), n(spec.bkb, 40), spec.kbg ?? 100, spec.x ?? 50, spec.y ?? 50, spec.r ?? 36);
      reach.grab = 1;
      reach.pull = dist(spec.pull, 40);
      return {
        ...base,
        // A whiffed command grab is a long recovery.
        total: len(spec.total, startup + 4 + len(spec.endlag, 38)),
        hits: [{ start: startup, end: startup + 3, boxes: [reach] }],
        landingLag: 16,
      };
    }
    case 'trap': {
      return {
        ...base,
        total: len(spec.total, startup + len(spec.endlag, 22)),
        hits: [],
        shot: {
          kind: 1,
          frame: startup,
          x: dist(spec.x, 55),
          y: 0,
          vx: 0,
          vy: 0,
          g: 0,
          life: len(spec.life, 600),
          arm: len(spec.arm, 24),
          r: Math.round((spec.r ?? 34) * s),
          dmg: Math.round((spec.dmg ?? 100) * t.damage),
          angle: n(spec.angle, 80),
          bkb: n(spec.bkb, 40),
          kbg: Math.round((spec.kbg ?? 90) * t.knockback),
          // One trap per fighter, whatever the data says.
          max: 1,
          style: SHOT_STYLE[spec.style ?? 'trap'],
        },
        landingLag: 8,
      };
    }
    case 'flurry': {
      const count = len(spec.hits, 5);
      const gap = len(spec.interval, 6);
      const hitBox = () => box(spec.dmg ?? 22, n(spec.angle, 0), n(spec.bkb, 14), spec.kbg ?? 0, spec.x ?? 44, spec.y ?? 56, spec.r ?? 34);
      const windows: HitWindow[] = [];
      for (let i = 0; i < count; i++) {
        const at = startup + i * gap;
        const last = i === count - 1;
        const b = last ? box(spec.finisherDmg ?? 70, 45, n(spec.finisherBkb, 40), spec.finisherKbg ?? 100, spec.x ?? 44, spec.y ?? 56, (spec.r ?? 34) + 4) : hitBox();
        windows.push({ start: at, end: at + 1, boxes: [b], rehit: 1 });
      }
      const end = startup + count * gap;
      return {
        ...base,
        total: len(spec.total, end + len(spec.endlag, 18)),
        hits: windows,
        drive: [{ from: startup, to: end - gap, vx: fxu((spec.speed ?? 1.6) * s), vy: null }],
        landingLag: 12,
      };
    }
    case 'recovery': {
      const variant = spec.variant ?? 'straight';
      const dur = len(spec.duration, 14);
      const rise = fxu((spec.rise ?? 16) * s);
      const run = fxu((spec.speed ?? 8) * s);
      const hit = box(spec.dmg ?? 50, n(spec.angle, 80), n(spec.bkb, 40), spec.kbg ?? 60, spec.x ?? 0, spec.y ?? 70, spec.r ?? 34);
      const climb = [startup, startup + dur] as const;
      const end = climb[1];
      const hits: HitWindow[] = [{ start: startup, end: Math.min(end, startup + 10), boxes: [hit] }];
      if (variant === 'glide') {
        const lift = Math.max(2, Math.round(dur * 0.4));
        const glideEnd = end + len(spec.life, 40);
        return {
          ...base,
          total: len(spec.total, glideEnd + 12),
          hits,
          drive: [
            { from: startup, to: startup + lift, vx: 0, vy: rise, steer: fxu(3) },
            { from: startup + lift + 1, to: glideEnd, vx: run, vy: -fxu((spec.glide ?? 1.4) * s), steer: fxu(4) },
          ],
          ledgeFrom: startup,
          landingLag: 14,
        };
      }
      return {
        ...base,
        total: len(spec.total, end + len(spec.endlag, 24)),
        hits,
        drive: [
          variant === 'angled'
            ? { from: startup, to: end, vx: null, vy: Math.round(rise * 0.8), aim: run }
            : { from: startup, to: end, vx: 0, vy: rise, steer: fxu(4) },
        ],
        helpless: true,
        ledgeFrom: startup,
        landingLag: 20,
      };
    }
  }
}

/** The moveset a fighter plays: the shared one, with any specials in the entry swapped in. */
function withSpecials(moves: Move[], specials: SpecialsSpec | undefined, height: number, t: Tuning): Move[] {
  const out = moves.slice();
  // The two new slots start out as the neutral special, so a fighter with a partial kit has a move on every direction.
  out[MOVE.SSPECIAL] = { ...out[MOVE.NSPECIAL], name: 'Side special' };
  out[MOVE.DSPECIAL] = { ...out[MOVE.NSPECIAL], name: 'Down special' };
  if (!specials) return out;
  if (specials.neutral) out[MOVE.NSPECIAL] = compileSpecial(specials.neutral, 'neutral', height, t);
  if (specials.side) out[MOVE.SSPECIAL] = compileSpecial(specials.side, 'side', height, t);
  if (specials.up) out[MOVE.UPB] = compileSpecial(specials.up, 'up', height, t);
  if (specials.down) out[MOVE.DSPECIAL] = compileSpecial(specials.down, 'down', height, t);
  return out;
}

/**
 * Where a move's hitboxes sit, fitted to the drawn limb or effect by tools/fit-hitboxes.mjs: for each move key
 * (fsmash, usmash, dsmash, nspecial, sspecial, upb, dspecial) one `{ x, y }` per hitbox in the move's order
 * (a projectile's one entry is where the shot spawns). World units for this fighter, final: they replace the
 * authored offsets, so reach and size tuning are already in them.
 */
export type HitboxFit = Record<string, { x: number; y: number }[]>;

/** The moves tools/fit-hitboxes.mjs fits and the keys it writes. */
export const FITTED_MOVES = ['fsmash', 'usmash', 'dsmash', 'nspecial', 'sspecial', 'upb', 'dspecial'] as const;

/** Puts fitted hitbox offsets onto a moveset (a missing or short entry leaves the authored box alone). */
export function applyHitboxFit(moves: Move[], fit: HitboxFit | undefined): Move[] {
  if (!fit) return moves;
  return moves.map((m, i) => {
    const at = fit[MOVE_KEYS[i]];
    if (!at?.length) return m;
    const boxes = m.hits.flatMap((w) => w.boxes);
    let k = 0;
    const hits = m.hits.map((w) => ({ ...w, boxes: w.boxes.map((b) => { const o = at[k++]; return o ? { ...b, x: Math.round(o.x), y: Math.round(o.y) } : b; }) }));
    const shot = m.shot && boxes.length === 0 && at[0] ? { ...m.shot, x: Math.round(at[0].x), y: Math.round(at[0].y) } : m.shot;
    return { ...m, hits, shot };
  });
}

export interface Spec {
  /** Hurtbox size in world units. */
  w: number;
  h: number;
  weight: number;
  walk: number;
  air: number;
  gravity: number;
  fall: number;
  /** Full hop height in world units; short hops and air jumps scale from it. */
  hop: number;
  jumps: number;
  frames?: number;
  dmg?: number;
  kb?: number;
  reach?: number;
  /** Own neutral / side / up / down specials. Without it the fighter keeps the shared Neutral and Up special. */
  specials?: SpecialsSpec;
  /** Fitted hitbox offsets (tools/fit-hitboxes.mjs). */
  hitboxes?: HitboxFit;
  /** Colour looks (looks.ts): the first is today's art; the rest are palette shifts of the same sprite sheets. */
  looks?: Look[];
  /** Art bible style (tools/derive-style.mjs). */
  style?: FighterStyle;
}

// Specs are written in world units for readability. Everything the sim reads
// is converted to FX integers here, once, when the module loads.
/** One entry of content/fighters.json. */
export interface FighterEntry extends Spec {
  id: string;
  name: string;
  role: string;
  blurb: string;
}

export function fighter(id: string, name: string, role: string, blurb: string, p: Spec): CharacterDef {
  const fx = (v: number) => Math.round(v * FX);
  const jump = (height: number) => fx(Math.sqrt(2 * p.gravity * height));
  const tuning: Tuning = { frames: p.frames ?? 1, damage: p.dmg ?? 1, knockback: p.kb ?? 1, reach: p.reach ?? 1 };
  const moves = applyHitboxFit(withSpecials(buildMoves(p.h, tuning), p.specials, p.h, tuning), p.hitboxes);
  return {
    id,
    name,
    art: `${id}.png`,
    looks: p.looks && p.looks.length ? p.looks : [CLASSIC],
    style: p.style,
    role,
    blurb,
    width: p.w,
    height: p.h,
    weight: p.weight,
    walkSpeed: fx(p.walk),
    groundAccel: fx(p.walk * 0.14),
    groundFriction: fx(p.walk * 0.12),
    airSpeed: fx(p.air),
    airAccel: fx(p.air * 0.085),
    airFriction: fx(0.09),
    gravity: fx(p.gravity),
    fallSpeed: fx(p.fall),
    fastFallSpeed: fx(p.fall * 1.45),
    jumpVel: jump(p.hop),
    shortHopVel: jump(p.hop * 0.42),
    airJumpVel: jump(p.hop * 0.85),
    airJumps: p.jumps,
    tuning,
    moves,
    throws: buildThrows(tuning),
    grabReach: grabReachOf(moves[MOVE.JAB]),
    specials: !!p.specials,
  };
}
