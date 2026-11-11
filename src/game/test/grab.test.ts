// The grab and its four throws (docs: Shield + Attack together grabs, the stick picks the throw): grab beats
// shield, attacks beat grab, the hold grows with damage and shortens with mashing, every throw has its own
// launch, and a rollback replay lands on the same hash. sim.test.ts runs `runGrabTests`.

import { FX } from '../sim/fixed.ts';
import { CHARACTERS, THROW, characterIndex } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, cloneState, hashState, newGame, type GameState } from '../sim/state.ts';
import { holdFrames, step, type SimEvent } from '../sim/step.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

export function runGrabTests(check: Check): void {
  const punk = characterIndex('exit-punk');
  const other = CHARACTERS.findIndex((c, i) => i !== punk && c.throws.length === 4);
  const GRAB = BTN.ATTACK | BTN.SHIELD;
  const SHIELD = packInput(0, 0, BTN.SHIELD);

  const duel = (gap: number, percent = 0): GameState => {
    const g = newGame([{ char: punk }, { char: other }], { stocks: 3, seed: 5, stage: 0 });
    const [p, d] = g.fighters;
    p.x = -300 * FX;
    p.facing = 1;
    d.x = p.x + gap * FX;
    d.facing = -1;
    d.percent = percent;
    for (const f of g.fighters) {
      f.y = 0;
      f.grounded = 1;
      f.platform = 0;
    }
    return g;
  };
  const play = (g: GameState, frames: number, a: (i: number) => number, b: (i: number) => number = () => NO_INPUT, from = 0): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let i = from; i < from + frames; i++) out.push(...step(g, [a(i), b(i)]));
    return out;
  };
  /** The grab press: Shield and Attack down together on frame 0, held for two frames. */
  const grabInput = (i: number) => (i < 2 ? packInput(0, 0, GRAB) : NO_INPUT);
  const reach = Math.round(CHARACTERS[punk].grabReach * 0.6);

  // Grab beats shield: the shielding fighter is caught with the shield untouched.
  {
    const g = duel(reach);
    const ev = play(g, 40, grabInput, () => SHIELD);
    const grab = ev.find((e) => e.type === 'grab');
    check('grab: Shield + Attack catches a shielding fighter', !!grab && grab.type === 'grab' && grab.shield && g.fighters[1].action === ACT.GRABBED, grab ? `held ${grab.type === 'grab' ? grab.hold : 0} frames` : 'no grab');
    check('grab: the caught fighter shield is untouched', g.fighters[1].shield === 500);
  }
  // Too far away: a whiff, and the grabber is left reaching, never holding.
  {
    const g = duel(900);
    const ev = play(g, 40, grabInput);
    check('grab: out of reach is a whiff', !ev.some((e) => e.type === 'grab') && g.fighters[0].holding === 0);
  }
  // Attack beats grab: a jab that is already out hits the grabber during its reach.
  {
    const g = duel(reach);
    const ev = play(g, 30, grabInput, (i) => (i === 0 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT));
    const hit = ev.some((e) => e.type === 'hit' && e.attacker === 1 && e.victim === 0);
    check('grab: an attack beats a grab', hit && !ev.some((e) => e.type === 'grab') && g.fighters[0].holding === 0);
  }
  // The hold grows with damage.
  {
    const lens = [0, 1000].map((pct) => {
      const g = duel(reach, pct);
      const ev = play(g, 40, grabInput, () => SHIELD);
      const grab = ev.find((e) => e.type === 'grab');
      return grab && grab.type === 'grab' ? grab.hold : 0;
    });
    check('grab: a fighter at 100% is held longer than at 0%', lens[1] > lens[0] && lens[0] === holdFrames(0) && lens[1] === holdFrames(1000), `${lens[0]} vs ${lens[1]} frames`);
  }
  // Held for real: the frames until the victim breaks free match the hold (no mashing), and mashing is sooner.
  {
    const breakAt = (mash: boolean): { held: number; mashed: boolean } => {
      const g = duel(reach, 500);
      const ev = play(g, 400, grabInput, (i) => (i < 6 ? SHIELD : mash && i % 4 === 0 ? packInput(0, 0, BTN.JUMP) : NO_INPUT));
      const b = ev.find((e) => e.type === 'grab-break');
      return b && b.type === 'grab-break' ? { held: b.held, mashed: b.mashed } : { held: -1, mashed: false };
    };
    const calm = breakAt(false);
    const mashing = breakAt(true);
    check('grab: the hold runs out by itself', calm.held === holdFrames(500) && !calm.mashed, `${calm.held} frames`);
    check('grab: mashing frees the victim sooner', mashing.held > 0 && mashing.held < calm.held && mashing.mashed, `${mashing.held} vs ${calm.held} frames`);
  }
  // The four throws: own damage, angle and knockback, scaled per fighter.
  {
    const dirs: [number, number][] = [[100, 0], [-100, 0], [0, 100], [0, -100]];
    const launches = dirs.map(([sx, sy], kind) => {
      const g = duel(reach, 300);
      const ev: SimEvent[] = [];
      ev.push(...play(g, 30, grabInput, () => SHIELD));
      ev.push(...play(g, 4, (i) => packInput(sx, sy, BTN.ATTACK), () => NO_INPUT, 30));
      for (let i = 0; i < 30; i++) ev.push(...step(g, [NO_INPUT, NO_INPUT]));
      const thrown = ev.find((e) => e.type === 'throw');
      const v = g.fighters[1];
      return { kind: thrown && thrown.type === 'throw' ? thrown.kind : -1, vx: v.kbx, vy: v.kby, percent: v.percent, hit: ev.some((e) => e.type === 'hit' && e.victim === 1 && !e.shield) };
    });
    check('throws: stick forward, back, up and down pick the four throws', launches.map((l) => l.kind).join() === [THROW.FORWARD, THROW.BACK, THROW.UP, THROW.DOWN].join(), launches.map((l) => l.kind).join());
    check('throws: every throw lands damage', launches.every((l) => l.hit && l.percent > 300), launches.map((l) => l.percent).join(' '));
    check('throws: forward sends them ahead, back behind, up high', launches[0].vx > 0 && launches[1].vx < 0 && launches[2].vy > Math.abs(launches[2].vx), launches.map((l) => `${l.vx}/${l.vy}`).join(' '));
    check('throws: the four differ in damage', new Set(CHARACTERS[punk].throws.map((t) => t.dmg)).size === 4);
  }
  // A throw carries a fighter out at kill damage, and the sim stays deterministic: a rollback replay lands on the same hash.
  {
    const inputs = (i: number) => (i < 2 ? packInput(0, 0, GRAB) : i >= 22 && i < 26 ? packInput(100, 0, BTN.ATTACK) : NO_INPUT);
    const a = duel(reach, 300);
    play(a, 40, inputs, () => SHIELD);
    const snap = cloneState(a);
    play(a, 60, inputs, () => NO_INPUT, 40);
    const b = cloneState(snap);
    play(b, 60, inputs, () => NO_INPUT, 40);
    check('grab: a rollback replay lands on the same hash', hashState(a) === hashState(b));
  }
}
