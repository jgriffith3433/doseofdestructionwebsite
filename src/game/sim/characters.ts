// Fighter definitions. Everything here is static data the sim reads by id;
// none of it is part of the per-frame state.
//
// Units: world units (the stage is 1120 wide), frames at 60 per second.
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

export const AERIALS: ReadonlySet<number> = new Set([MOVE.NAIR, MOVE.FAIR, MOVE.BAIR, MOVE.UAIR, MOVE.DAIR]);

export interface CharacterDef {
  id: string;
  name: string;
  /** Image under /characters/img/. */
  art: string;
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
  moves: Move[];
}

interface Tuning {
  /** Multiplies every frame count. Above 1 is slower. */
  frames: number;
  damage: number;
  knockback: number;
}

// The shared moveset, written for a fighter 110 units tall. Each character
// scales it by height and their own tuning.
function buildMoves(height: number, t: Tuning): Move[] {
  const s = height / 110;
  const f = (n: number) => Math.max(1, Math.round(n * t.frames));
  const box = (x: number, y: number, r: number, dmg: number, angle: number, bkb: number, kbg: number): Hitbox => ({
    x: Math.round(x * s),
    y: Math.round(y * s),
    r: Math.round(r * s),
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

type Meta = Pick<CharacterDef, 'id' | 'name' | 'art' | 'blurb' | 'width' | 'height' | 'weight'>;
type Physics = Omit<CharacterDef, keyof Meta | 'moves'>;

// Physics values are written in world units for readability and stored as FX integers.
function def(meta: Meta & { physics: Physics; tuning: Tuning }): CharacterDef {
  const { physics, tuning, ...rest } = meta;
  const fx = (v: number) => Math.round(v * FX);
  const scaled = { ...physics };
  for (const key of Object.keys(scaled) as (keyof Physics)[]) {
    if (key !== 'airJumps') scaled[key] = fx(physics[key]);
  }
  return { ...rest, ...scaled, moves: buildMoves(meta.height, tuning) };
}

export const CHARACTERS: CharacterDef[] = [
  def({
    id: 'exit-punk',
    name: 'Exit Punk',
    art: 'exit-punk.png',
    blurb: 'All-rounder. Nothing to learn around, nothing to hide behind.',
    width: 46,
    height: 110,
    weight: 95,
    physics: {
      walkSpeed: 6.5, groundAccel: 0.9, groundFriction: 0.8,
      airSpeed: 5.5, airAccel: 0.45, airFriction: 0.08,
      gravity: 0.62, fallSpeed: 11, fastFallSpeed: 16,
      jumpVel: 13.6, shortHopVel: 9.2, airJumpVel: 12.6, airJumps: 1,
    },
    tuning: { frames: 1, damage: 1, knockback: 1 },
  }),
  def({
    id: 'break',
    name: 'Break',
    art: 'break.png',
    blurb: 'Heavy. Slow hands, huge reach, hard to launch.',
    width: 70,
    height: 130,
    weight: 122,
    physics: {
      walkSpeed: 4.6, groundAccel: 0.6, groundFriction: 0.7,
      airSpeed: 4.4, airAccel: 0.32, airFriction: 0.06,
      gravity: 0.76, fallSpeed: 13, fastFallSpeed: 18,
      jumpVel: 14.4, shortHopVel: 9.8, airJumpVel: 13, airJumps: 1,
    },
    tuning: { frames: 1.18, damage: 1.22, knockback: 1.06 },
  }),
  def({
    id: 'evil-blue-bird',
    name: 'Evil Blue Bird',
    art: 'evil-blue-bird.png',
    blurb: 'Floaty. Two extra jumps and an air game that never lands.',
    width: 62,
    height: 96,
    weight: 80,
    physics: {
      walkSpeed: 5, groundAccel: 0.7, groundFriction: 0.7,
      airSpeed: 6.4, airAccel: 0.6, airFriction: 0.1,
      gravity: 0.46, fallSpeed: 8.4, fastFallSpeed: 13,
      jumpVel: 11.6, shortHopVel: 7.6, airJumpVel: 10.6, airJumps: 2,
    },
    tuning: { frames: 1, damage: 0.9, knockback: 0.96 },
  }),
  def({
    id: 'kaelen',
    name: 'Kaelen',
    art: 'kaelen.png',
    blurb: 'Fast. Quick hits, quick fall, and gone before the trade lands.',
    width: 44,
    height: 112,
    weight: 86,
    physics: {
      walkSpeed: 8.2, groundAccel: 1.3, groundFriction: 1,
      airSpeed: 6, airAccel: 0.55, airFriction: 0.1,
      gravity: 0.8, fallSpeed: 14, fastFallSpeed: 19.5,
      jumpVel: 15.4, shortHopVel: 10.2, airJumpVel: 14, airJumps: 1,
    },
    tuning: { frames: 0.84, damage: 0.86, knockback: 0.97 },
  }),
];
