// Advances the simulation by one frame. step() reads only the state and the
// frame's inputs, uses only integer math, and visits fighters in id order, so
// every peer that feeds it the same inputs reaches the same state.

import { FX, TRIG_ONE, approach, clamp, iatan2, icos, idiv, isin, isqrt, normDeg, rngNext, sign } from './fixed.ts';
import { AERIALS, CHARACTERS, MOVE, THROW, type CharacterDef, type CounterDef, type Hitbox, type ShotDef } from './characters.ts';
import type { SpecialKind } from './fighterDefs.ts';
import { BTN, C_ANY, NO_INPUT, stickX, stickY } from './input.ts';
import {
  EV_IDLE,
  EV_RUN,
  EV_WARN,
  STAGES,
  hazardAt,
  ledges,
  platformAt,
  platformOn,
  secs,
  zoneOn,
  type Ledge,
  type StageDef,
  type StageZone,
} from './stage.ts';
import { predictLaunchKo } from '../hitFeel.ts';
import { ACT, SHIELD_MAX, allies, bodySize, newShot, type Fighter, type GameState, type Shot } from './state.ts';

export type SimEvent =
  /** special: the archetype of the special that landed it (a shot is projectile or trap), for the impact sound. Presentation only. */
  | { type: 'hit'; attacker: number; victim: number; x: number; y: number; dmg: number; kb: number; shield: boolean; lag: number; special?: SpecialKind }
  /** A launch begins as hit-stop ends. ko: the launch carries the victim out of the blast zone, so the kill cue plays (hitFeel.ts). Presentation only. */
  | { type: 'launch'; victim: number; by: number; x: number; y: number; ko: boolean }
  | { type: 'ko'; victim: number; by: number; x: number; y: number }
  /** The shared grab caught a fighter (a shielding one too): attacker holds victim. */
  | { type: 'grab'; attacker: number; victim: number; x: number; y: number; shield: boolean; hold: number }
  /** A held fighter was thrown: kind is a THROW index (0 forward, 1 back, 2 up, 3 down). */
  | { type: 'throw'; attacker: number; victim: number; kind: number; x: number; y: number }
  /** A held fighter got out by mashing or when the hold ran out (mashed tells which). */
  | { type: 'grab-break'; attacker: number; victim: number; x: number; y: number; mashed: boolean; held: number }
  | { type: 'jump' | 'land' | 'ledge' | 'shieldbreak' | 'respawn'; id: number; x: number; y: number }
  /** A counter special turned a hit back on its attacker. */
  | { type: 'counter'; id: number; x: number; y: number }
  /** A special put a projectile (kind 0) or a trap (kind 1) in play. */
  | { type: 'shot'; id: number; kind: number; x: number; y: number }
  /** The stage hurt someone: a damage zone or a hazard (index into stage.zones or stage.hazards). */
  | { type: 'hurt'; victim: number; source: 'zone' | 'hazard'; index: number; x: number; y: number; dmg: number; kb: number }
  /** A stage event (index into stage.events) warned, started or ended. */
  | { type: 'stage'; event: number; phase: 'warn' | 'start' | 'end' }
  /** A broadcast event (state.bc[index]) started or ended; who is the fighter a chant is for. */
  | { type: 'broadcast'; index: number; kind: string; phase: 'start' | 'end'; who: number };

/** The four special moves: only these carry an archetype into a hit event. */
const SPECIAL_SLOTS: ReadonlySet<number> = new Set([MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL]);

const BUTTONS = BTN.ATTACK | BTN.SPECIAL | BTN.JUMP | BTN.SHIELD | C_ANY;
export const BUFFER_FRAMES = 6;
export const COYOTE_FRAMES = 6;
const JUMPSQUAT = 3;
// Launch speed per unit of knockback (percent), and how fast that launch decays.
const KB_SPEED = 17;
const KB_DECAY = 300;
export const RESPAWN_DELAY = 70;
/** Frames a successful counter freezes both fighters (the flash plays with it). */
export const COUNTER_FREEZE = 6;

// The stage and frame being stepped. Set at the top of step() and only read
// below it, so the sim stays a pure function of (state, inputs).
let stage: StageDef = STAGES[0];
let frame = 0;
let gravityPct = 100;
let clock: GameState;

interface Ctx {
  inp: number;
  sx: number;
  sy: number;
  psx: number;
  psy: number;
}

export function step(s: GameState, inputs: readonly number[]): SimEvent[] {
  stage = STAGES[s.stage] ?? STAGES[0];
  frame = s.frame;
  gravityPct = s.rules.gravity;
  clock = s;
  pendingGrabs = [];
  const ev: SimEvent[] = [];
  // A commercial break stops play; prevInput is left alone, so presses made during it still register after.
  if (s.freeze > 0) {
    if (--s.freeze === 0) ev.push({ type: 'broadcast', index: s.bc.findIndex((b) => b.kind === 'break'), kind: 'break', phase: 'end', who: 0 });
    return ev;
  }
  advanceEvents(s, ev);
  for (const f of s.fighters) updateFighter(s, f, inputs[f.id] ?? NO_INPUT, ev);
  separate(s);
  resolveHits(s, ev);
  applyGrabs(s, ev);
  stepShots(s, ev);
  stageHits(s, ev);
  for (const f of s.fighters) checkBlastZones(s, f, ev);
  triggerEvents(s, ev);
  broadcastEvents(s, ev);
  checkGameOver(s);
  for (const f of s.fighters) f.prevInput = inputs[f.id] ?? NO_INPUT;
  if (s.endTimer > 0) s.endTimer--;
  s.frame++;
  return ev;
}

// ---------------------------------------------------------------- per fighter

function updateFighter(s: GameState, f: Fighter, inp: number, ev: SimEvent[]): void {
  const ch = CHARACTERS[f.char];

  if (f.action === ACT.DEAD) {
    f.frame++;
    if (f.stocks > 0 && f.frame >= RESPAWN_DELAY && !s.over) respawn(f, ch, ev);
    return;
  }

  const pressed = inp & ~f.prevInput & BUTTONS;
  if (pressed) {
    f.buffer = pressed;
    f.bufferAge = 0;
  } else if (f.buffer && f.hitlag === 0 && ++f.bufferAge > BUFFER_FRAMES) {
    f.buffer = 0;
  }

  if (f.hitlag > 0) {
    f.hitlag--;
    if (f.hitlag === 0 && f.launchSpeed > 0) launch(f, inp, ev);
    return;
  }

  if (f.intangible > 0) f.intangible--;
  if (f.ledgeCooldown > 0) f.ledgeCooldown--;
  if (f.dropThrough > 0) f.dropThrough--;
  if (f.action !== ACT.SHIELD && f.shield < SHIELD_MAX && (s.frame & 1) === 0) f.shield++;
  f.frame++;

  const c: Ctx = { inp, sx: stickX(inp), sy: stickY(inp), psx: stickX(f.prevInput), psy: stickY(f.prevInput) };

  switch (f.action) {
    case ACT.IDLE:
    case ACT.WALK:
    case ACT.CROUCH:
      groundNeutral(f, ch, c);
      break;
    case ACT.JUMPSQUAT:
      if (f.frame >= JUMPSQUAT) {
        const held = (inp & BTN.JUMP) !== 0 || c.sy > 60;
        f.vy = held && !f.shortHop ? ch.jumpVel : ch.shortHopVel;
        f.vx = clamp(f.vx + idiv(c.sx * ch.airAccel * 4, 100), -ch.airSpeed, ch.airSpeed);
        f.grounded = 0;
        f.platform = -1;
        f.jumpsLeft = ch.airJumps;
        setAction(f, ACT.AIR, 0);
        ev.push({ type: 'jump', id: f.id, x: f.x, y: f.y });
      } else if (!(inp & BTN.JUMP)) {
        f.shortHop = 1;
      }
      break;
    case ACT.AIR:
      if (!tryAir(f, ch, c, ev)) {
        drift(f, ch, c, 1);
        fastFall(f, ch, c);
      }
      break;
    case ACT.LAND:
      friction(f, ch);
      if (f.frame >= f.length) finishGround(f, ch, c);
      break;
    case ACT.ATTACK:
      attack(s, f, ch, c, ev);
      break;
    case ACT.HITSTUN:
      if (f.grounded) friction(f, ch);
      else drift(f, ch, c, 2);
      if (--f.hitstun <= 0) {
        if (f.grounded) finishGround(f, ch, c);
        else finishAir(f, ch, c, ev);
      }
      break;
    case ACT.SHIELD:
      shield(f, ch, c, ev);
      break;
    case ACT.SHIELD_STUN:
      friction(f, ch);
      if (f.frame >= f.length) {
        if (f.buffer & (BTN.JUMP | C_ANY | BTN.SPECIAL | BTN.ATTACK)) {
          finishGround(f, ch, c);
        } else if ((inp & BTN.SHIELD) || (f.buffer & BTN.SHIELD)) {
          if (f.buffer & BTN.SHIELD) consume(f);
          setAction(f, ACT.SHIELD, 0);
          shield(f, ch, c, ev);
        } else {
          finishGround(f, ch, c);
        }
      }
      break;
    case ACT.ROLL:
      if (f.frame === 3) f.intangible = 15;
      f.vx = f.frame >= 4 && f.frame <= 20 ? f.dir * 5 * FX : 0;
      if (f.frame >= f.length) {
        f.facing = -f.dir;
        finishGround(f, ch, c);
      }
      break;
    case ACT.SPOTDODGE:
      if (f.frame === 2) f.intangible = 16;
      friction(f, ch);
      if (f.frame >= f.length) finishGround(f, ch, c);
      break;
    case ACT.AIRDODGE:
      if (f.dir) {
        f.vx = idiv(f.vx * 86, 100);
        if (f.frame < 18) f.vy = idiv(f.vy * 86, 100);
      } else {
        drift(f, ch, c, 2);
      }
      if (f.frame >= f.length) finishAir(f, ch, c, ev);
      break;
    case ACT.LEDGE:
      ledge(f, ch, c, ev);
      break;
    case ACT.LEDGE_CLIMB:
      ledgeClimb(f, ch, c);
      break;
    case ACT.HELPLESS:
      drift(f, ch, c, 2);
      break;
    case ACT.DIZZY:
      friction(f, ch);
      if (f.frame >= f.length && f.grounded) finishGround(f, ch, c);
      break;
    case ACT.GRAB:
      grabReach(s, f, ch, c);
      break;
    case ACT.GRAB_HOLD:
      grabHold(s, f, ch, c, ev);
      break;
    case ACT.THROW:
      throwing(s, f, ch, c, ev);
      break;
    case ACT.GRABBED:
      grabbed(s, f, c, pressed, ev);
      break;
    case ACT.RESPAWN:
      f.intangible = 120;
      if (f.frame > 180 || (f.frame > 20 && (Math.abs(c.sx) > 40 || Math.abs(c.sy) > 40 || f.buffer))) {
        finishAir(f, ch, c, ev);
      }
      break;
  }

  if (f.coyote > 0) f.coyote--;

  if (f.action !== ACT.LEDGE && f.action !== ACT.LEDGE_CLIMB && f.action !== ACT.RESPAWN) {
    physics(s, f, ch, c, ev);
  }
}

