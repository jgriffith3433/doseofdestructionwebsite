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
  /** The shared grab: reaching out (the jab clip), holding someone, throwing, and being held. */
  GRAB: 19,
  GRAB_HOLD: 20,
  THROW: 21,
  GRABBED: 22,
  /** Ledge options besides the getup (LEDGE_CLIMB): a roll onto the stage, a getup attack, a ledge jump. */
  LEDGE_ROLL: 23,
  LEDGE_ATTACK: 24,
  LEDGE_JUMP: 25,
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
  /** Frames left after walking off a ledge during which jump still gives a ground jump. */
  coyote: number;
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
  /** The shared grab: the fighter id + 1 this one holds (0 none), and the id + 1 holding this one. */
  holding: number;
  heldBy: number;
  /** 1 while this fighter is in sudden death (set when it starts). */
  suddenIn: number;
  /** The throw being thrown (THROW index + 1, 0 none). */
  throwKind: number;
}

/**
 * Something a special put in the world: a thrown projectile (kind 0) or a placed trap (kind 1). Plain integers,
 * copied from the move's ShotDef when it spawns, so it is cloned and hashed like everything else.
 */
export interface Shot {
  kind: number;
  owner: number;
  x: number;
  y: number;
  /** The platform a trap sits on (index), or -1. */
  plat: number;
  /** FX units per frame; vy falls by g each frame. */
  vx: number;
  vy: number;
  g: number;
  /** Frames left. */
  life: number;
  /** Frames until a trap can go off. */
  arm: number;
  /** Hit radius in FX units. */
  r: number;
  dmg: number;
  angle: number;
  bkb: number;
  kbg: number;
  /** The way it flies or was placed: 1 right, -1 left. */
  facing: number;
  style: number;
  /** Frames since it appeared (the renderer spins and pulses by it). */
  age: number;
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
  /** 1: a time-out that is exactly level (stocks and percent) goes to sudden death. 0: counting objectives, which end on time. */
  suddenDeath: number;
}

export const DEFAULT_RULES: Rules = { gravity: 100, damage: 100, timeLimit: 0, hazards: 1, suddenDeath: 1 };

/** A scripted mid-match broadcast event (content/campaign.json `events`). */
export interface BroadcastDef {
  id: string;
  /** flicker: studio lights flicker; rig-drop: a rig light falls on a fighter; chant: the crowd chants the leader; break: "We'll be right back"; hijack: the rival network takes the stage screens. */
  kind: 'flicker' | 'rig-drop' | 'chant' | 'break' | 'hijack' | 'takeover';
  /**
   * The trigger (any one met fires it): seconds of match time, or the first stock lost, or a fighter's damage percent,
   * or `stocks`: the player (fighter 0) is down to that many stocks or fewer.
   */
  when: { time?: number; stockLost?: boolean; damage?: number; stocks?: number };
  /** takeover: the one rule the Orchestrator rewrites on the spot, TAKEOVER_RULE_FRAMES after the glitch starts. */
  rule?: TakeoverRule;
}

/** A finale takeover's rule change, through the match's own rule system (sim/step.ts applyTakeoverRule). */
export interface TakeoverRule {
  /** Percent of normal gravity. */
  gravity?: number;
  /** Everyone on that side grows to 150%: the player's side or the rival's. */
  giant?: 'player' | 'rival';
  /** A rig light falls on the stage (and the stage's hazards switch on). */
  hazard?: boolean;
  /** Percent, tenths: everyone is hurt up to it now and respawns at it. */
  startPercent?: number;
}

export interface GameState {
  frame: number;
  /** Broadcast events: the definitions, and 1 for each that has fired. */
  bc: BroadcastDef[];
  bcFired: number[];
  /** Commercial break frames left (play is frozen), the camera angle it leaves behind. */
  freeze: number;
  angle: number;
  /** Frames left of the flicker and of the rival network's takeover. */
  flicker: number;
  hijack: number;
  /** The finale takeover: frames left of the feed, which bc entry it is, frames until its rule lands (0 none). */
  takeover: number;
  takeoverIdx: number;
  takeoverAt: number;
  /** The rig light: frames since it was called (-1 none), where it falls, the fighters it hit (bitmask). */
  rigFrame: number;
  rigX: number;
  rigHit: number;
  rng: number;
  stage: number;
  rules: Rules;
  fighters: Fighter[];
  /** Projectiles and traps in play, oldest first. */
  shots: Shot[];
  over: number;
  /** Winning fighter id, or -1 for no contest. */
  winner: number;
  /** Winning team, or -1 when teams are off or nobody won. */
  winnerTeam: number;
  /** Set when the match ended because time ran out. */
  timedOut: number;
  /** Sudden death: 0 not started, else 1 + frames since it began. */
  sudden: number;
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
    coyote: 0,
    dir: 0,
    lastHitBy: -1,
    prevInput: NO_INPUT,
    kos: 0,
    falls: 0,
    damageDealt: 0,
    team: -1,
    scale: 100,
    startPercent: 0,
    holding: 0,
    heldBy: 0,
    suddenIn: 0,
    throwKind: 0,
  };
}

export interface GameOptions {
  stocks: number;
  seed: number;
  stage?: number;
  rules?: Partial<Rules>;
  broadcast?: BroadcastDef[];
}

export function newGame(setup: FighterSetup[], opts: GameOptions): GameState {
  const stage = opts.stage ?? 0;
  return {
    frame: 0,
    bc: opts.broadcast ?? [],
    bcFired: (opts.broadcast ?? []).map(() => 0),
    freeze: 0,
    angle: 0,
    flicker: 0,
    hijack: 0,
    takeover: 0,
    takeoverIdx: -1,
    takeoverAt: 0,
    rigFrame: -1,
    rigX: 0,
    rigHit: 0,
    rng: opts.seed | 0,
    stage,
    rules: { ...DEFAULT_RULES, ...opts.rules },
    shots: [],
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
    sudden: 0,
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
    shots: s.shots.map((o) => ({ ...o })),
    evPhase: s.evPhase.slice(),
    evTimer: s.evTimer.slice(),
    hazHit: s.hazHit.slice(),
    bcFired: s.bcFired.slice(),
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
  mix(s.sudden);
  mix(s.rules.suddenDeath);
  mix(s.endTimer);
  for (const v of s.evPhase) mix(v);
  for (const v of s.evTimer) mix(v);
  for (const v of s.hazHit) mix(v);
  for (const v of s.bcFired) mix(v);
  mix(s.freeze);
  mix(s.angle);
  mix(s.flicker);
  mix(s.hijack);
  mix(s.takeover);
  mix(s.takeoverIdx);
  mix(s.takeoverAt);
  mix(s.rigFrame);
  mix(s.rigX);
  mix(s.rigHit);
  for (const f of s.fighters) {
    for (const key of FIGHTER_KEYS) mix(f[key]);
  }
  mix(s.shots.length);
  for (const o of s.shots) {
    for (const key of SHOT_KEYS) mix(o[key]);
  }
  return h >>> 0;
}

const FIGHTER_KEYS = Object.keys(newFighter(0, 0, 1)) as (keyof Fighter)[];
const SHOT_KEYS = Object.keys(newShot()) as (keyof Shot)[];

export function newShot(): Shot {
  return { kind: 0, owner: 0, x: 0, y: 0, plat: -1, vx: 0, vy: 0, g: 0, life: 0, arm: 0, r: 0, dmg: 0, angle: 0, bkb: 0, kbg: 0, facing: 1, style: 0, age: 0 };
}
