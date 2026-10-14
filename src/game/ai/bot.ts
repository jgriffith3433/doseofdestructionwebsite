// A computer player. It reads the game state and returns the same packed
// input a controller would, so the sim cannot tell it from a person. In an
// online match the peer that owns a bot runs it and sends its inputs like any
// other player's.

import { FX, rngNext } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { BTN, packInput } from '../sim/input.ts';
import { STAGE } from '../sim/stage.ts';
import { ACT, type Fighter, type GameState } from '../sim/state.ts';

interface Step {
  sx: number;
  sy: number;
  btn: number;
  frames: number;
}

const EDGE = STAGE.platforms[0].x2;

export class Bot {
  readonly id: number;
  readonly level: number;
  private rng: number;
  private queue: Step[] = [];
  private hold: Step = { sx: 0, sy: 0, btn: 0, frames: 0 };
  private wait = 0;

  /** level runs 1 (easy) to 9 (hard). */
  constructor(id: number, level: number, seed: number) {
    this.id = id;
    this.level = Math.max(1, Math.min(9, level));
    this.rng = seed;
  }

  think(s: GameState): number {
    const next = this.queue[0];
    if (next) {
      if (--next.frames <= 0) this.queue.shift();
      return packInput(next.sx, next.sy, next.btn);
    }
    if (--this.wait > 0) return packInput(this.hold.sx, this.hold.sy, 0);
    this.wait = this.reaction();
    this.decide(s);
    return packInput(this.hold.sx, this.hold.sy, 0);
  }

  private random(): number {
    let v: number;
    [this.rng, v] = rngNext(this.rng);
    return v / 4294967296;
  }

  private reaction(): number {
    return 24 - this.level * 2 + Math.floor(this.random() * 4);
  }

  /** Queue a button press; a release frame follows so the next press registers. */
  private press(sx: number, sy: number, btn: number, frames = 1): void {
    this.queue.push({ sx, sy, btn, frames }, { sx, sy, btn: 0, frames: 1 });
  }

  private steer(sx: number, sy = 0): void {
    this.hold = { sx, sy, btn: 0, frames: 0 };
  }

  private decide(s: GameState): void {
    const me = s.fighters[this.id];
    this.steer(0);
    if (me.action === ACT.DEAD || s.over) return;

    if (me.action === ACT.RESPAWN) {
      if (me.frame > 40 + this.random() * 60) this.steer(0, -100);
      return;
    }
    if (me.action === ACT.LEDGE) return this.ledge(me);
    if (me.action === ACT.HITSTUN || me.hitlag > 0) {
      // Survival DI: hold up and back toward the stage.
      this.steer(me.x > 0 ? -70 : 70, 70);
      this.wait = 2;
      return;
    }
    if (this.offstage(me)) return this.recover(me);

    const target = this.pickTarget(s, me);
    if (!target) return;
    this.fight(me, target);
  }

  private offstage(me: Fighter): boolean {
    const x = me.x / FX;
    return !me.grounded && (Math.abs(x) > EDGE + 10 || me.y < -20 * FX);
  }

  private recover(me: Fighter): void {
    const x = me.x / FX;
    const y = me.y / FX;
    const toward = x > 0 ? -100 : 100;
    this.wait = 3;
    if (me.action === ACT.HELPLESS || me.action === ACT.ATTACK || me.action === ACT.AIRDODGE) {
      this.steer(toward);
      return;
    }
    const falling = me.vy <= 0;
    if (me.jumpsLeft > 0 && falling && y < 80) {
      this.press(toward, 0, BTN.JUMP, 2);
      return;
    }
    if (me.jumpsLeft === 0 && falling && (y < -60 || Math.abs(x) > EDGE + 160)) {
      this.press(toward * 0.4, 100, BTN.SPECIAL);
      return;
    }
    this.steer(toward);
  }

  private ledge(me: Fighter): void {
    if (me.frame < 10 + this.random() * 30) return;
    const toward = -me.ledge * 100;
    const r = this.random();
    if (r < 0.45) this.press(toward, 0, 0, 2);
    else if (r < 0.75) this.press(0, 0, BTN.JUMP, 4);
    else this.press(0, 0, BTN.ATTACK);
  }

  private pickTarget(s: GameState, me: Fighter): Fighter | null {
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const f of s.fighters) {
      if (f === me || f.stocks <= 0 || f.action === ACT.DEAD) continue;
      const d = Math.abs(f.x - me.x) + Math.abs(f.y - me.y);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    return best;
  }