function setAction(f: Fighter, action: number, length: number): void {
  f.action = action;
  f.frame = 0;
  f.length = length;
  f.coyote = 0;
  if (action !== ACT.ATTACK) f.move = -1;
  if (action === ACT.JUMPSQUAT) f.shortHop = 0;
}

function finishGround(f: Fighter, ch: CharacterDef, c: Ctx): void {
  setAction(f, ACT.IDLE, 0);
  groundNeutral(f, ch, c);
}

function finishAir(f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  setAction(f, ACT.AIR, 0);
  if (!tryAir(f, ch, c, ev)) {
    drift(f, ch, c, 1);
    fastFall(f, ch, c);
  }
}

function consume(f: Fighter): number {
  const b = f.buffer;
  f.buffer = 0;
  return b;
}

// ------------------------------------------------------------------- ground

function groundNeutral(f: Fighter, ch: CharacterDef, c: Ctx): void {
  if (tryGround(f, ch, c)) return;

  const onThin = f.platform >= 0 && !stage.platforms[f.platform].solid;
  if (onThin && c.sy < -65 && c.psy >= -65) {
    f.grounded = 0;
    f.platform = -1;
    f.dropThrough = 10;
    f.jumpsLeft = ch.airJumps;
    setAction(f, ACT.AIR, 0);
    return;
  }

  if (c.sy < -60) {
    if (f.action !== ACT.CROUCH) setAction(f, ACT.CROUCH, 0);
    friction(f, ch);
  } else if (Math.abs(c.sx) > 20) {
    if (f.action !== ACT.WALK) setAction(f, ACT.WALK, 0);
    f.facing = sign(c.sx);
    f.vx = approach(f.vx, idiv(c.sx * ch.walkSpeed, 100), ch.groundAccel);
  } else {
    if (f.action !== ACT.IDLE) setAction(f, ACT.IDLE, 0);
    friction(f, ch);
  }
}

function tryGround(f: Fighter, ch: CharacterDef, c: Ctx): boolean {
  const b = f.buffer;
  if (b & BTN.JUMP) {
    consume(f);
    setAction(f, ACT.JUMPSQUAT, JUMPSQUAT);
    return true;
  }
  // Shield and Attack together (keyboard L+J, pad trigger+A, touch Shield+Attack) are the grab.
  if (b & (BTN.ATTACK | BTN.SHIELD) && ((b | c.inp) & BTN.ATTACK) && ((b | c.inp) & BTN.SHIELD)) {
    consume(f);
    startGrab(f);
    return true;
  }
  if (b & C_ANY) {
    consume(f);
    const dir = cDirection(b, c);
    if (dir === 'up') startMove(f, ch, MOVE.USMASH);
    else if (dir === 'down') startMove(f, ch, MOVE.DSMASH);
    else {
      if (dir === 'left' || dir === 'right') f.facing = dir === 'left' ? -1 : 1;
      startMove(f, ch, MOVE.FSMASH);
    }
    return true;
  }
  if (b & BTN.SPECIAL) {
    consume(f);
    if (Math.abs(c.sx) > 40) f.facing = sign(c.sx);
    startMove(f, ch, specialMove(ch, c));
    return true;
  }
  if (b & BTN.ATTACK) {
    consume(f);
    if (c.sy > 50) startMove(f, ch, MOVE.UTILT);
    else if (c.sy < -50) startMove(f, ch, MOVE.DTILT);
    else if (Math.abs(c.sx) > 40) {
      f.facing = sign(c.sx);
      startMove(f, ch, MOVE.FTILT);
    } else startMove(f, ch, MOVE.JAB);
    return true;
  }
  if ((b & BTN.SHIELD) || (c.inp & BTN.SHIELD)) {
    if (b & BTN.SHIELD) consume(f);
    setAction(f, ACT.SHIELD, 0);
    return true;
  }
  return false;
}

function shield(f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  friction(f, ch);
  if (f.buffer & BTN.JUMP) {
    consume(f);
    setAction(f, ACT.JUMPSQUAT, JUMPSQUAT);
    return;
  }
  // Attack out of shield is the grab.
  if (f.buffer & BTN.ATTACK) {
    consume(f);
    startGrab(f);
    return;
  }
  if (Math.abs(c.sx) > 60 && Math.abs(c.psx) <= 60) {
    f.dir = sign(c.sx);
    f.facing = f.dir;
    setAction(f, ACT.ROLL, 30);
    return;
  }
  if (c.sy < -60 && c.psy >= -60) {
    setAction(f, ACT.SPOTDODGE, 24);
    return;
  }
  if (!(c.inp & BTN.SHIELD)) {
    if (f.frame > 3) setAction(f, ACT.LAND, 7);
    return;
  }
  f.shield--;
  if (f.shield <= 0) breakShield(f, ev);
}

function breakShield(f: Fighter, ev: SimEvent[]): void {
  f.shield = 300;
  f.vy = 14 * FX;
  setAction(f, ACT.DIZZY, 200);
  ev.push({ type: 'shieldbreak', id: f.id, x: f.x, y: f.y });
}

function friction(f: Fighter, ch: CharacterDef): void {
  f.vx = approach(f.vx, 0, ch.groundFriction);
}

// ---------------------------------------------------------------------- air

function tryAir(f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): boolean {
  const b = f.buffer;
  if (b & BTN.JUMP && (f.coyote > 0 || f.jumpsLeft > 0)) {
    consume(f);
    if (f.coyote > 0) {
      f.coyote = 0;
      f.jumpsLeft = ch.airJumps;
      f.vy = ch.jumpVel;
      f.vx = clamp(f.vx + idiv(c.sx * ch.airAccel * 4, 100), -ch.airSpeed, ch.airSpeed);
    } else {
      f.jumpsLeft--;
      f.vy = ch.airJumpVel;
      f.vx = idiv(c.sx * ch.airSpeed, 100);
    }
    f.fastFall = 0;
    ev.push({ type: 'jump', id: f.id, x: f.x, y: f.y });
    return false;
  }
  if (b & BTN.SPECIAL) {
    consume(f);
    if (Math.abs(c.sx) > 40) f.facing = sign(c.sx);
    startMove(f, ch, specialMove(ch, c));
    return true;
  }
  if (b & (BTN.ATTACK | C_ANY)) {
    consume(f);
    const dir = b & C_ANY ? cDirection(b, c) : stickDirection(c);
    let move: number = MOVE.NAIR;
    if (dir === 'up') move = MOVE.UAIR;
    else if (dir === 'down') move = MOVE.DAIR;
    else if (dir === 'left' || dir === 'right') move = (dir === 'right' ? 1 : -1) === f.facing ? MOVE.FAIR : MOVE.BAIR;
    startMove(f, ch, move);
    return true;
  }
  if (b & BTN.SHIELD && !f.airdodgeUsed) {
    consume(f);
    airdodge(f, c);
    return true;
  }
  return false;
}

