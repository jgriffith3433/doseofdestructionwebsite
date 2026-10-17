// How a fighter is built from its spec: the shared moveset, scaled by size and
// tuning, and physics converted to FX integers. Pure functions and types, with
// no content loaded, so devtools can use them without pulling in the roster.
//
// Units: world units (the Foundry floor is 1120 wide), frames at 60 per second.
// Damage is in tenths of a percent (85 = 8.5%). Angles are degrees in the
// fighter's facing space: 0 is forward, 90 is up, 180 is backward, 270 is down.

import { FX } from './fixed.ts';

export interface Hitbox {
  x: number;
  y: number;
  r: number;
  dmg: number;
  angle: number;
  bkb: number;
  kbg: number;
}

export interface HitWindow {
  start: number;
  end: number;
  boxes: Hitbox[];
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
}

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
} as const;

/** Animation clip name for each move, in MOVE order. */
export const MOVE_KEYS = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair', 'upb', 'nspecial',
] as const;

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
    },
  ];
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
  return {
    id,
    name,
    art: `${id}.png`,
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
    moves: buildMoves(p.h, tuning),
  };
}
