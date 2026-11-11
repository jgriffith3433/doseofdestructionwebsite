// A computer player. It reads the game state and returns the same packed
// input a controller would, so the sim cannot tell it from a person. In an
// online match the peer that owns a bot runs it and sends its inputs like any
// other player's.

import { FX, rngNext } from '../sim/fixed.ts';
import { CHARACTERS, MOVE, type SpecialKind } from '../sim/characters.ts';
import { BTN, packInput } from '../sim/input.ts';
import { STAGES, ledges, platformOn, type Platform, type StageDef } from '../sim/stage.ts';
import { ACT, allies, type Fighter, type GameState } from '../sim/state.ts';

interface Step {
  sx: number;
  sy: number;
  btn: number;
  frames: number;
}

export class Bot {
  readonly id: number;
  readonly level: number;
  private rng: number;
  private queue: Step[] = [];
  private hold: Step = { sx: 0, sy: 0, btn: 0, frames: 0 };
  private wait = 0;
  private stage: StageDef = STAGES[0];
  private state: GameState | null = null;
  /** The pilot's gentle Kaelen (docs/story.md "The pilot"): a first-time player's opponent, see pilotFight. */
  private readonly pilot: boolean;
  /** Pilot: 0 hops up to a platform (the Jump lesson), 1 waits there, 2 fights. */
  private pilotStep = 0;
  private pilotSince = 0;
  private pilotSmashAt = -9999;
  private pilotBase = -1;

  /** level runs 1 (easy) to 9 (hard); pilot makes it the slow, readable opponent of the first fight. */
  constructor(id: number, level: number, seed: number, pilot = false) {
    this.id = id;
    this.level = Math.max(1, Math.min(9, level));
    this.rng = seed;
    this.pilot = pilot;
  }