function airdodge(f: Fighter, c: Ctx): void {
  f.airdodgeUsed = 1;
  f.fastFall = 0;
  f.intangible = 26;
  if (Math.abs(c.sx) + Math.abs(c.sy) > 50) {
    const a = iatan2(c.sy, c.sx);
    f.dir = 1;
    f.vx = idiv(icos(a) * 15 * FX, TRIG_ONE);
    f.vy = idiv(isin(a) * 15 * FX, TRIG_ONE);
    setAction(f, ACT.AIRDODGE, 34);
  } else {
    f.dir = 0;
    setAction(f, ACT.AIRDODGE, 40);
  }
}

function drift(f: Fighter, ch: CharacterDef, c: Ctx, weak: number): void {
  if (Math.abs(c.sx) > 15) {
    f.vx = approach(f.vx, idiv(c.sx * ch.airSpeed, 100), idiv(ch.airAccel, weak));
  } else {
    f.vx = approach(f.vx, 0, ch.airFriction);
  }
}

function fallSpeed(ch: CharacterDef, fast: boolean): number {
  // Low gravity also slows the fall, but by half as much, so floaty rules stay playable.
  const base = fast ? ch.fastFallSpeed : ch.fallSpeed;
  return idiv(base * (100 + gravityPct), 200);
}

function fastFall(f: Fighter, ch: CharacterDef, c: Ctx): void {
  if (!f.fastFall && f.vy <= 0 && c.sy < -65 && c.psy >= -65) {
    f.fastFall = 1;
    f.vy = -fallSpeed(ch, true);
  }
}

type Dir = 'up' | 'down' | 'left' | 'right' | 'neutral';

function stickDirection(c: Ctx): Dir {
  const ax = Math.abs(c.sx);
  const ay = Math.abs(c.sy);
  if (ax < 40 && ay < 40) return 'neutral';
  if (ay >= ax) return c.sy > 0 ? 'up' : 'down';
  return c.sx > 0 ? 'right' : 'left';
}

function cDirection(b: number, c: Ctx): Dir {
  if (b & BTN.C_UP) return 'up';
  if (b & BTN.C_DOWN) return 'down';
  if (b & BTN.C_LEFT) return 'left';
  if (b & BTN.C_RIGHT) return 'right';
  return stickDirection(c);
}

// ------------------------------------------------------------------ attacks

/**
 * Which special the stick picks. Fighters with their own specials get four (up, down, side, neutral);
 * everyone else keeps the shared Up and Neutral special whatever the stick does sideways or down.
 */
function specialMove(ch: CharacterDef, c: Ctx): number {
  if (c.sy > 50) return MOVE.UPB;
  if (!ch.specials) return MOVE.NSPECIAL;
  if (c.sy < -50) return MOVE.DSPECIAL;
  if (Math.abs(c.sx) > 40) return MOVE.SSPECIAL;
  return MOVE.NSPECIAL;
}

function startMove(f: Fighter, ch: CharacterDef, move: number): void {
  setAction(f, ACT.ATTACK, ch.moves[move].total);
  f.move = move;
  f.hitMask = 0;
  if (ch.moves[move].airLimited && !f.grounded) f.airSpecial++;
}

function attack(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  const m = ch.moves[f.move];
  const spent = m.airLimited === true && f.airSpecial > 1;
  for (const imp of m.impulses ?? []) {
    if (imp.frame !== f.frame || spent) continue;
    if (imp.vx !== null) f.vx = f.facing * imp.vx * FX + (imp.steer ? idiv(c.sx * imp.steer * FX, 100) : 0);
    if (imp.vy !== null) {
      f.vy = imp.vy * FX;
      f.fastFall = 0;
    }
  }
  // A drive holds the fighter's velocity for a run of frames (a dash, a recovery's climb or glide).
  let driving = false;
  if (!spent) {
    for (const d of m.drive ?? []) {
      if (f.frame < d.from || f.frame > d.to) continue;
      driving = true;
      if (d.aim !== undefined) {
        // Angled: the stick aims it when the move starts; neutral goes the way the fighter faces.
        if (f.frame === d.from && Math.abs(c.sx) > 20) f.facing = sign(c.sx);
        f.vx = f.facing * d.aim;
      } else if (d.vx !== null) {
        f.vx = f.facing * d.vx + (d.steer ? idiv(c.sx * d.steer, 100) : 0);
      }
      if (d.vy !== null) {
        f.vy = d.vy;
        f.fastFall = 0;
      }
    }
  }
  for (const w of m.hits) if (w.rehit && f.frame === w.start) f.hitMask = 0;
  if (m.shot && f.frame === m.shot.frame && !spent) spawnShot(s, f, m.shot, ev);
  if (f.grounded) {
    // Grounded attacks keep walking while the stick is held sideways, instead of stopping dead.
    if (driving) {
      // The drive owns the speed.
    } else if (m.drive) f.vx = approach(f.vx, 0, ch.groundFriction * 3);
    else if (m.impulses) f.vx = approach(f.vx, 0, idiv(ch.groundFriction, 2));
    else if (m.kind) friction(f, ch);
    else if (Math.abs(c.sx) > 20) f.vx = approach(f.vx, idiv(c.sx * ch.walkSpeed, 100), ch.groundAccel);
    else friction(f, ch);
  } else if (AERIALS.has(f.move)) {
    drift(f, ch, c, 1);
    fastFall(f, ch, c);
  } else if (!driving) {
    drift(f, ch, c, 3);
  }
  if (f.frame >= f.length) {
    if (m.helpless && !f.grounded) setAction(f, ACT.HELPLESS, 0);
    else if (f.grounded) finishGround(f, ch, c);
    else finishAir(f, ch, c, ev);
  }
}

/** World-space hitboxes active this frame, for the hit check and the debug view. */
export function activeHitboxes(f: Fighter): { x: number; y: number; r: number; box: Hitbox }[] {
  if (f.action !== ACT.ATTACK) return [];
  const m = CHARACTERS[f.char].moves[f.move];
  const out: { x: number; y: number; r: number; box: Hitbox }[] = [];
  const k = f.scale * FX;
  for (const w of m.hits) {
    if (f.frame < w.start || f.frame > w.end) continue;
    for (const box of w.boxes) {
      out.push({
        x: f.x + f.facing * idiv(box.x * k, 100),
        y: f.y + idiv(box.y * k, 100),
        r: idiv(box.r * k, 100),
        box,
      });
    }
  }
  return out;
}

function hittable(f: Fighter): boolean {
  return f.intangible === 0 && f.action !== ACT.DEAD && f.action !== ACT.RESPAWN && f.action !== ACT.LEDGE_CLIMB;
}

function resolveHits(s: GameState, ev: SimEvent[]): void {
  // Collect every hit first and apply them after, so trades land on both
  // fighters and the result does not depend on who is checked first.
  const hits: { a: Fighter; v: Fighter; box: Hitbox; x: number; y: number }[] = [];
  for (const a of s.fighters) {
    if (a.hitlag > 0) continue;
    const boxes = activeHitboxes(a);
    if (!boxes.length) continue;
    for (const v of s.fighters) {
      if (v === a || a.hitMask & (1 << v.id) || !hittable(v) || allies(a, v)) continue;
      const [w, h] = bodySize(v);
      const half = w >> 1;
      const top = v.y + h;
      for (const hb of boxes) {
        // A command grab needs the other fighter on the same floor.
        if (hb.box.grab && !(v.grounded && a.grounded && v.platform === a.platform)) continue;
        const px = clamp(hb.x, v.x - half, v.x + half);
        const py = clamp(hb.y, v.y, top);
        const dx = hb.x - px;
        const dy = hb.y - py;
        if (dx * dx + dy * dy <= hb.r * hb.r) {
          hits.push({ a, v, box: hb.box, x: (hb.x + px) >> 1, y: (hb.y + py) >> 1 });
          break;
        }
      }
    }
  }
  for (const h of hits) applyHit(s, h.a, h.v, h.box, h.x, h.y, ev);
}

// ---------------------------------------------------------------- grab and throws
//
// Shield and Attack together reach out with the jab's reach. A grab beats a shield (the shield is not
// touched) and loses to an attack: a hit that lands on the grabber the same frame ends the reach (hits are
// applied before grabs). The held fighter is pinned in front; the hold lasts longer as their damage rises
// and each mash (a fresh button press or stick flick) shortens it. The holder throws with the stick:
// forward, back, up or down, each with its own damage, angle and knockback (ch.throws).

export const GRAB_TOTAL = 30;
export const GRAB_FIRST = 5;
export const GRAB_LAST = 8;
/** Fastest the holder can throw, so a stick already held when the grab connects still reads as a grab. */
const THROW_FROM = 8;
const HOLD_BASE = 40;
const HOLD_MAX = 240;
/** Frames one mash takes off the hold. */
const MASH_CUT = 4;
/** Frames of hit-stop when the grab connects. */
const GRAB_LAG = 6;

/** The hold's length for a victim at this damage (tenths of a percent): 40 frames at 0%, 100 at 100%. */
export function holdFrames(percent: number): number {
  return Math.min(HOLD_MAX, HOLD_BASE + idiv(percent * 6, 100));
}