  private fight(me: Fighter, t: Fighter): void {
    const ch = CHARACTERS[me.char];
    const dx = (t.x - me.x) / FX;
    const dy = (t.y - me.y) / FX;
    const adx = Math.abs(dx);
    const side = dx >= 0 ? 100 : -100;
    const reach = 50 + ch.width * 0.5 + (ch.height - 110) * 0.4;
    const skill = this.level / 9;
    const busy = me.action === ACT.ATTACK || me.action === ACT.LAND || me.action === ACT.JUMPSQUAT;
    if (busy) return;

    // Defend against an attack that is about to come out.
    const threat = t.action === ACT.ATTACK && adx < reach + 60 && Math.abs(dy) < 90;
    if (threat && me.grounded && this.random() < skill * 0.55) {
      if (this.random() < 0.7) {
        this.press(0, 0, BTN.SHIELD, 10 + Math.floor(this.random() * 8));
      } else {
        // Roll away: shield, then flick the stick back while holding it.
        this.queue.push({ sx: 0, sy: 0, btn: BTN.SHIELD, frames: 2 }, { sx: -side, sy: 0, btn: BTN.SHIELD, frames: 2 });
      }
      return;
    }
    if (me.action === ACT.SHIELD) return;

    // Punish a target that just finished swinging or is stuck landing.
    const open = t.action === ACT.LAND || t.action === ACT.DIZZY || t.action === ACT.HELPLESS;
    const killPercent = 900 - this.level * 30;

    if (me.grounded) {
      if (adx < reach && Math.abs(dy) < 50) {
        if (Math.abs(me.x / FX) > EDGE - 30 && Math.sign(dx) === Math.sign(me.x)) {
          // Facing out over the edge: the forward smash sends them far.
          this.press(side, 0, side > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
        } else if ((t.percent > killPercent || open) && this.random() < 0.5 + skill * 0.3) {
          this.press(side, 0, this.random() < 0.6 ? (side > 0 ? BTN.C_RIGHT : BTN.C_LEFT) : BTN.C_DOWN);
        } else {
          const r = this.random();
          if (r < 0.35) this.press(0, 0, BTN.ATTACK);
          else if (r < 0.7) this.press(side, 0, BTN.ATTACK);
          else if (r < 0.85) this.press(side * 0.3, -100, BTN.ATTACK);
          else this.press(side, 0, BTN.SPECIAL);
        }
        return;
      }
      if (adx < reach * 0.8 && dy > 40 && dy < 180) {
        this.press(0, 100, t.percent > killPercent ? BTN.C_UP : BTN.ATTACK);
        return;
      }
      if (dy > 70 && adx < 220) {
        // Full hop toward a target above, then swing on the way up.
        this.press(side * 0.6, 0, BTN.JUMP, 6);
        this.queue.push({ sx: side * 0.6, sy: 0, btn: 0, frames: 10 });
        this.press(side * 0.3, 0, BTN.ATTACK);
        return;
      }
      if (dy < -60 && me.platform > 0 && adx < 260) {
        this.queue.push({ sx: 0, sy: 0, btn: 0, frames: 1 }, { sx: 0, sy: -100, btn: 0, frames: 4 });
        return;
      }
      if (Math.abs(t.x / FX) > EDGE + 20) {
        // The target is off stage: wait near the ledge they have to come back to.
        const post = Math.sign(t.x) * (EDGE - 60);
        const gap = post - me.x / FX;
        this.steer(Math.abs(gap) > 20 ? Math.sign(gap) * 70 : 0);
        return;
      }
      if (adx > reach * 0.8) {
        // Approach, sometimes with a short hop aerial.
        if (adx < 240 && this.random() < 0.25 + skill * 0.15) {
          this.press(side, 0, BTN.JUMP, 1);
          this.queue.push({ sx: side, sy: 0, btn: 0, frames: 6 });
          this.press(side, 0, BTN.ATTACK);
          return;
        }
        const nearEdge = Math.abs(me.x / FX) > EDGE - 40 && Math.sign(side) === Math.sign(me.x);
        this.steer(nearEdge ? 0 : side);
        return;
      }
      this.steer(side * 0.3);
      return;
    }

    // In the air near the stage.
    if (adx < reach + 15 && Math.abs(dy) < 120) {
      let dirX = 0;
      let dirY = 0;
      if (dy > 50) dirY = 100;
      else if (dy < -50) dirY = -100;
      else dirX = side;
      this.press(dirX, dirY, BTN.ATTACK);
      return;
    }
    if (me.jumpsLeft > 0 && dy > 120 && this.random() < 0.4) {
      this.press(side, 0, BTN.JUMP, 2);
      return;
    }
    // Drift toward the target, but never away from the stage.
    const homeward = Math.abs(me.x / FX) > EDGE - 60 ? -Math.sign(me.x) * 100 : side;
    this.steer(homeward);
    if (me.vy < 0 && dy < -80 && this.random() < skill * 0.5) this.queue.push({ sx: homeward, sy: -100, btn: 0, frames: 2 });
  }
}
