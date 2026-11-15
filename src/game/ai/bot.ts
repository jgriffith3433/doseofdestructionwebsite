// A computer player. It reads the game state and returns the same packed
// input a controller would, so the sim cannot tell it from a person. In an
// online match the peer that owns a bot runs it and sends its inputs like any
// other player's.

import { FX, rngNext } from '../sim/fixed.ts';
import { CHARACTERS, MOVE, type SpecialKind } from '../sim/characters.ts';
import { BTN, packInput } from '../sim/input.ts';
import { STAGES, ledges, platformAt, platformOn, type Platform, type StageDef } from '../sim/stage.ts';
import { ACT, allies, type Fighter, type GameState } from '../sim/state.ts';
import { PLAYSTYLE, profileFor, type Playstyle, type PlaystyleId } from './profiles.ts';
import { bodyOf, clearance, readDangers, type Dangers } from './hazardRead.ts';
import { inWindupTell, isSmashMove, isSpecialMove, moveEndFrame, moveStartFrame } from '../hitFeel.ts';

/** Room (world units) a bot wants between its body and a hazard or damage zone. */
const HAZARD_SAFE = 18;

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
  /** A playstyle given by the caller (tests); otherwise the fighter's own (ai/profiles.ts). */
  private readonly styleOverride: PlaystyleId | null;
  /** Stage hazards: the stage has some, the read of this frame, since when the bot has seen the current warning, whether it ignores it. */
  private hazardous = false;
  private dangers: Dangers | null = null;
  private dangersAt = -1;
  private dangerSince = -1;
  private oblivious = false;
  private spot: { x: number; y: number; p: Platform } | null = null;
  private spotAt = -9999;
  private lureHopAt = -9999;
  private commitOf = new Map<number, number>();
  private lastClose = 0;
  /** Until this frame the bot wades through always-on fog (a stand-off across a pit that nobody breaks). */
  private braveUntil = -1;
  /** Solid platforms that stand in an always-on damage zone (a fog pit). */
  private pits = new Set<number>();
  /** True while the bot is moving out of a hazard's way (the playtest reads it). */
  avoiding = false;
  /** The current trip off the stage: when it started and the mistakes this bot will make on it (see recover). */
  private rec: { since: number; late: number; spLate: number; forgetSp: boolean; drift: boolean; delay: number } | null = null;
  /** The ledge option the bot last chose (the playtest and the ladder test read it). */
  lastLedge = '';
  /** Trips off the stage so far (the ladder test reads it). */
  recoveries = 0;
  /** True while the bot is on a trip back to the stage. */
  get recovering(): boolean {
    return this.rec !== null;
  }

  /** level runs 1 (easy) to 9 (hard); pilot makes it the slow, readable opponent of the first fight. */
  constructor(id: number, level: number, seed: number, pilot = false, style: PlaystyleId | null = null) {
    this.styleOverride = style;
    this.id = id;
    this.level = Math.max(1, Math.min(9, level));
    this.rng = seed;
    this.pilot = pilot;
  }

  think(s: GameState): number {
    if (this.stage !== (STAGES[s.stage] ?? STAGES[0]) || !this.state) {
      this.stage = STAGES[s.stage] ?? STAGES[0];
      this.hazardous = !this.pilot && (!!this.stage.hazards?.length || !!this.stage.zones?.some((z) => z.kind === 'damage'));
      this.dangersAt = -1;
      this.dangerSince = -1;
      this.pits = new Set();
      if (this.hazardous && this.level >= 3) {
        this.stage.platforms.forEach((p, i) => {
          const always = (this.stage.zones ?? []).some((z) => z.kind === 'damage' && !z.during && z.x2 > p.x1 + 40 && z.x1 < p.x2 - 40 && z.y1 < p.y + 110 && z.y2 > p.y);
          if (p.solid && always) this.pits.add(i);
        });
      }
    }
    this.state = s;
    if (this.hazardous && s.frame % 3 === 0 && !this.avoiding && this.hazardAlarm(s)) {
      // A warning is up and this spot is in its way: drop what is queued and decide now.
      this.queue.length = 0;
      this.wait = 0;
    }
    const next = this.queue[0];
    if (next) {
      if (--next.frames <= 0) this.queue.shift();
      return packInput(next.sx, next.sy, next.btn);
    }
    if (!this.pilot && this.level >= 8 && this.wait > 0) {
      const me = s.fighters[this.id];
      const ready = me.action === ACT.IDLE || me.action === ACT.WALK || me.action === ACT.CROUCH || me.action === ACT.AIR;
      if (ready) {
        const t = this.pickTarget(s, me);
        if (t && this.windupThreat(me, t)) this.wait = 0;
      }
    }
    if (--this.wait > 0) return packInput(this.hold.sx, this.hold.sy, 0);
    this.wait = this.reaction();
    this.decide(s);
    if (this.hazardous) {
      this.guardSteer(s);
      this.guardCommit(s);
    }
    return packInput(this.hold.sx, this.hold.sy, 0);
  }

  /**
   * Frames this fighter stays committed once it swings: its slowest normal's length plus its landing lag (a heavy's
   * later aerials and longer landings make this much bigger than a fast fighter's).
   */
  private commitFrames(me: Fighter): number {
    let c = this.commitOf.get(me.char);
    if (c === undefined) {
      c = 0;
      for (const m of CHARACTERS[me.char].moves) if (m.hits.length && !m.helpless) c = Math.max(c, m.total + (m.landingLag ?? 0));
      this.commitOf.set(me.char, c);
    }
    return c;
  }

  /** Extra room a slow-to-leave fighter keeps from a hazard (world units): a heavy starts earlier and a landing never ends inside it. */
  private lagPad(me: Fighter): number {
    return Math.max(0, this.commitFrames(me) - 40) * 1.5;
  }

  /**
   * Runs after a decision: no attack or special whose startup, active frames and landing lag would still be running
   * when a warned hazard reaches the bot's spot. The press is dropped and the bot waits at a safe distance instead.
   */
  private guardCommit(s: GameState): void {
    if (!this.queue.some((q) => q.btn & (BTN.ATTACK | BTN.SPECIAL))) return;
    const me = s.fighters[this.id];
    if (this.rec || this.offstage(me)) return;
    const d = this.read(s, me);
    if (!d.event) return;
    if (!this.aware(s, d)) return;
    const [hw, h] = bodyOf(me);
    const horizon = this.commitFrames(me) + 20;
    const pad = this.lagPad(me);
    if (clearance(d, me.x / FX, me.y / FX, hw, h, horizon, true) >= HAZARD_SAFE + pad && this.room(s, me, d) >= HAZARD_SAFE) return;
    // Keep the guard, not the swing.
    this.queue.length = 0;
    this.steer(0);
  }

  /** How this bot likes to fight: the fighter's playstyle profile, which weights spacing, grabs, projectiles and air time. */
  private style(me: Fighter): Playstyle {
    return this.styleOverride ? PLAYSTYLE[this.styleOverride] : profileFor(me.char);
  }

  private random(): number {
    let v: number;
    [this.rng, v] = rngNext(this.rng);
    return v / 4294967296;
  }

  private reaction(): number {
    const e = this.sloppy();
    return 6 + Math.round(e * e * 10 + e * 14) + Math.floor(this.random() * 4);
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
      // Not a platform that sits in a fog pit, unless nothing else is left.
      if (this.pits.has(i) && !(this.state && this.state.frame < this.braveUntil) && this.pits.size < this.stage.platforms.filter((q) => q.solid).length) continue;
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
    if (me.action === ACT.GRAB_HOLD) return this.throwHeld(s, me);
    if (me.action === ACT.GRAB || me.action === ACT.THROW) {
      this.wait = 2;
      return;
    }
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
    this.rec = null;
    this.avoiding = false;
    if (this.hazardous && this.avoidHazards(s, me)) return;

    const target = this.pickTarget(s, me);
    if (!target) return;
    this.fight(me, target);
  }

  /**
   * Holding a fighter: throw them toward the nearer blast zone (forward or back, whichever way that is). A
   * target at kill damage on a high stage floor goes up instead, and one at low damage goes down, close, for a follow-up.
   */
  private throwHeld(s: GameState, me: Fighter): void {
    this.wait = 2;
    if (me.frame < 8) return;
    const v = me.holding ? s.fighters[me.holding - 1] : null;
    const blast = this.stage.blast;
    const x = me.x / FX;
    const nearer = x - blast.left < blast.right - x ? -1 : 1;
    const high = v !== null && v.percent > 1100 - this.level * 30;
    const low = v !== null && v.percent < 200 && this.random() < 0.5;
    if (low) this.press(0, -100, BTN.ATTACK, 2);
    else if (high && this.random() < 0.35) this.press(0, 100, BTN.ATTACK, 2);
    else this.press(nearer * 100, 0, BTN.ATTACK, 2);
  }

  private offstage(me: Fighter): boolean {
    if (me.grounded) return false;
    const x = me.x / FX;
    const y = me.y / FX;
    const h = this.home(x);
    return x < h.x1 - 10 || x > h.x2 + 10 || y < h.y - 20;
  }

  /** How far from a sharp player this bot is: 0 at level 9, 1 at level 1. */
  private sloppy(): number {
    return (9 - this.level) / 8;
  }

  /**
   * Back to the stage. Level sets how well: a late start (reaction), a late jump or up special (timing), forgetting the
   * up special altogether, and at the bottom steering the wrong way. Level 9 makes none of these.
   */
  private recover(me: Fighter, to?: Platform): void {
    const x = me.x / FX;
    const y = me.y / FX;
    const h = to ?? this.home(x);
    const e = this.sloppy();
    if (!this.rec) {
      this.recoveries++;
      this.rec = {
        since: this.state ? this.state.frame : 0,
        late: e * e * 330 * this.random(),
        spLate: e * 160 * this.random(),
        forgetSp: this.random() < e * e * 0.6,
        drift: this.random() < e * e * 0.3,
        delay: Math.floor(e * e * 40 * this.random()),
      };
    }
    const r = this.rec;
    let toward = x > (h.x1 + h.x2) / 2 ? -100 : 100;
    if (r.drift) toward = -toward;
    const gap = x < h.x1 ? h.x1 - x : x > h.x2 ? x - h.x2 : 0;
    this.wait = 3 + Math.round(e * 3);
    if (me.action === ACT.HELPLESS || me.action === ACT.ATTACK || me.action === ACT.AIRDODGE) {
      this.steer(toward);
      return;
    }
    // A low-level bot takes a moment to see it is off the stage.
    if (this.state && this.state.frame - r.since < r.delay) {
      this.steer(0);
      return;
    }
    const falling = me.vy <= 0;
    if (me.jumpsLeft > 0 && falling && y < h.y + 80 - r.late) {
      this.press(toward, 0, BTN.JUMP, 2);
      return;
    }
    // Out of jumps: the up special. An angled one is aimed by the stick, so the bot points it at the ledge; a
    // straight or gliding one only steers a little, and the bot leans toward the stage while it climbs.
    const angled = this.recoveryVariant(me) === 'angled';
    if (!r.forgetSp && me.jumpsLeft === 0 && falling && (y < h.y - 60 - r.spLate || gap > 160 || (angled && gap > 60))) {
      this.press(angled ? toward : toward * 0.4, 100, BTN.SPECIAL);
      return;
    }
    this.steer(toward);
  }

  /**
   * On the ledge: how long to hang and which of the four options. Level 1 and 2 climb the same way every time, and
   * sometimes hang until the hang runs out; from level 3 the bot mixes getup, roll, jump and attack, and from level 5 it
   * reads the opponent: attack a target at the edge, jump or roll away from a swing, getup when the way is clear.
   */
  private ledge(me: Fighter): void {
    const s = this.state;
    const e = this.sloppy();
    this.wait = 2;
    const hangFor = 10 + Math.floor((1 - e) * 30 * this.random() + e * e * 150 * this.random());
    const gone = this.random() < e * e * 0.05;
    const held = ledges(this.stage)[me.ledge - 1];
    // A hazard is crossing the top of the ledge (a skater over a pillar): climbing up only puts the bot back in its way,
    // so it lets go and drops to the floor instead.
    if (s && held && this.hazardous && this.ledgeTopInDanger(s, me, held.x, held.y)) {
      this.press(0, -100, 0, 3);
      this.lastLedge = 'drop';
      return;
    }
    if (me.frame < hangFor || (gone && me.frame < 400)) return;
    const toward = held ? -held.side * 100 : 0;
    const t = s ? this.pickTarget(s, me) : null;
    const getup = (): string => (this.press(toward, 0, 0, 2), 'getup');
    const jump = (): string => (this.press(0, 0, BTN.JUMP, 4), 'jump');
    const attack = (): string => (this.press(0, 0, BTN.ATTACK), 'attack');
    const roll = (): string => (this.press(0, 0, BTN.SHIELD, 2), 'roll');
    const r = this.random();
    if (this.level <= 2) {
      this.lastLedge = r < 0.85 ? getup() : jump();
      return;
    }
    if (this.level <= 4 || !t) {
      this.lastLedge = r < 0.4 ? getup() : r < 0.6 ? jump() : r < 0.8 ? attack() : roll();
      return;
    }
    // Level 5 and up: read the opponent standing over the ledge.
    const dx = Math.abs(t.x - me.x) / FX;
    const dy = Math.abs(t.y - me.y) / FX;
    const near = dx < 170 && dy < 140;
    const swinging = t.action === ACT.ATTACK;
    const guarding = t.action === ACT.SHIELD || t.action === ACT.SHIELD_STUN;
    const sharp = this.random() < 0.55 + 0.45 * (1 - e);
    if (!sharp) this.lastLedge = r < 0.5 ? getup() : r < 0.75 ? roll() : jump();
    else if (near && swinging) this.lastLedge = r < 0.6 ? roll() : jump();
    else if (near && guarding) this.lastLedge = r < 0.5 ? roll() : jump();
    else if (near) this.lastLedge = t.percent > 1000 - this.level * 40 || r < 0.45 ? attack() : r < 0.75 ? jump() : roll();
    else this.lastLedge = r < 0.5 ? getup() : r < 0.8 ? roll() : jump();
  }

  // ---------------------------------------------------------------- stage hazards

  /** This frame's read of what the stage will hurt (cached per frame). */
  private read(s: GameState, me: Fighter): Dangers {
    if (!this.dangers || this.dangersAt !== s.frame) {
      this.dangers = readDangers(this.stage, s, me, s.frame < this.braveUntil);
      this.dangersAt = s.frame;
    }
    return this.dangers;
  }

  /**
   * Whether the bot has taken in what the stage is doing. Higher levels see a warning the frame it shows; lower ones
   * a beat later (up to 2.4 s at level 1, when the warning is nearly over), and the lowest sometimes never do, so
   * they still get caught. Fog pits that are always there are seen from level 3.
   */
  private aware(s: GameState, d: Dangers): boolean {
    if (!d.event) {
      this.dangerSince = -1;
      return this.level >= 3;
    }
    if (this.dangerSince < 0) {
      this.dangerSince = s.frame;
      this.oblivious = this.random() < Math.max(0, 4 - this.level) * 0.2;
    }
    return !this.oblivious && s.frame - this.dangerSince >= (9 - this.level) * 18;
  }

  /** Whether the spot a getup lands on (the ledge's top) is in the way of a hazard the bot has seen coming. */
  private ledgeTopInDanger(s: GameState, me: Fighter, x: number, y: number): boolean {
    const d = this.read(s, me);
    if (!d.circles.length && !d.rects.length) return false;
    if (!this.aware(s, d)) return false;
    const [hw, h] = bodyOf(me);
    return clearance(d, x, y, hw, h, Infinity, true) < HAZARD_SAFE;
  }

  /** Room for the bot standing at x (its height now); in the air, the least of that and the room where it would land. */
  private room(s: GameState, me: Fighter, d: Dangers, atX = me.x / FX): number {
    const [hw, h] = bodyOf(me);
    const y = me.y / FX;
    const here = clearance(d, atX, y, hw, h, Infinity, true);
    if (me.grounded && atX === me.x / FX) return here;
    // Highest platform top under the body.
    let top = -Infinity;
    this.stage.platforms.forEach((p, i) => {
      if (!platformOn(this.stage, s, i)) return;
      const a = platformAt(p, s.frame);
      if (atX < a.x1 / FX || atX > a.x2 / FX || a.y / FX > y + 4) return;
      top = Math.max(top, a.y / FX);
    });
    return top === -Infinity ? here : Math.min(here, clearance(d, atX, top, hw, h, Infinity, true));
  }

  /** True when the bot has seen a danger and its spot is in the way. */
  private hazardAlarm(s: GameState): boolean {
    const me = s.fighters[this.id];
    if (me.action === ACT.DEAD || me.action === ACT.RESPAWN || me.action === ACT.HITSTUN || me.action === ACT.LEDGE || s.over) return false;
    const d = this.read(s, me);
    if (!d.circles.length && !d.rects.length) {
      this.dangerSince = -1;
      return false;
    }
    if (!this.aware(s, d)) return false;
    return this.room(s, me, d) < HAZARD_SAFE + (d.event ? this.lagPad(me) : 0);
  }

  /** Moves out of the way when the bot's spot is in a hazard's path or zone: true when it acted. */
  private avoidHazards(s: GameState, me: Fighter): boolean {
    const d = this.read(s, me);
    if (!d.circles.length && !d.rects.length) {
      this.dangerSince = -1;
      return false;
    }
    if (!this.aware(s, d)) return false;
    const [hw, h] = bodyOf(me);
    if (this.room(s, me, d) >= HAZARD_SAFE + (d.event ? this.lagPad(me) : 0)) return false;
    // Stick to the spot picked a moment ago while it stays clear (no dithering between two equal ways out).
    let spot = this.spot;
    if (!spot || s.frame - this.spotAt > 120 || clearance(d, spot.x, spot.y, hw, h, Infinity, true) < HAZARD_SAFE) {
      spot = this.safeSpot(s, me, d, hw, h);
      this.spot = spot;
      this.spotAt = s.frame;
    }
    if (!spot) return false;
    this.avoiding = true;
    this.queue.length = 0;
    this.goTo(me, spot.x, spot.y, spot.p);
    return true;
  }

  /** The nearest standing spot with room around it: a platform top, sampled along its length. */
  private safeSpot(s: GameState, me: Fighter, d: Dangers, hw: number, h: number): { x: number; y: number; p: Platform } | null {
    const mx = me.x / FX;
    const my = me.y / FX;
    let best: { x: number; y: number; p: Platform } | null = null;
    let bestCost = Infinity;
    let roomy: { x: number; y: number; p: Platform } | null = null;
    let roomyClear = -Infinity;
    this.stage.platforms.forEach((p, i) => {
      if (!platformOn(this.stage, s, i)) return;
      const a = platformAt(p, s.frame);
      const x1 = a.x1 / FX + hw * 0.5;
      const x2 = a.x2 / FX - hw * 0.5;
      const y = a.y / FX;
      const n = Math.max(1, Math.ceil((x2 - x1) / 40));
      for (let k = 0; k <= n; k++) {
        const x = n === 0 || x2 <= x1 ? (a.x1 + a.x2) / FX / 2 : x1 + ((x2 - x1) * k) / n;
        const c = clearance(d, x, y, hw, h, Infinity, true);
        if (c > roomyClear) {
          roomyClear = c;
          roomy = { x, y, p };
        }
        if (c < HAZARD_SAFE + 12) continue;
        // Walking is cheap, a hop up dearer, and a rise past two jumps (a climb out of a pit) dearest.
        const rise = Math.max(0, y - my);
        const cost = Math.abs(x - mx) + 0.4 * Math.max(0, my - y) + 1.6 * Math.min(rise, 200) + 8 * Math.max(0, rise - 200);
        if (cost < bestCost) {
          bestCost = cost;
          best = { x, y, p };
        }
      }
    });
    // Nowhere with room (a damage zone over the whole stage): there is nothing to run to, so the bot fights on.
    return best ?? (roomyClear >= HAZARD_SAFE ? roomy : null);
  }

  /** Walks, hops up or drops down to a standing spot. */
  private goTo(me: Fighter, sx: number, sy: number, p: Platform): void {
    const mx = me.x / FX;
    const my = me.y / FX;
    const dx = sx - mx;
    const way = Math.sign(dx) * 100;
    // A long climb (out of a fog pit) is a recovery: jumps, up special, the ledge.
    if (sy > my + 215) {
      const here = me.grounded && me.platform >= 0 ? this.stage.platforms[me.platform] : null;
      // On the ground of a pit: walk to the edge nearest the way out first, so the jump starts beside it.
      if (here) {
        const edge = dx > 0 ? here.x2 - 40 : here.x1 + 40;
        if (Math.abs(edge - mx) > 30 && Math.sign(edge - mx) === Math.sign(dx)) {
          this.steer(Math.sign(dx) * 100);
          this.wait = 3;
          return;
        }
      }
      return this.recover(me, p);
    }
    this.wait = 3;
    if (!me.grounded) {
      this.steer(Math.abs(dx) > 12 ? way : 0);
      if (sy > my + 20 && me.vy <= 0 && me.jumpsLeft > 0 && me.action !== ACT.HELPLESS) this.press(way * 0.6, 0, BTN.JUMP, 2);
      return;
    }
    if (sy > my + 50) {
      // Up: walk under it, then jump (the second jump comes in the air).
      if (Math.abs(dx) < 70) {
        this.press(Math.sign(dx) * 30, 0, BTN.JUMP, 8);
        return;
      }
      this.steer(way);
      return;
    }
    const under = me.platform >= 0 ? this.stage.platforms[me.platform] : null;
    if (sy < my - 50 && under?.solid) {
      // Down off a solid platform: walk off the end toward the spot, or the nearer end when the spot is under it.
      const out = sx > under.x2 ? 1 : sx < under.x1 ? -1 : mx - under.x1 < under.x2 - mx ? -1 : 1;
      this.steer(out * 100);
      return;
    }
    if (sy < my - 50 && Math.abs(dx) < 90) {
      // Down: fall through a soft platform.
      this.queue.push({ sx: 0, sy: 0, btn: 0, frames: 1 }, { sx: 0, sy: -100, btn: 0, frames: 4 });
      return;
    }
    this.steer(Math.abs(dx) > 14 ? way : 0);
  }

  /** Whether a fog or other damage zone that is always there lies between two platforms. */
  private zoneBetween(a: Platform, b: Platform): boolean {
    const lo = Math.min(a.x2, b.x2, a.x1, b.x1);
    const hi = Math.max(a.x2, b.x2, a.x1, b.x1);
    return (this.stage.zones ?? []).some((z) => z.kind === 'damage' && !z.during && z.x2 > lo && z.x1 < hi);
  }

  /**
   * Runs after a decision: from a safe spot, never walk, hop or dash into the way of a warned hazard. The held stick
   * and the queued presses lose their sideways part when it would carry the bot into one.
   */
  private guardSteer(s: GameState): void {
    if (this.avoiding) return;
    const me = s.fighters[this.id];
    const d = this.read(s, me);
    if (!d.circles.length && !d.rects.length) return;
    if (!this.aware(s, d)) return;
    const x = me.x / FX;
    const now = this.room(s, me, d);
    const bad = (sx: number, reach: number): boolean => {
      const ahead = this.room(s, me, d, x + Math.sign(sx) * reach);
      return ahead < HAZARD_SAFE && ahead < now;
    };
    if (this.hold.sx !== 0 && bad(this.hold.sx, 90)) this.steer(0, this.hold.sy);
    if (this.queue.some((q) => q.sx !== 0 && bad(q.sx, 140))) for (const q of this.queue) q.sx = 0;
  }

  /**
   * Level 6 and up: when a hazard is about to cross near the target, the side it comes from. -1 or 1 is the direction
   * a launch should send the target (toward the hazard); 0 means no use being made of it.
   */
  private lure(me: Fighter, t: Fighter): number {
    const s = this.state;
    if (!s || !this.hazardous || this.level < 6) return 0;
    const d = this.read(s, me);
    const [hw, h] = bodyOf(me);
    if (clearance(d, me.x / FX, me.y / FX, hw, h) < HAZARD_SAFE + 20) return 0;
    const tx = t.x / FX;
    const ty = t.y / FX;
    let best = 0;
    let bestD = 650;
    for (const c of d.circles) {
      if (c.t > 150 || Math.abs(c.y - ty) > 420) continue;
      const gap = Math.abs(c.x - tx);
      if (gap < 90 || gap >= bestD) continue;
      bestD = gap;
      best = Math.sign(c.x - tx);
    }
    return best;
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

  /**
   * Up close, a fighter with a kit mixes it into its swings: a grab (through a shield) or a flurry first, a dash
   * or a counter as the fight allows. The chances grow with the level.
   */
  private closeSpecial(me: Fighter, side: number, skill: number, ps: Playstyle): boolean {
    if (!CHARACTERS[me.char].specials) return false;
    const r = this.random();
    if (r >= 0.12 + skill * 0.22) return false;
    for (const kind of ['grab', 'flurry', 'counter', 'dash'] as const) {
      if (this.special(me, kind, side, kind === 'grab' ? 0.55 * ps.grab : 0.55)) return true;
    }
    return false;
  }

  /** How the fighter's up special moves: aimed by the stick (angled), a glide, or a straight climb. */
  private recoveryVariant(me: Fighter): 'angled' | 'glide' | 'straight' {
    const up = CHARACTERS[me.char].moves[MOVE.UPB];
    if (!up.helpless) return 'glide';
    return up.drive?.[0]?.aim ? 'angled' : 'straight';
  }

  /** Uses a special by its archetype: true when it was pressed. */
  private special(me: Fighter, kind: SpecialKind, side: number, chance: number, frames = 1): boolean {
    const slot = this.slotOf(me, kind);
    if (!slot || this.random() >= chance) return false;
    // A dash carries the bot a long way: not while the stage is warning or running something at it.
    if (kind === 'dash' && this.hazardous && this.state) {
      const d = this.read(this.state, me);
      if (d.event && this.aware(this.state, d)) return false;
    }
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

  /** True when `t` is in the startup wind-up tell of a smash or special that threatens `me`. */
  private windupThreat(me: Fighter, t: Fighter): boolean {
    if (t.action !== ACT.ATTACK || (!isSmashMove(t.move) && !isSpecialMove(t.move))) return false;
    const tm = CHARACTERS[t.char].moves[t.move];
    const start = moveStartFrame(tm);
    if (!inWindupTell(t.action, t.move, t.frame, start)) return false;
    const dx = (t.x - me.x) / FX;
    const dy = (t.y - me.y) / FX;
    const adx = Math.abs(dx);
    const ch = CHARACTERS[t.char];
    const reach = (50 + ch.width * 0.5 + (ch.height - 110) * 0.4) * ch.tuning.reach * (t.scale / 100);
    if (tm.shot?.kind === 0) {
      return t.facing === Math.sign(me.x - t.x) && adx < 540 && Math.abs(dy) < 90;
    }
    return adx < reach + (tm.kind === 'dash' ? 220 : 120) && Math.abs(dy) < 110;
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
    const ps = this.style(me);
    const keep = reach * ps.spacing;
    if (this.state && adx < reach * 2 && Math.abs(dy) < 150) this.lastClose = this.state.frame;
    const busy = me.action === ACT.ATTACK || me.action === ACT.LAND || me.action === ACT.JUMPSQUAT;
    if (busy) return;
    // A lower-level bot hesitates now and then: a beat of standing still instead of the next move.
    if (this.state && me.grounded && this.random() < this.sloppy() * 0.34) {
      this.wait = 6;
      return;
    }

    const h = this.home(mx);
    const towardEdge = side > 0 ? h.x2 - mx : mx - h.x1;
    const nearEdge = towardEdge < 50;

    // Read an opponent's special or smash wind-up tell and dodge (or counter) before the active frame comes out.
    if (this.level >= 8 && this.windupThreat(me, t)) {
      const tm = CHARACTERS[t.char].moves[t.move];
      if (me.grounded) {
        if (tm.kind !== 'grab' && me.facing === Math.sign(dx) && this.special(me, 'counter', side, 0.35)) return;
        if (tm.kind === 'grab' || this.random() < 0.72) {
          const backEdge = side > 0 ? mx - h.x1 < 60 : h.x2 - mx < 60;
          if (!backEdge && this.random() < 0.6) {
            this.queue.push({ sx: 0, sy: 0, btn: BTN.SHIELD, frames: 1 }, { sx: -side, sy: 0, btn: BTN.SHIELD, frames: 2 });
          } else {
            this.queue.push({ sx: 0, sy: 0, btn: BTN.SHIELD, frames: 1 }, { sx: 0, sy: -100, btn: BTN.SHIELD, frames: 2 });
          }
        } else {
          this.press(0, 0, BTN.SHIELD, 8 + Math.floor(this.random() * 6));
        }
        return;
      }
      if (me.action === ACT.AIR) {
        this.press(-side, 20, BTN.SHIELD, 2);
        return;
      }
    }

    // Defend against an attack that is about to come out.
    // A low-level bot sees the swing late: it only reacts once the move is well under way.
    const threat = t.action === ACT.ATTACK && adx < reach + 60 && Math.abs(dy) < 90 && t.frame >= Math.round(this.sloppy() * 10);
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

    // Punish a target that just finished swinging (especially a whiffed special or smash) or is stuck landing.
    const tm = t.action === ACT.ATTACK ? CHARACTERS[t.char].moves[t.move] : null;
    const whiffEndlag = tm !== null && (isSmashMove(t.move) || isSpecialMove(t.move)) && t.frame > moveEndFrame(tm);
    const open = t.action === ACT.LAND || t.action === ACT.DIZZY || t.action === ACT.HELPLESS || whiffEndlag;
    const killPercent = 900 - this.level * 30;
    const targetHome = this.home(t.x / FX);

    if (me.grounded) {
      // A shielding opponent is grabbed, not hit: grab beats shield. Step in until the jab's reach, then Shield + Attack.
      const guarding = t.grounded && (t.action === ACT.SHIELD || t.action === ACT.SHIELD_STUN) && Math.abs(dy) < 50 * k;
      if (guarding && adx < reach * 1.3) {
        this.wait = 2;
        const grabReach = ch.grabReach * k;
        if (me.facing === Math.sign(dx) && adx < grabReach * 0.9) {
          if (this.random() < Math.min(1, (0.6 + skill * 0.4) * Math.min(1, 0.3 + ps.grab * 0.5))) {
            this.press(0, 0, BTN.ATTACK | BTN.SHIELD, 2);
            return;
          }
        } else if (!nearEdge || me.facing !== Math.sign(dx)) {
          this.steer(side * 0.6);
          return;
        }
      }
      if (adx < reach && Math.abs(dy) < 50 * k) {
        const lure = this.lure(me, t);
        if (lure !== 0 && me.facing === Math.sign(dx)) {
          if (side === lure * 100) {
            // The hazard is on the far side of them: a smash sends them into it.
            if (this.random() < 0.75) {
              this.press(side, 0, side > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
              return;
            }
          } else if (this.state && this.state.frame - this.lureHopAt > 90 && !nearEdge) {
            // Wrong side: hop over them so the next swing launches toward the hazard.
            this.lureHopAt = this.state.frame;
            this.press(side, 0, BTN.JUMP, 6);
            this.queue.push({ sx: side, sy: 0, btn: 0, frames: 22 });
            return;
          }
        }
        if (nearEdge) {
          // Facing out over the edge: the forward smash sends them far.
          this.press(side, 0, side > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
        } else if ((t.percent > killPercent || open) && this.random() < (0.5 + skill * 0.3) * Math.min(1.4, ps.smash)) {
          this.press(side, 0, this.random() < 0.6 ? (side > 0 ? BTN.C_RIGHT : BTN.C_LEFT) : BTN.C_DOWN);
        } else if (me.facing === Math.sign(dx) && this.closeSpecial(me, side, skill, ps)) {
          return;
        } else if (me.facing === Math.sign(dx) && adx < ch.grabReach * k * 0.9 && t.action !== ACT.ATTACK && this.random() < (0.06 + skill * 0.1) * ps.grab) {
          // Mix in a grab: it opens a defender who is waiting to shield, and costs little against one who is not swinging.
          this.press(0, 0, BTN.ATTACK | BTN.SHIELD, 2);
        } else {
          const r = this.random();
          if (r < 0.35) this.press(0, 0, BTN.ATTACK);
          else if (r < 0.7) this.press(side, 0, BTN.ATTACK);
          else if (r < 0.85) this.press(side * 0.3, -100, BTN.ATTACK);
          else if (me.facing === Math.sign(dx) && (this.special(me, 'grab', side, 0.5 * ps.grab) || this.special(me, 'flurry', side, 0.6))) return;
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
        // The target is off stage: wait near the ledge they have to come back to, and lay a trap on it (or a
        // projectile out over the gap) so the recovery has something to land on.
        const post = tx > (targetHome.x1 + targetHome.x2) / 2 ? targetHome.x2 - 60 : targetHome.x1 + 60;
        const gap = post - mx;
        if (Math.abs(gap) < 70 && me.facing === Math.sign(dx)) {
          if (this.special(me, 'trap', side, 0.25 + skill * 0.5, 3)) return;
          if (adx < 560 && this.special(me, 'projectile', side, 0.1 + skill * 0.25)) return;
        }
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
        // Over a fog pit the bot waits at the edge for them to come. A stand-off nobody breaks ends with a short
        // wade across, then it climbs out again.
        if (this.hazardous && this.level >= 3 && this.state && this.zoneBetween(h, targetHome) && this.state.frame >= this.braveUntil) {
          if (this.state.frame - this.lastClose < 900) {
            this.steer(0);
            return;
          }
          this.braveUntil = this.state.frame + 360;
          this.lastClose = this.state.frame;
          this.dangersAt = -1;
        }
        // The target is on another island: jump the gap.
        this.press(side, 0, BTN.JUMP, 8);
        this.queue.push({ sx: side, sy: 0, btn: 0, frames: 14 }, { sx: side, sy: 0, btn: BTN.JUMP, frames: 2 });
        return;
      }
      // A fighter with its own specials uses them by archetype: a thrown projectile down the lane, a trap on the
      // way in, a dash to close the distance.
      if (ch.specials && me.facing === Math.sign(dx)) {
        const lane = Math.abs(dy) < 60;
        // Harder bots reach for the kit more often: every chance below grows with the level.
        if (adx > 200 && adx < 640 && lane && this.special(me, 'projectile', side, (0.08 + skill * 0.14) * ps.projectile)) return;
        if (adx > 110 && adx < 320 && this.special(me, 'trap', side, (0.03 + skill * 0.06) * ps.projectile, 3)) return;
        // A trap by the ledge the target is about to be pushed off, or a stage edge they are standing at.
        const edge = t.grounded && Math.min(t.x / FX - targetHome.x1, targetHome.x2 - t.x / FX) < 90;
        if (edge && adx > 90 && adx < 420 && this.special(me, 'trap', side, (0.04 + skill * 0.1) * ps.projectile, 3)) return;
        if (adx > 170 && adx < 460 && lane && this.special(me, 'dash', side, (0.06 + skill * 0.1) * ps.aggression)) return;
        // A grab or a flurry is a close-range move: step in with it when the swing is nearly in reach.
        if (adx > reach * 0.8 && adx < reach * 1.5 && lane && (this.special(me, 'grab', side, (0.03 + skill * 0.06) * ps.grab) || this.special(me, 'flurry', side, (0.03 + skill * 0.06) * ps.aggression))) return;
      }
      // A zoner keeps its room: too close and it backs off (unless the edge is behind it), in range it holds and
      // waits for you to come in; only now and then does it walk in itself. A rushdown never waits.
      if (ps.spacing > 1.8 && adx < keep * 1.25) {
        const backEdge = side > 0 ? mx - h.x1 < 70 : h.x2 - mx < 70;
        if (adx < keep * 0.8 && !backEdge && adx > reach * 0.5) {
          this.steer(-side);
          this.wait = 4;
          return;
        }
        if (adx >= keep * 0.8 && this.random() > ps.aggression) {
          this.steer(0);
          return;
        }
      }
      if (adx > reach * 0.8) {
        // Approach, sometimes with a short hop aerial (an aerial fighter hops in far more).
        const hop = Math.min(0.9, (0.25 + skill * 0.15) * ps.air);
        if (adx < 240 * Math.max(1, ps.air * 0.8) && this.random() < hop) {
          this.press(side, 0, BTN.JUMP, 1);
          this.queue.push({ sx: side, sy: 0, btn: 0, frames: 6 });
          this.press(side, 0, BTN.ATTACK);
          return;
        }
        this.steer(nearEdge && targetHome === h ? 0 : side);
        if (ps.air > 1.5 && adx > 240 && this.random() < 0.08 * ps.air) {
          // Full hop across the gap, drifting in to land the aerial.
          this.press(side, 0, BTN.JUMP, 6);
          this.queue.push({ sx: side, sy: 0, btn: 0, frames: 12 });
        }
        return;
      }
      this.steer(side * 0.3);
      return;
    }

    // In the air near the stage: a fighter with a kit throws or dashes across the gap before it swings.
    if (ch.specials && adx > 200 && adx < 560 && Math.abs(dy) < 90 && me.facing === Math.sign(dx)) {
      if (this.special(me, 'projectile', side, 0.04 + skill * 0.1) || this.special(me, 'dash', side, 0.03 + skill * 0.07)) return;
    }
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