function startGrab(f: Fighter): void {
  setAction(f, ACT.GRAB, GRAB_TOTAL);
  f.holding = 0;
}

function grabbable(g: Fighter, v: Fighter): boolean {
  if (v === g || allies(g, v) || !hittable(v) || !v.grounded || !g.grounded || v.platform !== g.platform) return false;
  return v.action !== ACT.HITSTUN && v.action !== ACT.GRABBED && v.action !== ACT.GRAB_HOLD && v.action !== ACT.THROW;
}

/** The grab's reach: the jab's, from the grabber's feet forward. */
function grabReachBox(g: Fighter): [number, number] {
  const reach = idiv(CHARACTERS[g.char].grabReach * g.scale * FX, 100);
  return g.facing > 0 ? [g.x - 6 * FX, g.x + reach] : [g.x - reach, g.x + 6 * FX];
}

function grabReach(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx): void {
  friction(f, ch);
  if (f.frame >= GRAB_FIRST && f.frame <= GRAB_LAST) {
    const [lo, hi] = grabReachBox(f);
    for (const v of s.fighters) {
      if (!grabbable(f, v)) continue;
      const half = bodySize(v)[0] >> 1;
      if (v.x + half < lo || v.x - half > hi) continue;
      // Two grabs that reach each other cancel out.
      if (v.action === ACT.GRAB && v.frame >= GRAB_FIRST && v.frame <= GRAB_LAST) {
        const [vlo, vhi] = grabReachBox(v);
        const gh = bodySize(f)[0] >> 1;
        if (f.x + gh >= vlo && f.x - gh <= vhi) continue;
      }
      pendingGrabs.push([f, v]);
      break;
    }
  }
  if (f.frame >= f.length) finishGround(f, ch, c);
}

/** Grabs that connected this frame, applied after the hits so an attack beats a grab. */
let pendingGrabs: [Fighter, Fighter][] = [];

function applyGrabs(s: GameState, ev: SimEvent[]): void {
  const list = pendingGrabs;
  pendingGrabs = [];
  for (const [g, v] of list) {
    // A hit that landed this frame already took the grabber out of its reach; and a fighter two grabs reach is held once.
    if (g.action !== ACT.GRAB || !grabbable(g, v)) continue;
    const hold = holdFrames(v.percent);
    const shield = v.action === ACT.SHIELD || v.action === ACT.SHIELD_STUN;
    g.holding = v.id + 1;
    v.heldBy = g.id + 1;
    v.vx = v.vy = v.kbx = v.kby = 0;
    v.buffer = 0;
    v.dir = 0;
    v.fastFall = 0;
    v.facing = g.x < v.x ? -1 : 1;
    setAction(v, ACT.GRABBED, 0);
    setAction(g, ACT.GRAB_HOLD, hold);
    g.facing = v.x < g.x ? -1 : 1;
    pinHeld(g, v);
    g.hitlag = v.hitlag = GRAB_LAG;
    ev.push({ type: 'grab', attacker: g.id, victim: v.id, x: (g.x + v.x) >> 1, y: g.y + (bodySize(g)[1] >> 1), shield, hold });
  }
}

/** Where the held fighter stands: just in front of the holder, kept on the floor they share. */
function pinHeld(g: Fighter, v: Fighter): void {
  const gap = (bodySize(g)[0] >> 1) + (bodySize(v)[0] >> 1) - 8 * FX;
  let x = g.x + g.facing * Math.max(gap, 16 * FX);
  if (g.platform >= 0) {
    const p = platformAt(stage.platforms[g.platform], frame);
    x = clamp(x, p.x1 * FX, p.x2 * FX);
  }
  v.x = x;
  v.y = g.y;
  v.vx = v.vy = 0;
}

function heldVictim(s: GameState, f: Fighter): Fighter | null {
  const v = f.holding ? s.fighters[f.holding - 1] : null;
  return v && v.action === ACT.GRABBED && v.heldBy === f.id + 1 ? v : null;
}

function release(f: Fighter, v: Fighter | null): void {
  f.holding = 0;
  f.throwKind = 0;
  if (v && v.heldBy === f.id + 1) v.heldBy = 0;
}

function grabHold(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  friction(f, ch);
  const v = heldVictim(s, f);
  if (!v) {
    release(f, null);
    finishGround(f, ch, c);
    return;
  }
  if (f.frame >= f.length) {
    // The hold is over: the victim wriggles free (sooner when they mashed).
    ev.push({ type: 'grab-break', attacker: f.id, victim: v.id, x: v.x, y: v.y, mashed: v.dir > 0, held: f.frame });
    release(f, v);
    setAction(v, ACT.IDLE, 0);
    v.vx = (sign(v.x - f.x) || 1) * 3 * FX;
    v.intangible = 8;
    setAction(f, ACT.LAND, 10);
    return;
  }
  if (f.frame < THROW_FROM) return;
  const b = f.buffer;
  const dir = b & C_ANY ? cDirection(b, c) : stickDirection(c);
  if (dir === 'neutral' && !(b & (BTN.ATTACK | C_ANY))) return;
  consume(f);
  let kind: number = THROW.FORWARD;
  if (dir === 'up') kind = THROW.UP;
  else if (dir === 'down') kind = THROW.DOWN;
  else if (dir === 'left' || dir === 'right') kind = (dir === 'right' ? 1 : -1) === f.facing ? THROW.FORWARD : THROW.BACK;
  f.throwKind = kind + 1;
  setAction(f, ACT.THROW, ch.throws[kind].total);
}

function throwing(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  friction(f, ch);
  const t = ch.throws[Math.max(0, f.throwKind - 1)];
  const v = heldVictim(s, f);
  if (f.frame === t.release && v) {
    const kind = f.throwKind - 1;
    const [, vh] = bodySize(v);
    if (kind === THROW.BACK) {
      v.x = f.x - f.facing * Math.max((bodySize(f)[0] >> 1) + (bodySize(v)[0] >> 1) - 8 * FX, 16 * FX);
      if (f.platform >= 0) {
        const p = platformAt(stage.platforms[f.platform], frame);
        v.x = clamp(v.x, p.x1 * FX, p.x2 * FX);
      }
    }
    release(f, v);
    f.throwKind = kind + 1;
    ev.push({ type: 'throw', attacker: f.id, victim: v.id, kind, x: v.x, y: v.y + (vh >> 1) });
    const box: Hitbox = { x: 0, y: 0, r: 0, dmg: t.dmg, angle: t.angle, bkb: t.bkb, kbg: t.kbg };
    applyHit(s, f, v, box, v.x, v.y + (vh >> 1), ev, { facing: f.facing });
  } else if (!v && f.frame < t.release) {
    // The held fighter was taken from us (hit by a third fighter): nothing to throw.
    release(f, null);
    finishGround(f, ch, c);
    return;
  }
  if (f.frame >= f.length) {
    f.throwKind = 0;
    finishGround(f, ch, c);
  }
}

function grabbed(s: GameState, f: Fighter, c: Ctx, pressed: number, ev: SimEvent[]): void {
  const a = f.heldBy ? s.fighters[f.heldBy - 1] : null;
  if (!a || a.holding !== f.id + 1 || (a.action !== ACT.GRAB_HOLD && a.action !== ACT.THROW)) {
    // Let go of (the holder was hit, or the hold ended another way).
    f.heldBy = 0;
    setAction(f, ACT.IDLE, 0);
    return;
  }
  f.buffer = 0;
  if (a.action === ACT.GRAB_HOLD) {
    const flick = (Math.abs(c.sx) > 60 && Math.abs(c.psx) <= 60) || (Math.abs(c.sy) > 60 && Math.abs(c.psy) <= 60);
    if (pressed || flick) {
      // Mashing: each press takes frames off the hold (never the one it is on).
      a.length = Math.max(a.frame + 1, a.length - MASH_CUT);
      f.dir++;
    }
  }
  pinHeld(a, f);
}

// -------------------------------------------------------------------- shots

/** A special's projectile or trap appears. At the fighter's limit a trap replaces the old one; a projectile waits. */
function spawnShot(s: GameState, f: Fighter, d: ShotDef, ev: SimEvent[]): void {
  // A trap needs a floor under it; in the air the move is only a whiff.
  if (d.kind === 1 && (!f.grounded || f.platform < 0)) return;
  let mine = 0;
  let oldest = -1;
  for (let i = 0; i < s.shots.length; i++) {
    const o = s.shots[i];
    if (o.owner !== f.id || o.kind !== d.kind) continue;
    mine++;
    if (oldest < 0) oldest = i;
  }
  if (mine >= d.max) {
    if (d.kind !== 1) return;
    s.shots.splice(oldest, 1);
  }
  const o = newShot();
  o.kind = d.kind;
  o.owner = f.id;
  o.facing = f.facing;
  o.x = f.x + f.facing * idiv(d.x * f.scale * FX, 100);
  o.y = f.y + idiv(d.y * f.scale * FX, 100);
  if (d.kind === 1) {
    const p = platformAt(stage.platforms[f.platform], frame);
    o.x = clamp(o.x, p.x1 * FX, p.x2 * FX);
    o.y = p.y;
    o.plat = f.platform;
  }
  o.vx = f.facing * d.vx;
  o.vy = d.vy;
  o.g = d.g;
  o.life = d.life;
  o.arm = d.arm;
  o.r = idiv(d.r * f.scale * FX, 100);
  o.dmg = d.dmg;
  o.angle = d.angle;
  o.bkb = d.bkb;
  o.kbg = d.kbg;
  o.style = d.style;
  s.shots.push(o);
  ev.push({ type: 'shot', id: f.id, kind: d.kind, x: o.x, y: o.y });
}

