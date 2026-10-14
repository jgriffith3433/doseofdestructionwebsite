// The complete simulation state. It is plain integers and arrays of plain
// objects, so it can be cloned for rollback and hashed for desync checks.

import { FX } from './fixed.ts';
import { CHARACTERS } from './characters.ts';
import { STAGE } from './stage.ts';
import { NO_INPUT } from './input.ts';

export const ACT = {
  IDLE: 0,
  WALK: 1,
  CROUCH: 2,
  JUMPSQUAT: 3,
  AIR: 4,
  LAND: 5,
  ATTACK: 6,
  HITSTUN: 7,
  SHIELD: 8,
  SHIELD_STUN: 9,
  ROLL: 10,
  SPOTDODGE: 11,
  AIRDODGE: 12,
  LEDGE: 13,
  LEDGE_CLIMB: 14,
  HELPLESS: 15,
  DIZZY: 16,
  DEAD: 17,
  RESPAWN: 18,
} as const;

export const ACT_NAMES = Object.fromEntries(Object.entries(ACT).map(([k, v]) => [v, k])) as Record<number, string>;

export const SHIELD_MAX = 500;

export interface Fighter {
  id: number;
  char: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Knockback velocity, kept apart from self movement so it can decay on its own. */
  kbx: number;
  kby: number;
  facing: number;
  grounded: number;
  /** Index of the platform stood on, or -1. */
  platform: number;
  action: number;
  /** Frames spent in the current action. */
  frame: number;
  /** Frames the current action lasts, when it has a fixed length. */
  length: number;
  move: number;
  /** Bitmask of fighter ids the current move has already hit. */
  hitMask: number;
  /** Tenths of a percent. */
  percent: number;
  stocks: number;
  jumpsLeft: number;
  fastFall: number;
  airdodgeUsed: number;
  /** Air neutral specials used since last touching ground; only the first one floats. */
  airSpecial: number;
  shortHop: number;
  hitlag: number;
  hitstun: number;
  /** Launch waiting for hitlag to end, so DI can bend it. */
  launchAngle: number;
  launchSpeed: number;
  shield: number;
  intangible: number;
  /** Ledge side held (-1 left, 1 right) or 0. */
  ledge: number;
  ledgeCooldown: number;
  dropThrough: number;
  /** Buttons pressed recently while busy, replayed when the fighter can act. */
  buffer: number;
  bufferAge: number;
  dir: number;
  lastHitBy: number;
  prevInput: number;
  kos: number;
  falls: number;
  damageDealt: number;
}

export interface GameState {
  frame: number;
  rng: number;
  fighters: Fighter[];
  over: number;
  winner: number;
  /** Frames left of the end-of-game slowdown, or -1. */
  endTimer: number;
}

export interface FighterSetup {
  char: number;
}

export function newFighter(id: number, char: number, stocks: number): Fighter {
  const spawn = STAGE.spawns[id % STAGE.spawns.length];
  return {
    id,
    char,
    x: spawn.x * FX,
    y: spawn.y * FX,
    vx: 0,
    vy: 0,
    kbx: 0,
    kby: 0,
    facing: spawn.x <= 0 ? 1 : -1,
    grounded: 1,
    platform: 0,
    action: ACT.IDLE,
    frame: 0,
    length: 0,
    move: -1,
    hitMask: 0,
    percent: 0,
    stocks,
    jumpsLeft: CHARACTERS[char].airJumps,
    fastFall: 0,
    airdodgeUsed: 0,
    airSpecial: 0,
    shortHop: 0,
    hitlag: 0,
    hitstun: 0,
    launchAngle: 0,
    launchSpeed: 0,
    shield: SHIELD_MAX,
    intangible: 0,
    ledge: 0,
    ledgeCooldown: 0,
    dropThrough: 0,
    buffer: 0,
    bufferAge: 0,
    dir: 0,
    lastHitBy: -1,
    prevInput: NO_INPUT,
    kos: 0,
    falls: 0,
    damageDealt: 0,
  };
}

export function newGame(setup: FighterSetup[], stocks: number, seed: number): GameState {
  return {
    frame: 0,
    rng: seed | 0,
    fighters: setup.map((s, i) => newFighter(i, s.char, stocks)),
    over: 0,
    winner: -1,
    endTimer: -1,
  };
}

export function cloneState(s: GameState): GameState {
  return { ...s, fighters: s.fighters.map((f) => ({ ...f })) };
}

/** FNV-1a over every integer in the state. Peers compare this to catch desyncs. */
export function hashState(s: GameState): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
    h ^= (v / 4294967296) | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(s.frame);
  mix(s.rng);
  mix(s.over);
  mix(s.winner);
  mix(s.endTimer);
  for (const f of s.fighters) {
    for (const key of FIGHTER_KEYS) mix(f[key]);
  }
  return h >>> 0;
}

const FIGHTER_KEYS = Object.keys(newFighter(0, 0, 1)) as (keyof Fighter)[];