  think(s: GameState): number {
    this.stage = STAGES[s.stage] ?? STAGES[0];
    this.state = s;
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

  /** The solid platform under or nearest to x. */
  private home(x: number): Platform {
    let best = this.stage.platforms[0];
    let bestD = Infinity;
    for (const [i, p] of this.stage.platforms.entries()) {
      // Not one an event has taken away right now.
      if (!p.solid || (this.state && !platformOn(this.stage, this.state, i))) continue;
      const d = x < p.x1 ? p.x1 - x : x > p.x2 ? x - p.x2 : 0;
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
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
      // Survival DI: hold up and back toward the nearest ground.
      const h = this.home(me.x / FX);
      this.steer(me.x / FX > (h.x1 + h.x2) / 2 ? -70 : 70, 70);
      this.wait = 2;
      return;
    }
    // The rig light is coming down on us: run out from under it.
    if (s.rigFrame >= 0 && Math.abs(me.x - s.rigX) < 260 * FX) {
      this.steer(me.x >= s.rigX ? 100 : -100);
      return;
    }
    if (this.offstage(me)) return this.recover(me);

    const target = this.pickTarget(s, me);
    if (!target) return;
    this.fight(me, target);
  }

  private offstage(me: Fighter): boolean {
    if (me.grounded) return false;
    const x = me.x / FX;
    const y = me.y / FX;
    const h = this.home(x);
    return x < h.x1 - 10 || x > h.x2 + 10 || y < h.y - 20;
  }

  private recover(me: Fighter): void {
    const x = me.x / FX;
    const y = me.y / FX;
    const h = this.home(x);
    const toward = x > (h.x1 + h.x2) / 2 ? -100 : 100;
    const gap = x < h.x1 ? h.x1 - x : x > h.x2 ? x - h.x2 : 0;
    this.wait = 3;
    if (me.action === ACT.HELPLESS || me.action === ACT.ATTACK || me.action === ACT.AIRDODGE) {
      this.steer(toward);
      return;
    }
    const falling = me.vy <= 0;
    if (me.jumpsLeft > 0 && falling && y < h.y + 80) {
      this.press(toward, 0, BTN.JUMP, 2);
      return;
    }
    if (me.jumpsLeft === 0 && falling && (y < h.y - 60 || gap > 160)) {
      this.press(toward * 0.4, 100, BTN.SPECIAL);
      return;
    }
    this.steer(toward);
  }

  private ledge(me: Fighter): void {
    if (me.frame < 10 + this.random() * 30) return;
    const held = ledges(this.stage)[me.ledge - 1];
    const toward = held ? -held.side * 100 : 0;
    const r = this.random();
    if (r < 0.45) this.press(toward, 0, 0, 2);
    else if (r < 0.75) this.press(0, 0, BTN.JUMP, 4);
    else this.press(0, 0, BTN.ATTACK);
  }

  private pickTarget(s: GameState, me: Fighter): Fighter | null {
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const f of s.fighters) {
      if (f === me || f.stocks <= 0 || f.action === ACT.DEAD || allies(me, f)) continue;
      const d = Math.abs(f.x - me.x) + Math.abs(f.y - me.y);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    return best;
  }

  /** The stick that picks a special slot (neutral, side, down), facing `side`. */
  private slotStick(slot: 'neutral' | 'side' | 'down', side: number): [number, number] {
    return slot === 'neutral' ? [side * 0.2, 0] : slot === 'side' ? [side, 0] : [0, -100];
  }

  /** The slot of this fighter's kit that holds an archetype, if it has one. Fighters without their own specials have none. */
  private slotOf(me: Fighter, kind: SpecialKind): 'neutral' | 'side' | 'down' | null {
    const ch = CHARACTERS[me.char];
    if (!ch.specials) return null;
    if (ch.moves[MOVE.NSPECIAL].kind === kind) return 'neutral';
    if (ch.moves[MOVE.SSPECIAL].kind === kind) return 'side';
    if (ch.moves[MOVE.DSPECIAL].kind === kind) return 'down';
    return null;
  }

  /** Uses a special by its archetype: true when it was pressed. */
  private special(me: Fighter, kind: SpecialKind, side: number, chance: number, frames = 1): boolean {
    const slot = this.slotOf(me, kind);
    if (!slot || this.random() >= chance) return false;
    const [sx, sy] = this.slotStick(slot, side);
    this.press(sx, sy, BTN.SPECIAL, frames);
    return true;
  }

  /**
   * The pilot's Kaelen: hops onto a platform and waits there (so the Jump prompt has its moment), then fights slowly:
   * a jab or a tilt now and then, never a combo, and one telegraphed forward smash each time the player has hurt him
   * (so the Shield prompt has its moment). He never defends and never dodges, so a first-time player wins.
   */
  private pilotFight(me: Fighter, t: Fighter, s: GameState): void {
    const mx = me.x / FX;
    const dx = (t.x - me.x) / FX;
    const adx = Math.abs(dx);
    const side = dx >= 0 ? 100 : -100;
    if (this.pilotBase < 0) {
      this.pilotBase = me.percent;
      this.pilotSince = s.frame;
    }
    const age = s.frame - this.pilotSince;
    const perch = this.stage.platforms.findIndex((p) => !p.solid && Math.abs((p.x1 + p.x2) / 2 - mx) < 480);
    if (this.pilotStep === 0) {
      const p = this.stage.platforms[perch];
      if (!p || age > 420 || me.platform === perch) {
        this.pilotStep = p && me.platform === perch ? 1 : 2;
        this.pilotSince = s.frame;
      } else if (age > 90) {
        const cx = (p.x1 + p.x2) / 2;
        if (me.grounded && Math.abs(cx - mx) < 70) {
          this.press(Math.sign(cx - mx) * 40, 0, BTN.JUMP, 8);
          this.queue.push({ sx: 0, sy: 0, btn: 0, frames: 18 });
          this.wait = 40;
        } else this.steer(Math.sign(cx - mx) * 100);
        return;
      } else return;
    }
    if (this.pilotStep === 1) {
      // On the platform: a beat for the Jump prompt, then down (or off) to fight.
      if (s.frame - this.pilotSince < 210) return;
      this.pilotStep = 2;
      this.steer(0, -100);
      this.queue.push({ sx: 0, sy: -100, btn: 0, frames: 6 });
      return;
    }
    const ch = CHARACTERS[me.char];
    const reach = (50 + ch.width * 0.5 + (ch.height - 110) * 0.4) * ch.tuning.reach * (me.scale / 100);
    this.wait = 18 + Math.floor(this.random() * 16);
    if (me.action === ACT.ATTACK || me.action === ACT.LAND || me.action === ACT.JUMPSQUAT) return;
    // Standing high (a respawn platform, the top deck) with the player below: walk off the nearer end to come down and fight.
    if (me.grounded && me.platform >= 0 && this.stage.platforms[me.platform].y > 100 && (me.y - t.y) / FX > 90) {
      const p = this.stage.platforms[me.platform];
      this.steer(mx - p.x1 < p.x2 - mx ? -100 : 100);
      return;
    }
    if (adx > reach * 0.9 || Math.abs((t.y - me.y) / FX) > 90) {
      this.steer(adx > 40 ? side : 0);
      // Never chase over an edge.
      const h = this.home(mx);
      if ((side > 0 && h.x2 - mx < 60) || (side < 0 && mx - h.x1 < 60)) this.steer(0);
      return;
    }
    if (!me.grounded || me.facing !== Math.sign(dx)) {
      this.steer(side);
      return;
    }
    // A smash, slow and obvious, when the player has hurt him: once every ten seconds at most.
    if (me.percent >= this.pilotBase + 150 && s.frame - this.pilotSmashAt > 600) {
      this.pilotSmashAt = s.frame;
      this.press(side, 0, side > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
      this.wait = 70;
      return;
    }
    if (this.random() < 0.4) {
      this.press(side * 0.3, 0, BTN.ATTACK);
      this.wait = 40;
    }
  }

  private fight(me: Fighter, t: Fighter): void {
    if (this.pilot && this.state) return this.pilotFight(me, t, this.state);
    const ch = CHARACTERS[me.char];
    const k = me.scale / 100;
    const mx = me.x / FX;
    const dx = (t.x - me.x) / FX;
    const dy = (t.y - me.y) / FX;
    const adx = Math.abs(dx);
    const side = dx >= 0 ? 100 : -100;
    const reach = (50 + ch.width * 0.5 + (ch.height - 110) * 0.4) * ch.tuning.reach * k;
    const skill = this.level / 9;
    const busy = me.action === ACT.ATTACK || me.action === ACT.LAND || me.action === ACT.JUMPSQUAT;
    if (busy) return;

    const h = this.home(mx);
    const towardEdge = side > 0 ? h.x2 - mx : mx - h.x1;
    const nearEdge = towardEdge < 50;

    // Defend against an attack that is about to come out.
    const threat = t.action === ACT.ATTACK && adx < reach + 60 && Math.abs(dy) < 90;
    // The opponent commits to a swing: a counter special turns it back on them.
    if (threat && me.grounded && me.facing === Math.sign(dx) && this.special(me, 'counter', side, 0.25 + skill * 0.4)) return;
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
    const targetHome = this.home(t.x / FX);

    if (me.grounded) {
      if (adx < reach && Math.abs(dy) < 50 * k) {
        if (nearEdge) {
          // Facing out over the edge: the forward smash sends them far.
          this.press(side, 0, side > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
        } else if ((t.percent > killPercent || open) && this.random() < 0.5 + skill * 0.3) {
          this.press(side, 0, this.random() < 0.6 ? (side > 0 ? BTN.C_RIGHT : BTN.C_LEFT) : BTN.C_DOWN);
        } else {
          const r = this.random();
          if (r < 0.35) this.press(0, 0, BTN.ATTACK);
          else if (r < 0.7) this.press(side, 0, BTN.ATTACK);
          else if (r < 0.85) this.press(side * 0.3, -100, BTN.ATTACK);
          else if (me.facing === Math.sign(dx) && (this.special(me, 'grab', side, 0.5) || this.special(me, 'flurry', side, 0.6))) return;
          else this.press(side, 0, BTN.SPECIAL);
        }
        return;
      }
      if (adx < reach * 0.8 && dy > 40 && dy < 180 * k) {
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
      if (dy < -60 && me.platform >= 0 && !this.stage.platforms[me.platform].solid && adx < 260) {
        this.queue.push({ sx: 0, sy: 0, btn: 0, frames: 1 }, { sx: 0, sy: -100, btn: 0, frames: 4 });
        return;
      }
      const tx = t.x / FX;
      if (tx < targetHome.x1 - 20 || tx > targetHome.x2 + 20) {
        // The target is off stage: wait near the ledge they have to come back to.
        const post = tx > (targetHome.x1 + targetHome.x2) / 2 ? targetHome.x2 - 60 : targetHome.x1 + 60;
        const gap = post - mx;
        this.steer(Math.abs(gap) > 20 ? Math.sign(gap) * 70 : 0);
        return;
      }
      const perch = me.platform >= 0 ? this.stage.platforms[me.platform] : null;
      if (perch && dy < -120 * k && adx < 420) {
        // Perched on a high platform with the fight far below: walk off the nearer edge instead of waiting up here.
        this.steer(mx > (perch.x1 + perch.x2) / 2 ? 100 : -100);
        return;
      }
      if (targetHome !== h && nearEdge) {
        // The target is on another island: jump the gap.
        this.press(side, 0, BTN.JUMP, 8);
        this.queue.push({ sx: side, sy: 0, btn: 0, frames: 14 }, { sx: side, sy: 0, btn: BTN.JUMP, frames: 2 });
        return;
      }
      // A fighter with its own specials uses them by archetype: a thrown projectile down the lane, a trap on the
      // way in, a dash to close the distance.
      if (ch.specials && me.facing === Math.sign(dx)) {
        const lane = Math.abs(dy) < 60;
        if (adx > 200 && adx < 640 && lane && this.special(me, 'projectile', side, 0.07 + skill * 0.09)) return;
        if (adx > 110 && adx < 320 && this.special(me, 'trap', side, 0.02 + skill * 0.03, 3)) return;
        if (adx > 170 && adx < 460 && lane && this.special(me, 'dash', side, 0.05 + skill * 0.07)) return;
      }
      if (adx > reach * 0.8) {
        // Approach, sometimes with a short hop aerial.
        if (adx < 240 && this.random() < 0.25 + skill * 0.15) {
          this.press(side, 0, BTN.JUMP, 1);
          this.queue.push({ sx: side, sy: 0, btn: 0, frames: 6 });
          this.press(side, 0, BTN.ATTACK);
          return;
        }
        this.steer(nearEdge && targetHome === h ? 0 : side);
        return;
      }
      this.steer(side * 0.3);
      return;
    }

    // In the air near the stage.
    if (adx < reach + 15 && Math.abs(dy) < 120 * k) {
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
    // Drift toward the target, but never away from the ground underneath.
    const inward = mx > (h.x1 + h.x2) / 2 ? -100 : 100;
    const atEdge = mx < h.x1 + 60 || mx > h.x2 - 60;
    const homeward = atEdge && Math.sign(side) !== Math.sign(inward) && targetHome === h ? inward : side;
    this.steer(homeward);
    if (me.vy < 0 && dy < -80 && this.random() < skill * 0.5) this.queue.push({ sx: homeward, sy: -100, btn: 0, frames: 2 });
  }
}