/** Moves every projectile and trap, then lets each hit the first fighter it touches (and vanish) or run out. */
function stepShots(s: GameState, ev: SimEvent[]): void {
  if (!s.shots.length) return;
  const b = stage.blast;
  const keep: Shot[] = [];
  for (const o of s.shots) {
    o.age++;
    o.life--;
    if (o.arm > 0) o.arm--;
    if (o.kind === 0) {
      o.vy -= o.g;
      o.x += o.vx;
      o.y += o.vy;
    } else if (o.plat >= 0) {
      // A trap rides its floor, and goes with it when an event switches the floor off.
      if (!platformOn(stage, s, o.plat)) continue;
      const p = stage.platforms[o.plat];
      if (p.motion) {
        const now = platformAt(p, frame);
        o.x += now.x1 - platformAt(p, frame - 1).x1;
        o.y = now.y;
      }
    }
    if (o.life <= 0 || o.x < b.left * FX || o.x > b.right * FX || o.y < b.bottom * FX || o.y > b.top * FX) continue;
    if (o.kind === 0 && inSolid(s, o)) continue;
    if (shotHit(s, o, ev)) continue;
    keep.push(o);
  }
  s.shots = keep;
}

/** A projectile that runs into a solid block (a wall or the underside of the stage) stops there. */
function inSolid(s: GameState, o: Shot): boolean {
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid || !platformOn(stage, s, i)) continue;
    const top = p.y * FX;
    if (o.x > p.x1 * FX && o.x < p.x2 * FX && o.y < top && o.y > top - (p.depth ?? 90) * FX) return true;
  }
  return false;
}

/** Whether the shot hit someone this frame (it is spent if so). */
function shotHit(s: GameState, o: Shot, ev: SimEvent[]): boolean {
  if (o.kind === 1 && o.arm > 0) return false;
  const owner = s.fighters[o.owner];
  for (const v of s.fighters) {
    if (v.id === o.owner || !hittable(v) || (owner && allies(owner, v))) continue;
    const [w, h] = bodySize(v);
    const half = w >> 1;
    const px = clamp(o.x, v.x - half, v.x + half);
    const py = clamp(o.y, v.y, v.y + h);
    const dx = o.x - px;
    const dy = o.y - py;
    if (dx * dx + dy * dy > o.r * o.r) continue;
    const box: Hitbox = { x: 0, y: 0, r: 0, dmg: o.dmg, angle: o.angle, bkb: o.bkb, kbg: o.kbg };
    applyHit(s, owner, v, box, (o.x + px) >> 1, (o.y + py) >> 1, ev, { facing: o.facing, shot: true, shotKind: o.kind === 1 ? 'trap' : 'projectile' });
    return true;
  }
  return false;
}

export function knockback(percent: number, dmg: number, weight: number, bkb: number, kbg: number): number {
  // The familiar platform-fighter curve, in thousandths:
  // ((p/10 + p*d/20) * 200/(w+100) * 1.4 + 18) * kbg/100 + bkb
  const a = percent * 10 + idiv(percent * dmg, 2);
  const b = idiv(a * 280, weight + 100) + 18000;
  return idiv(b * kbg, 100) + bkb * 1000;
}

/** Where a hit comes from when it isn't the attacker's own body: a shot flies its own way and doesn't freeze its owner. */
interface Via {
  facing: number;
  shot?: boolean;
  /** Archetype of the shot (projectile or trap). */
  shotKind?: SpecialKind;
  counter?: boolean;
}

/** The counter window a fighter is in, if any. */
function counterWindow(v: Fighter): CounterDef | null {
  if (v.action !== ACT.ATTACK) return null;
  const cd = CHARACTERS[v.char].moves[v.move].counter;
  return cd && v.frame >= cd.from && v.frame <= cd.to ? cd : null;
}

function applyHit(s: GameState, a: Fighter, v: Fighter, box: Hitbox, x: number, y: number, ev: SimEvent[], via?: Via): void {
  const facing = via?.facing ?? a.facing;
  if (!via?.shot) a.hitMask |= 1 << v.id;
  const cw = via?.counter || box.grab ? null : counterWindow(v);
  if (cw) {
    // The hit is turned back: the countering fighter takes nothing, the attacker takes it with interest.
    const back = Math.max(cw.box.dmg, idiv(box.dmg * cw.mult, 100));
    v.frame = Math.max(v.frame, cw.to + 1);
    ev.push({ type: 'counter', id: v.id, x, y });
    applyHit(s, v, a, { ...cw.box, dmg: back }, x, y, ev, { facing: v.facing, counter: true });
    // A parry freezes both fighters for at least 6 frames, on the frame of the parry (the flash plays with it).
    a.hitlag = Math.max(a.hitlag, COUNTER_FREEZE);
    v.hitlag = Math.max(v.hitlag, COUNTER_FREEZE);
    return;
  }
  const dmg = idiv(box.dmg * s.rules.damage, 100);
  const special = via?.shot ? via.shotKind : a.action === ACT.ATTACK && SPECIAL_SLOTS.has(a.move) ? CHARACTERS[a.char].moves[a.move].kind : undefined;
  // Hit-stop scales with damage: a jab freezes 3 frames, a smash 8 or more (at most 14).
  const lag = Math.min(14, 3 + idiv(dmg, 25));
  if (!via?.shot) a.hitlag = lag;
  v.hitlag = lag;

  if (!box.grab && (v.action === ACT.SHIELD || v.action === ACT.SHIELD_STUN)) {
    v.shield -= dmg;
    ev.push({ type: 'hit', attacker: a.id, victim: v.id, x, y, dmg, kb: 0, shield: true, lag, special });
    if (v.shield <= 0) {
      breakShield(v, ev);
    } else {
      setAction(v, ACT.SHIELD_STUN, 3 + idiv(dmg * 5, 100));
      v.vx = (sign(v.x - a.x) || facing) * idiv(dmg * FX, 15);
    }
    return;
  }

  const vc = CHARACTERS[v.char];
  v.percent = Math.min(v.percent + dmg, 9999);
  a.damageDealt += dmg;
  // Giants are heavier in proportion to their size.
  const weight = idiv(vc.weight * v.scale, 100);
  const kb = knockback(v.percent, dmg, weight, box.bkb, box.kbg);
  v.launchSpeed = idiv(kb * KB_SPEED, 100);
  v.launchAngle = normDeg(facing > 0 ? box.angle : 180 - box.angle);
  v.hitstun = idiv(kb * 4, 10000);
  setAction(v, ACT.HITSTUN, 0);
  v.vx = 0;
  v.vy = 0;
  v.kbx = 0;
  v.kby = 0;
  v.fastFall = 0;
  v.airSpecial = 0;
  v.ledge = 0;
  v.buffer = 0;
  v.facing = via?.shot ? -facing : a.x < v.x ? -1 : 1;
  if (box.grab) v.x = a.x + facing * idiv((box.pull ?? 0) * a.scale * FX, 100);
  v.lastHitBy = a.id;
  ev.push({ type: 'hit', attacker: a.id, victim: v.id, x, y, dmg, kb: idiv(kb, 1000), shield: false, lag, special });
}

/** Applies a stored launch once hitlag ends, bent by the victim's stick (DI). */
function launch(f: Fighter, inp: number, ev: SimEvent[]): void {
  let a = f.launchAngle;
  const sx = stickX(inp);
  const sy = stickY(inp);
  if (Math.abs(sx) + Math.abs(sy) > 30) {
    // Holding perpendicular to the launch bends it by up to 15 degrees.
    const perp = idiv(-isin(a) * sx + icos(a) * sy, TRIG_ONE);
    a = normDeg(a + idiv(perp * 15, 100));
  }
  f.kbx = idiv(icos(a) * f.launchSpeed, TRIG_ONE);
  f.kby = idiv(isin(a) * f.launchSpeed, TRIG_ONE);
  f.launchSpeed = 0;
  if (f.grounded) {
    // A downward hit on the ground bounces the fighter up off it.
    if (f.kby < 0) f.kby = -idiv(f.kby * 8, 10);
    if (f.kby > 0) {
      f.grounded = 0;
      f.platform = -1;
    }
  }
  const vc = CHARACTERS[f.char];
  const ko = predictLaunchKo({
    x: f.x,
    y: f.y,
    kx: f.kbx,
    ky: f.kby,
    gravity: idiv(vc.gravity * gravityPct, 100),
    fallSpeed: fallSpeed(vc, false),
    blast: stage.blast,
    drift: idiv(vc.airSpeed * 3, 4),
    floors: stage.platforms.map((p) => ({ x1: p.x1, x2: p.x2, y: p.y, depth: p.solid ? (p.depth ?? 100) : undefined })),
  });
  ev.push({ type: 'launch', victim: f.id, by: f.lastHitBy, x: f.x, y: f.y, ko });
}

