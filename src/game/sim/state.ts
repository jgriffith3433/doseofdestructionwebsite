// The complete simulation state. It is plain integers and arrays of plain
// objects, so it can be cloned for rollback and hashed for desync checks.

import { FX, rngNext } from './fixed.ts';
import { CHARACTERS } from './characters.ts';
import { EV_IDLE, STAGES, secs, type StageDef } from './stage.ts';
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
  /** Fighters on the same team (0 and up) cannot hit each other. -1 is free-for-all. */
  team: number;
  /** Size in percent; a giant is 150. Scales hurtbox, hitboxes and weight. */
  scale: number;
  /** Percent restored on respawn, tenths. Sudden death starts everyone high. */
  startPercent: number;
}

export interface Rules {
  /** Percent of normal gravity. */
  gravity: number;
  /** Percent of normal damage dealt. */
  damage: number;
  /** Match length in frames, 0 for none. */
  timeLimit: number;
  /** 1: the stage's events, damage zones and hazards are on. 0: a quiet stage (wind, water and gravity zones stay). */
  hazards: number;
}

export const DEFAULT_RULES: Rules = { gravity: 100, damage: 100, timeLimit: 0, hazards: 1 };

export interface GameState {
  frame: number;
  rng: number;
  stage: number;
  rules: Rules;
  fighters: Fighter[];
  over: number;
  /** Winning fighter id, or -1 for no contest. */
  winner: number;
  /** Winning team, or -1 when teams are off or nobody won. */
  winnerTeam: number;
  /** Set when the match ended because time ran out. */
  timedOut: number;
  /** Frames left of the end-of-game slowdown, or -1. */
  endTimer: number;
  /** Per stage event: 0 waiting, 1 warning, 2 running (stageMath EV_*). */
  evPhase: number[];
  /** Per stage event: frames left in that phase (-1 waits forever). */
  evTimer: number[];
  /** Per stage hazard: bitmask of fighters it hit this pass. */
  hazHit: number[];
}

export interface FighterSetup {
  char: number;
  stocks?: number;
  team?: number;
  scale?: number;
  /** Tenths of a percent. */
  startPercent?: number;
}

export function newFighter(id: number, char: number, stocks: number, stage = 0): Fighter {
  const spawns = STAGES[stage].spawns;
  const spawn = spawns[id % spawns.length];
  // Stand on whichever platform the spawn point sits on; in the air if none.
  const under = STAGES[stage].platforms.findIndex((p) => p.y === spawn.y && spawn.x >= p.x1 && spawn.x <= p.x2);
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
    grounded: under >= 0 ? 1 : 0,
    platform: under,
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
    team: -1,
    scale: 100,
    startPercent: 0,
  };
}

export interface GameOptions {
  stocks: number;
  seed: number;
  stage?: number;
  rules?: Partial<Rules>;
}

export function newGame(setup: FighterSetup[], opts: GameOptions): GameState {
  const stage = opts.stage ?? 0;
  return {
    frame: 0,
    rng: opts.seed | 0,
    stage,
    rules: { ...DEFAULT_RULES, ...opts.rules },
    fighters: setup.map((s, i) => {
      const f = newFighter(i, s.char, s.stocks ?? opts.stocks, stage);
      f.team = s.team ?? -1;
      f.scale = s.scale ?? 100;
      f.startPercent = s.startPercent ?? 0;
      f.percent = f.startPercent;
      return f;
    }),
    over: 0,
    winner: -1,
    winnerTeam: -1,
    timedOut: 0,
    endTimer: -1,
    ...startEvents(STAGES[stage], opts.seed | 0),
    hazHit: (STAGES[stage].hazards ?? []).map(() => 0),
  };
}

/**
 * Each event's first wait. Draws from its own rng stream (seed and event
 * index), so adding events never shifts the match rng.
 */
function startEvents(stage: StageDef, seed: number): { evPhase: number[]; evTimer: number[] } {
  const evs = stage.events ?? [];
  return {
    evPhase: evs.map(() => EV_IDLE),
    evTimer: evs.map((e, i) => {
      if ((e.trigger ?? 'timer') !== 'timer') return -1;
      if (e.first !== undefined) return secs(e.first);
      const [lo, hi] = e.every ?? [0, 0];
      const [, v] = rngNext(seed ^ Math.imul(i + 1, 0x9e3779b1));
      return secs(lo) + (v % Math.max(1, secs(hi) - secs(lo) + 1));
    }),
  };
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    rules: { ...s.rules },
    fighters: s.fighters.map((f) => ({ ...f })),
    evPhase: s.evPhase.slice(),
    evTimer: s.evTimer.slice(),
    hazHit: s.hazHit.slice(),
  };
}

/** Whether two fighters are on the same team. */
export function allies(a: Fighter, b: Fighter): boolean {
  return a.team >= 0 && a.team === b.team;
}

/** Hurtbox width and height in FX units, after scaling. */
export function bodySize(f: Fighter): [number, number] {
  const ch = CHARACTERS[f.char];
  return [Math.trunc((ch.width * FX * f.scale) / 100), Math.trunc((ch.height * FX * f.scale) / 100)];
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
  mix(s.stage);
  mix(s.rules.gravity);
  mix(s.rules.damage);
  mix(s.rules.timeLimit);
  mix(s.rules.hazards);
  mix(s.over);
  mix(s.winner);
  mix(s.winnerTeam);
  mix(s.timedOut);
  mix(s.endTimer);
  for (const v of s.evPhase) mix(v);
  for (const v of s.evTimer) mix(v);
  for (const v of s.hazHit) mix(v);
  for (const f of s.fighters) {
    for (const key of FIGHTER_KEYS) mix(f[key]);
  }
  return h >>> 0;
}

const FIGHTER_KEYS = Object.keys(newFighter(0, 0, 1)) as (keyof Fighter)[];