// -------------------------------------------------------------------- ledge

/** The ledge a fighter holds. f.ledge is its index plus one, so 0 means none. */
function heldLedge(f: Fighter): Ledge {
  return ledges(stage)[f.ledge - 1];
}

function hangPosition(f: Fighter): [number, number] {
  const l = heldLedge(f);
  const [w, h] = bodySize(f);
  return [l.x * FX + l.side * (w >> 1), l.y * FX - h + 20 * FX];
}

function ledge(f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  if (!platformOn(stage, clock, heldLedge(f).platform)) {
    leaveLedge(f, 30);
    return;
  }
  [f.x, f.y] = hangPosition(f);
  if (f.frame < 8) return;
  const toward = -heldLedge(f).side;
  if (f.buffer & BTN.JUMP) {
    consume(f);
    leaveLedge(f, 20);
    f.vy = ch.jumpVel;
    f.vx = toward * 2 * FX;
    ev.push({ type: 'jump', id: f.id, x: f.x, y: f.y });
  } else if (c.sy > 60 || c.sx * toward > 60 || f.buffer & (BTN.ATTACK | BTN.SPECIAL | BTN.SHIELD)) {
    consume(f);
    setAction(f, ACT.LEDGE_CLIMB, 22);
    f.intangible = 22;
  } else if (c.sy < -60 || c.sx * toward < -60 || f.frame > 300) {
    leaveLedge(f, 30);
    f.x -= toward * 4 * FX;
  }
}

function leaveLedge(f: Fighter, cooldown: number): void {
  f.ledge = 0;
  f.ledgeCooldown = cooldown;
  f.grounded = 0;
  f.platform = -1;
  setAction(f, ACT.AIR, 0);
}

function ledgeClimb(f: Fighter, ch: CharacterDef, c: Ctx): void {
  const l = heldLedge(f);
  if (!platformOn(stage, clock, l.platform)) {
    leaveLedge(f, 30);
    return;
  }
  const [hx, hy] = hangPosition(f);
  const [w] = bodySize(f);
  const top = l.y * FX;
  const endX = l.x * FX - l.side * ((w >> 1) + 6 * FX);
  if (f.frame <= 11) {
    f.x = hx;
    f.y = hy + idiv((top - hy) * f.frame, 11);
  } else {
    f.y = top;
    f.x = hx + idiv((endX - hx) * (f.frame - 11), 11);
  }
  if (f.frame >= f.length) {
    f.x = endX;
    f.y = top;
    f.ledge = 0;
    f.ledgeCooldown = 10;
    f.grounded = 1;
    f.platform = l.platform;
    f.vx = 0;
    f.vy = 0;
    finishGround(f, ch, c);
  }
}

function tryGrabLedge(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  if (f.ledgeCooldown > 0 || c.sy < -60) return;
  const m = f.action === ACT.ATTACK ? ch.moves[f.move] : null;
  const canGrab =
    f.action === ACT.AIR ||
    f.action === ACT.HELPLESS ||
    f.action === ACT.AIRDODGE ||
    (m !== null && m.ledgeFrom !== undefined && f.frame >= m.ledgeFrom);
  if (!canGrab) return;
  if (f.vy + f.kby > 0 && m === null) return;

  const [w, h] = bodySize(f);
  const half = w >> 1;
  const all = ledges(stage);
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (!platformOn(stage, s, l.platform)) continue;
    const lx = l.x * FX;
    const ly = l.y * FX;
    // Only from the outside of the edge.
    if (l.side * (f.x - lx) < -half) continue;
    const hangX = lx + l.side * half;
    const top = f.y + h - ly;
    if (Math.abs(f.x - hangX) > 45 * FX || top < -25 * FX || top > 70 * FX) continue;
    if (s.fighters.some((o) => o !== f && (o.action === ACT.LEDGE || o.action === ACT.LEDGE_CLIMB) && o.ledge === i + 1)) continue;

    f.ledge = i + 1;
    f.facing = -l.side;
    f.vx = f.vy = f.kbx = f.kby = 0;
    f.jumpsLeft = ch.airJumps;
    f.airdodgeUsed = 0;
    f.airSpecial = 0;
    f.fastFall = 0;
    f.intangible = 30;
    setAction(f, ACT.LEDGE, 0);
    [f.x, f.y] = hangPosition(f);
    ev.push({ type: 'ledge', id: f.id, x: f.x, y: f.y });
    return;
  }
}

// ------------------------------------------------------------------ physics

function physics(s: GameState, f: Fighter, ch: CharacterDef, c: Ctx, ev: SimEvent[]): void {
  const z = zoneMotion(s, f);
  if (z.water && !f.grounded) {
    // Swimming: every jump press is a stroke, and the water slows everything.
    f.jumpsLeft = Math.max(f.jumpsLeft, 1);
    f.fastFall = 0;
    f.vx = idiv(f.vx * 96, 100);
    if (f.vy > 0) f.vy = idiv(f.vy * 96, 100);
  }
  if (!f.grounded) {
    const m = f.action === ACT.ATTACK ? ch.moves[f.move] : null;
    const floating =
      (m?.floatUntil !== undefined && f.frame < m.floatUntil && f.airSpecial <= 1) ||
      (f.action === ACT.AIRDODGE && f.dir !== 0 && f.frame < 18);
    if (floating) {
      if (m) f.vy = Math.max(f.vy, 0);
    } else {
      const cap = z.water ? -idiv(fallSpeed(ch, false) * 40, 100) : -fallSpeed(ch, f.fastFall === 1);
      const g = idiv(ch.gravity * z.gravity, 100);
      f.vy = f.fastFall ? cap : Math.max(f.vy - g, Math.min(f.vy, cap));
    }
  }

  if (f.kbx || f.kby) {
    const speed = isqrt(f.kbx * f.kbx + f.kby * f.kby);
    if (speed <= KB_DECAY) {
      f.kbx = 0;
      f.kby = 0;
    } else {
      f.kbx -= idiv(f.kbx * KB_DECAY, speed);
      f.kby -= idiv(f.kby * KB_DECAY, speed);
    }
  }

  // A moving platform carries whoever stands on it.
  if (f.grounded) {
    const p = stage.platforms[f.platform];
    if (p.motion) {
      const now = platformAt(p, frame);
      const before = platformAt(p, frame - 1);
      f.x += now.x1 - before.x1;
    }
  }

  const py = f.y;
  f.x += f.vx + f.kbx + (f.grounded ? z.wx >> 1 : z.wx);
  f.y += f.vy + f.kby + (f.grounded ? 0 : z.wy);

  if (f.grounded && !platformOn(stage, s, f.platform)) {
    // The floor went away (an event switched it off).
    f.grounded = 0;
    f.platform = -1;
    f.jumpsLeft = ch.airJumps;
    if (f.action !== ACT.HITSTUN && f.action !== ACT.DIZZY) {
      setAction(f, ACT.AIR, 0);
      f.coyote = COYOTE_FRAMES;
    }
  }

  if (f.grounded) {
    if (f.vy + f.kby > 0) {
      f.grounded = 0;
      f.platform = -1;
    } else {
      const p = platformAt(stage.platforms[f.platform], frame);
      f.vy = 0;
      f.kby = 0;
      f.y = p.y;
      if (f.x < p.x1 || f.x > p.x2) {
        if (holdsEdge(f)) {
          f.x = clamp(f.x, p.x1, p.x2);
          f.vx = 0;
        } else {
          f.grounded = 0;
          f.platform = -1;
          f.jumpsLeft = ch.airJumps;
          if (f.action !== ACT.HITSTUN && f.action !== ACT.DIZZY) {
            setAction(f, ACT.AIR, 0);
            f.coyote = COYOTE_FRAMES;
          }
        }
      }
    }
  }

  if (!f.grounded) {
    if (f.vy + f.kby <= 0) {
      let best = -1;
      let bestY = 0;
      for (let i = 0; i < stage.platforms.length; i++) {
        const p = stage.platforms[i];
        if (!platformOn(stage, s, i)) continue;
        const now = platformAt(p, frame);
        // Compare against where the top was last frame too, so a platform
        // rising into a falling fighter still catches them.
        const before = p.motion ? platformAt(p, frame - 1).y : now.y;
        if (py < Math.min(now.y, before) || f.y > now.y || f.x < now.x1 || f.x > now.x2) continue;
        if (!p.solid && (f.dropThrough > 0 || (f.action !== ACT.HITSTUN && c.sy < -65))) continue;
        if (best < 0 || now.y > bestY) {
          best = i;
          bestY = now.y;
        }
      }
      if (best >= 0) land(f, ch, best, bestY, ev);
    }
    if (!f.grounded) collideSolids(s, f, py);
    if (!f.grounded) tryGrabLedge(s, f, ch, c, ev);
  }
}

/** Whether a fighter's body overlaps a zone. */
function inZone(f: Fighter, z: StageZone): boolean {
  const [w, h] = bodySize(f);
  const half = w >> 1;
  return f.x + half > z.x1 * FX && f.x - half < z.x2 * FX && f.y + h > z.y1 * FX && f.y < z.y2 * FX;
}

/** What the zones a fighter is in do to their movement: gravity percent, water, and wind per frame. */
function zoneMotion(s: GameState, f: Fighter): { gravity: number; water: boolean; wx: number; wy: number } {
  const out = { gravity: gravityPct, water: false, wx: 0, wy: 0 };
  for (const z of stage.zones ?? []) {
    if (z.kind === 'damage' || !zoneOn(stage, s, z)) continue;
    const [, h] = bodySize(f);
    // Water and gravity go by the fighter's middle; wind pushes anyone it touches.
    const mid = f.y + (h >> 1);
    const inside = z.kind === 'wind' ? inZone(f, z) : f.x > z.x1 * FX && f.x < z.x2 * FX && mid > z.y1 * FX && mid < z.y2 * FX;
    if (!inside) continue;
    if (z.kind === 'water') {
      out.water = true;
      out.gravity = idiv(out.gravity * (z.gravity ?? 35), 100);
    } else if (z.kind === 'gravity') {
      out.gravity = idiv(out.gravity * (z.gravity ?? 100), 100);
    } else if (z.kind === 'wind') {
      out.wx += idiv((z.force?.[0] ?? 0) * FX, 60);
      out.wy += idiv((z.force?.[1] ?? 0) * FX, 60);
    }
  }
  return out;
}

// --------------------------------------------------------- stage dynamics

function startPhase(s: GameState, i: number, phase: number, ev: SimEvent[]): void {
  const e = stage.events![i];
  if (phase === EV_WARN && secs(e.warn) <= 0) phase = EV_RUN;
  s.evPhase[i] = phase;
  if (phase === EV_WARN) {
    s.evTimer[i] = secs(e.warn);
    ev.push({ type: 'stage', event: i, phase: 'warn' });
    return;
  }
  // Running: hazards that ride this event get a fresh pass at everyone.
  (stage.hazards ?? []).forEach((h, j) => {
    if (h.during === e.id) s.hazHit[j] = 0;
  });
  s.evTimer[i] = secs(e.duration);
  ev.push({ type: 'stage', event: i, phase: 'start' });
  if (s.evTimer[i] <= 0) endEvent(s, i, ev);
}

function endEvent(s: GameState, i: number, ev: SimEvent[]): void {
  const e = stage.events![i];
  s.evPhase[i] = EV_IDLE;
  ev.push({ type: 'stage', event: i, phase: 'end' });
  if ((e.trigger ?? 'timer') === 'timer' && e.every) {
    const lo = secs(e.every[0]);
    const hi = secs(e.every[1]);
    let v: number;
    [s.rng, v] = rngNext(s.rng);
    s.evTimer[i] = Math.max(1, lo + (v % Math.max(1, hi - lo + 1)));
  } else {
    s.evTimer[i] = -1;
  }
}

/** Counts down each stage event: waiting, warning, running, and back. */
function advanceEvents(s: GameState, ev: SimEvent[]): void {
  const evs = stage.events;
  if (!evs?.length || !s.rules.hazards || s.over) return;
  for (let i = 0; i < evs.length; i++) {
    if (s.evTimer[i] < 0) continue;
    if (s.evTimer[i] > 0 && --s.evTimer[i] > 0) continue;
    if (s.evPhase[i] === EV_IDLE) startPhase(s, i, EV_WARN, ev);
    else if (s.evPhase[i] === EV_WARN) startPhase(s, i, EV_RUN, ev);
    else endEvent(s, i, ev);
  }
}

/** Starts events that wait on a KO or a hit, from this frame's events. */
function triggerEvents(s: GameState, ev: SimEvent[]): void {
  const evs = stage.events;
  if (!evs?.length || !s.rules.hazards) return;
  const ko = ev.some((e) => e.type === 'ko');
  const hit = ev.some((e) => e.type === 'hit' && !e.shield);
  if (!ko && !hit) return;
  for (let i = 0; i < evs.length; i++) {
    const t = evs[i].trigger;
    if (!((t === 'ko' && ko) || (t === 'hit' && hit)) || s.evPhase[i] !== EV_IDLE) continue;
    const chance = evs[i].chance ?? 100;
    if (chance < 100) {
      let v: number;
      [s.rng, v] = rngNext(s.rng);
      if (v % 100 >= chance) continue;
    }
    startPhase(s, i, EV_WARN, ev);
  }
}

/** Damage zones and hazards hitting fighters. */
function stageHits(s: GameState, ev: SimEvent[]): void {
  if (!s.rules.hazards) return;
  (stage.zones ?? []).forEach((z, zi) => {
    if (z.kind !== 'damage' || !zoneOn(stage, s, z)) return;
    if (s.frame % Math.max(1, secs(z.tick, 0.5)) !== 0) return;
    const dmg = idiv((z.damage ?? 1) * 10 * s.rules.damage, 100);
    for (const f of s.fighters) {
      if (!hittable(f) || f.hitlag > 0 || !inZone(f, z)) continue;
      const [, h] = bodySize(f);
      stageHit(s, f, dmg, (z.knock ?? 0) * 1000, normDeg(z.angle ?? 90), f.x, f.y + (h >> 1), 'zone', zi, ev);
    }
  });
  (stage.hazards ?? []).forEach((hz, j) => {
    if (!hz.during && s.frame % Math.max(1, secs(hz.period, 4)) === 0) s.hazHit[j] = 0;
    const at = hazardAt(stage, s, hz);
    if (!at) return;
    const r = hz.r * FX;
    const dmg = idiv(hz.dmg * 10 * s.rules.damage, 100);
    for (const v of s.fighters) {
      if (s.hazHit[j] & (1 << v.id) || !hittable(v)) continue;
      const [w, h] = bodySize(v);
      const half = w >> 1;
      const px = clamp(at.x, v.x - half, v.x + half);
      const py = clamp(at.y, v.y, v.y + h);
      const dx = at.x - px;
      const dy = at.y - py;
      if (dx * dx + dy * dy > r * r) continue;
      s.hazHit[j] |= 1 << v.id;
      const weight = idiv(CHARACTERS[v.char].weight * v.scale, 100);
      const kb = knockback(Math.min(v.percent + dmg, 9999), dmg, weight, hz.bkb, hz.kbg);
      stageHit(s, v, dmg, kb, normDeg(at.dir > 0 ? hz.angle : 180 - hz.angle), (at.x + px) >> 1, (at.y + py) >> 1, 'hazard', j, ev);
    }
  });
}

/**
 * The stage hurting a fighter: damage (tenths), and a launch of kb
 * (thousandths, 0 for none) at angle. It goes through shields: stage
 * hazards are dodged, not blocked. The last fighter to hit them keeps the
 * credit for a KO.
 */
function stageHit(
  s: GameState,
  v: Fighter,
  dmg: number,
  kb: number,
  angle: number,
  x: number,
  y: number,
  source: 'zone' | 'hazard',
  index: number,
  ev: SimEvent[],
): void {
  v.percent = Math.min(v.percent + dmg, 9999);
  if (kb > 0) {
    v.hitlag = 4 + idiv(dmg, 30);
    v.launchSpeed = idiv(kb * KB_SPEED, 100);
    v.launchAngle = angle;
    v.hitstun = idiv(kb * 4, 10000);
    setAction(v, ACT.HITSTUN, 0);
    v.vx = v.vy = v.kbx = v.kby = 0;
    v.fastFall = 0;
    v.airSpecial = 0;
    v.ledge = 0;
    v.buffer = 0;
  }
  ev.push({ type: 'hurt', victim: v.id, source, index, x, y, dmg, kb: idiv(kb, 1000) });
}

/** Actions that stop at a platform edge instead of sliding off it. */
function holdsEdge(f: Fighter): boolean {
  return (
    f.action === ACT.ATTACK ||
    f.action === ACT.ROLL ||
    f.action === ACT.SPOTDODGE ||
    f.action === ACT.SHIELD ||
    f.action === ACT.SHIELD_STUN ||
    f.action === ACT.LAND ||
    f.action === ACT.JUMPSQUAT
  );
}

/** Pushes an airborne fighter out of the sides and bottoms of solid platforms. */
function collideSolids(s: GameState, f: Fighter, py: number): void {
  const [w, height] = bodySize(f);
  const half = w >> 1;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid || !platformOn(stage, s, i)) continue;
    const x1 = p.x1 * FX;
    const x2 = p.x2 * FX;
    const top = p.y * FX;
    const bottom = top - (p.depth ?? 90) * FX;
    if (f.x + half <= x1 || f.x - half >= x2 || f.y >= top || f.y + height <= bottom) continue;

    if (py + height <= bottom) {
      f.y = bottom - height;
      if (f.vy > 0) f.vy = 0;
      if (f.kby > 0) f.kby = -(f.kby >> 1);
      continue;
    }
    f.x = f.x < (x1 + x2) >> 1 ? x1 - half : x2 + half;
    f.vx = 0;
    f.kbx = f.action === ACT.HITSTUN ? -(f.kbx >> 1) : 0;
  }
}

function land(f: Fighter, ch: CharacterDef, platform: number, y: number, ev: SimEvent[]): void {
  f.grounded = 1;
  f.platform = platform;
  f.y = y;
  f.vy = 0;
  f.kby = 0;
  f.fastFall = 0;
  f.airdodgeUsed = 0;
  f.airSpecial = 0;
  f.jumpsLeft = ch.airJumps;
  switch (f.action) {
    case ACT.ATTACK: {
      const m = ch.moves[f.move];
      setAction(f, ACT.LAND, m.landingLag ?? 4);
      break;
    }
    case ACT.HELPLESS:
      setAction(f, ACT.LAND, 20);
      break;
    case ACT.HITSTUN:
      f.kbx = idiv(f.kbx, 2);
      setAction(f, ACT.LAND, clamp(f.hitstun, 4, 20));
      f.hitstun = 0;
      break;
    case ACT.AIRDODGE:
      setAction(f, ACT.LAND, 10);
      break;
    case ACT.AIR:
      if (f.buffer) f.bufferAge = 0;
      setAction(f, ACT.LAND, 4);
      break;
  }
  ev.push({ type: 'land', id: f.id, x: f.x, y: f.y });
}

/** Grounded fighters standing inside each other drift apart. */
function separate(s: GameState): void {
  const fs = s.fighters;
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const a = fs[i];
      const b = fs[j];
      if (!a.grounded || !b.grounded || a.platform !== b.platform || a.hitlag || b.hitlag) continue;
      const min = (bodySize(a)[0] + bodySize(b)[0]) >> 2;
      const dx = b.x - a.x;
      if (Math.abs(dx) >= min) continue;
      const dir = dx === 0 ? 1 : sign(dx);
      a.x -= dir * 2 * FX;
      b.x += dir * 2 * FX;
    }
  }
}

// ---------------------------------------------------------------- stocks

function checkBlastZones(s: GameState, f: Fighter, ev: SimEvent[]): void {
  if (f.action === ACT.DEAD) return;
  const b = stage.blast;
  if (f.x > b.left * FX && f.x < b.right * FX && f.y > b.bottom * FX && f.y < b.top * FX) return;
  ev.push({ type: 'ko', victim: f.id, by: f.lastHitBy, x: f.x, y: f.y });
  f.stocks--;
  f.falls++;
  if (f.lastHitBy >= 0 && f.lastHitBy !== f.id) s.fighters[f.lastHitBy].kos++;
  f.vx = f.vy = f.kbx = f.kby = 0;
  f.hitlag = 0;
  f.ledge = 0;
  setAction(f, ACT.DEAD, 0);
}

function respawn(f: Fighter, ch: CharacterDef, ev: SimEvent[]): void {
  f.x = (stage.respawn.x + (f.id - 1) * 90) * FX;
  f.y = stage.respawn.y * FX;
  f.percent = f.startPercent;
  f.grounded = 0;
  f.platform = -1;
  f.jumpsLeft = ch.airJumps;
  f.airdodgeUsed = 0;
  f.fastFall = 0;
  f.shield = SHIELD_MAX;
  f.hitstun = 0;
  f.lastHitBy = -1;
  f.buffer = 0;
  f.intangible = 120;
  setAction(f, ACT.RESPAWN, 0);
  ev.push({ type: 'respawn', id: f.id, x: f.x, y: f.y });
}

/** Sides still in the match: one per team, or one per fighter without a team. */
function sides(s: GameState): Fighter[][] {
  const groups = new Map<number, Fighter[]>();
  for (const f of s.fighters) {
    if (f.stocks <= 0) continue;
    const key = f.team >= 0 ? f.team : -1 - f.id;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.values()];
}

function checkGameOver(s: GameState): void {
  if (s.over || s.fighters.length < 2) return;
  const alive = sides(s);
  const timeUp = s.rules.timeLimit > 0 && s.frame + 1 >= s.rules.timeLimit;
  if (alive.length > 1 && !timeUp) return;

  // On time, the side with the most stocks wins, then the least damage.
  let best: Fighter[] | null = null;
  const score = (g: Fighter[]) => [g.reduce((n, f) => n + f.stocks, 0), -g.reduce((n, f) => n + f.percent, 0)];
  for (const g of alive) {
    if (!best) best = g;
    else {
      const [a1, a2] = score(g);
      const [b1, b2] = score(best);
      if (a1 > b1 || (a1 === b1 && a2 > b2)) best = g;
    }
  }
  s.over = 1;
  s.timedOut = alive.length > 1 ? 1 : 0;
  s.winner = best ? best[0].id : -1;
  s.winnerTeam = best && best[0].team >= 0 ? best[0].team : -1;
  s.endTimer = 120;
}

// -------------------------------------------------------- broadcast events

const RIG_WARN = 60;
const RIG_FALL = 24;
const RIG_R = 90;
const FLICKER_FRAMES = 150;
const HIJACK_FRAMES = 600;
export const BREAK_FRAMES = 90;
export const RIG_DROP_FRAMES = RIG_WARN + RIG_FALL;

/** Fires each scripted event once, when its trigger is met, and runs the rig light. */
function broadcastEvents(s: GameState, ev: SimEvent[]): void {
  if (s.over) return;
  const koed = ev.some((e) => e.type === 'ko');
  for (let i = 0; i < s.bc.length; i++) {
    const b = s.bc[i];
    if (s.bcFired[i]) continue;
    const w = b.when;
    const met =
      (w.time !== undefined && s.frame >= secs(w.time)) ||
      (w.stockLost && koed) ||
      (w.damage !== undefined && s.fighters.some((f) => f.percent >= w.damage! * 10));
    if (!met) continue;
    if (b.kind === 'rig-drop' && (!s.rules.hazards || s.rigFrame >= 0)) continue;
    s.bcFired[i] = 1;
    let who = 0;
    if (b.kind === 'flicker') s.flicker = FLICKER_FRAMES;
    else if (b.kind === 'hijack') s.hijack = HIJACK_FRAMES;
    else if (b.kind === 'break') {
      s.freeze = BREAK_FRAMES;
      s.angle = (s.angle + 1) % 3;
    } else if (b.kind === 'chant') {
      // The crowd chants for whoever is ahead: most stocks, then least damage.
      for (const f of s.fighters) {
        const c = s.fighters[who];
        if (f.stocks > c.stocks || (f.stocks === c.stocks && f.percent < c.percent)) who = f.id;
      }
    } else {
      // The rig light picks either fighter, from the match rng.
      let v: number;
      [s.rng, v] = rngNext(s.rng);
      const live = s.fighters.filter((f) => f.action !== ACT.DEAD);
      const t = live[v % Math.max(1, live.length)] ?? s.fighters[0];
      who = t.id;
      s.rigX = t.x;
      s.rigFrame = 0;
      s.rigHit = 0;
    }
    ev.push({ type: 'broadcast', index: i, kind: b.kind, phase: 'start', who });
  }
  if (s.flicker > 0 && --s.flicker === 0) ev.push({ type: 'broadcast', index: s.bc.findIndex((b) => b.kind === 'flicker'), kind: 'flicker', phase: 'end', who: 0 });
  if (s.hijack > 0 && --s.hijack === 0) ev.push({ type: 'broadcast', index: s.bc.findIndex((b) => b.kind === 'hijack'), kind: 'hijack', phase: 'end', who: 0 });
  if (s.rigFrame >= 0) {
    s.rigFrame++;
    const at = rigPos(s);
    if (s.rigFrame > RIG_WARN) {
      const r = RIG_R * FX;
      const dmg = idiv(120 * s.rules.damage, 100);
      for (const v of s.fighters) {
        if (s.rigHit & (1 << v.id) || !hittable(v)) continue;
        const [w, h] = bodySize(v);
        const px = clamp(at.x, v.x - (w >> 1), v.x + (w >> 1));
        const py = clamp(at.y, v.y, v.y + h);
        if ((at.x - px) ** 2 + (at.y - py) ** 2 > r * r) continue;
        s.rigHit |= 1 << v.id;
        const weight = idiv(CHARACTERS[v.char].weight * v.scale, 100);
        const kb = knockback(Math.min(v.percent + dmg, 9999), dmg, weight, 30, 90);
        stageHit(s, v, dmg, kb, v.x >= at.x ? 60 : 120, px, py, 'hazard', -1, ev);
      }
    }
    if (s.rigFrame > RIG_DROP_FRAMES + 20) s.rigFrame = -1;
  }
}

/** Where the rig light is now: hanging above the stage while it warns, then falling to the floor. */
export function rigPos(s: GameState): { x: number; y: number } {
  const floor = stage.platforms[0].y * FX;
  const top = floor + 700 * FX;
  const k = Math.max(0, Math.min(RIG_FALL, s.rigFrame - RIG_WARN));
  return { x: s.rigX, y: top - idiv((top - floor - 40 * FX) * k, RIG_FALL) };
}
