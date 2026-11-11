// The seven special archetypes (projectile, dash strike, counter, command grab, placed trap, multi-hit flurry and the
// recovery variants) in the deterministic sim, Exit Punk's four-special kit, and a rollback replay for each that
// lands on the same hash. sim.test.ts runs this file's checks (`runSpecialsTests`).

import { FX } from '../sim/fixed.ts';
import { CHARACTERS, MOVE, characterIndex, fighter } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, cloneState, hashState, newGame, type GameState } from '../sim/state.ts';
import { step, type SimEvent } from '../sim/step.ts';
import { rngNext } from '../sim/fixed.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

const body = { w: 46, h: 110, weight: 95, walk: 6.5, air: 5.5, gravity: 0.62, fall: 11, hop: 150, jumps: 1 };

export function runSpecialsTests(check: Check): void {
  // Test fighters that carry the archetypes Exit Punk doesn't: counter, command grab, flurry, glide and straight recovery.
  const kitA = CHARACTERS.length;
  CHARACTERS.push(fighter('t-kit-a', 'Kit A', 'Test', '', {
    ...body,
    specials: {
      neutral: { type: 'flurry' },
      side: { type: 'counter' },
      up: { type: 'recovery', variant: 'glide' },
      down: { type: 'grab' },
    },
  }));
  const kitB = CHARACTERS.length;
  CHARACTERS.push(fighter('t-kit-b', 'Kit B', 'Test', '', {
    ...body,
    specials: {
      neutral: { type: 'projectile', rise: 5, gravity: 0.3, style: 'orb' },
      up: { type: 'recovery', variant: 'straight' },
      down: { type: 'trap' },
    },
  }));
  const punk = characterIndex('exit-punk');
  const plain = characterIndex('ball-person');

  const RIGHT = 100;
  const duel = (a: number, b: number, gap: number): GameState => {
    const g = newGame([{ char: a }, { char: b }], { stocks: 3, seed: 5, stage: 0 });
    const [p, d] = g.fighters;
    p.x = -300 * FX;
    p.facing = 1;
    d.x = p.x + gap * FX;
    d.facing = gap > 0 ? -1 : 1;
    for (const f of g.fighters) {
      f.y = 0;
      f.grounded = 1;
      f.platform = 0;
    }
    return g;
  };
  /** Runs frames with the inputs of frame i (frame 0 is the first); returns every event. */
  const play = (g: GameState, frames: number, a: (i: number) => number, b: (i: number) => number = () => NO_INPUT, from = 0): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let i = from; i < from + frames; i++) out.push(...step(g, [a(i), b(i)]));
    return out;
  };
  const press = (sx: number, sy: number, btn: number) => (i: number) => (i < 2 ? packInput(sx, sy, btn) : NO_INPUT);
  const hits = (ev: SimEvent[]) => ev.filter((e) => e.type === 'hit' && !e.shield);
  const units = (v: number) => Math.round(v / FX);

  // ---- the four inputs
  {
    const route = (ch: number, sx: number, sy: number): number => {
      const g = duel(ch, plain, 600);
      play(g, 3, () => packInput(sx, sy, BTN.SPECIAL));
      return g.fighters[0].move;
    };
    check('specials: Exit Punk does four different moves from K, K+side, K+down and K+up',
      route(punk, 0, 0) === MOVE.NSPECIAL && route(punk, RIGHT, 0) === MOVE.SSPECIAL && route(punk, 0, -100) === MOVE.DSPECIAL && route(punk, 0, 100) === MOVE.UPB,
      [route(punk, 0, 0), route(punk, RIGHT, 0), route(punk, 0, -100), route(punk, 0, 100)].join(','));
    check('specials: a fighter without specials keeps its Neutral and Up special on every direction',
      route(plain, 0, 0) === MOVE.NSPECIAL && route(plain, RIGHT, 0) === MOVE.NSPECIAL && route(plain, -RIGHT, 0) === MOVE.NSPECIAL && route(plain, 0, -100) === MOVE.NSPECIAL && route(plain, 0, 100) === MOVE.UPB);
    check('specials: the shared moveset of a fighter without specials is untouched (14 authored moves, Neutral special lunges)',
      CHARACTERS[plain].moves[MOVE.NSPECIAL].impulses?.[0]?.vx === 14 && !CHARACTERS[plain].specials && !CHARACTERS[plain].moves[MOVE.NSPECIAL].kind);
    check('specials: side special turns the fighter toward the stick',
      (() => {
        const g = duel(punk, plain, 600);
        play(g, 3, () => packInput(-RIGHT, 0, BTN.SPECIAL));
        return g.fighters[0].facing === -1 && g.fighters[0].move === MOVE.SSPECIAL;
      })());
  }

  // ---- projectile: the thrown board
  {
    const g = duel(punk, plain, 600);
    const start = g.fighters[0].x;
    const ev = play(g, 90, press(0, 0, BTN.SPECIAL));
    check('projectile: the thrown board appears, crosses the stage, hits the dummy and is gone',
      ev.some((e) => e.type === 'shot' && e.kind === 0) && hits(ev).length === 1 && g.shots.length === 0 && g.fighters[1].percent > 0 && g.fighters[1].lastHitBy === 0,
      `${hits(ev).length} hit, dummy ${g.fighters[1].percent / 10}%`);

    const miss = duel(punk, plain, -300);
    let far = 0;
    let seen = 0;
    for (let i = 0; i < 120; i++) {
      step(miss, [press(0, 0, BTN.SPECIAL)(i), NO_INPUT]);
      for (const o of miss.shots) far = Math.max(far, Math.abs(o.x - start));
      seen += miss.shots.length ? 1 : 0;
    }
    check('projectile: a miss flies its whole lifetime (past 700 units) and disappears, hitting nobody',
      miss.shots.length === 0 && seen > 50 && far > 700 * FX && miss.fighters[1].percent === 0, `${units(far)} units, ${seen} frames`);

    const two = duel(punk, plain, -300);
    play(two, 40, (i) => (i % 14 < 2 ? packInput(0, 0, BTN.SPECIAL) : NO_INPUT));
    check('projectile: one board at a time per fighter', two.shots.filter((o) => o.owner === 0 && o.kind === 0).length <= 1);

    const arc = duel(kitB, plain, -300);
    let peak = 0;
    let landedY = 0;
    for (let i = 0; i < 80; i++) {
      step(arc, [press(0, 0, BTN.SPECIAL)(i), NO_INPUT]);
      for (const o of arc.shots) {
        peak = Math.max(peak, o.y);
        landedY = o.y;
      }
    }
    check('projectile: gravity bends a lobbed shot (it rises, then drops)', peak > 40 * FX && landedY < peak, `peak ${units(peak)}`);

    const shielded = duel(punk, plain, 300);
    play(shielded, 60, press(0, 0, BTN.SPECIAL), () => packInput(0, 0, BTN.SHIELD));
    check('projectile: a shield stops it and the shield takes the damage', shielded.shots.length === 0 && shielded.fighters[1].percent === 0 && shielded.fighters[1].shield < 500);
  }

  // ---- dash strike: the skate dash
  {
    const g = duel(punk, plain, 160);
    const x0 = g.fighters[0].x;
    const ev = play(g, 40, press(RIGHT, 0, BTN.SPECIAL));
    check('dash strike: the skate dash covers ground and hits the dummy on the way', hits(ev).length === 1 && g.fighters[1].percent > 0, `moved ${units(g.fighters[0].x - x0)} units`);
    const free = duel(punk, plain, -600);
    const f0 = free.fighters[0].x;
    play(free, 40, press(RIGHT, 0, BTN.SPECIAL));
    check('dash strike: a dash with nobody there still travels 120+ units and stops', free.fighters[0].x - f0 > 120 * FX && free.fighters[0].action === ACT.IDLE, `${units(free.fighters[0].x - f0)} units`);
    const air = duel(punk, plain, -600);
    const a = air.fighters[0];
    a.grounded = 0;
    a.platform = -1;
    a.y = 400 * FX;
    play(air, 14, press(RIGHT, 0, BTN.SPECIAL));
    check('dash strike: in the air only the first dash of a jump carries you', a.airSpecial === 1 && a.x > -300 * FX);
  }

  // ---- counter: turns the hit back
  {
    const g = duel(kitA, plain, 60);
    const dummy = g.fighters[1];
    g.fighters[1].facing = -1;
    const ev = play(g, 70, press(RIGHT, 0, BTN.SPECIAL), (i) => (i === 10 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT));
    check('counter: a hit during the window is turned back on the attacker, and the counterer takes nothing',
      ev.some((e) => e.type === 'counter' && e.id === 0) && dummy.percent > 0 && g.fighters[0].percent === 0 && dummy.lastHitBy === 0,
      `attacker ${dummy.percent / 10}%`);
    const late = duel(kitA, plain, 60);
    play(late, 90, press(RIGHT, 0, BTN.SPECIAL), (i) => (i === 50 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT));
    check('counter: a hit after the window opens is a normal hit', late.fighters[0].percent > 0 && late.fighters[1].percent === 0);
  }

  // ---- command grab
  {
    const g = duel(kitA, plain, 70);
    const ev = play(g, 40, press(0, -100, BTN.SPECIAL));
    check('command grab: connects, pulls the target in front of the fighter and throws', hits(ev).length === 1 && g.fighters[1].percent > 0 && g.fighters[1].action !== ACT.IDLE, `${g.fighters[1].percent / 10}%`);
    const sh = duel(kitA, plain, 70);
    const ev2 = play(sh, 40, press(0, -100, BTN.SPECIAL), () => packInput(0, 0, BTN.SHIELD));
    check('command grab: goes through a raised shield', hits(ev2).length === 1 && sh.fighters[1].percent > 0);
    const whiff = duel(kitA, plain, -600);
    let busy = 0;
    for (let i = 0; i < 80; i++) {
      step(whiff, [press(0, -100, BTN.SPECIAL)(i), NO_INPUT]);
      if (whiff.fighters[0].action === ACT.ATTACK) busy++;
    }
    check('command grab: a whiff is a long recovery (40+ frames)', busy >= 40, `${busy} frames`);
    const air = duel(kitA, plain, 70);
    air.fighters[1].grounded = 0;
    air.fighters[1].platform = -1;
    air.fighters[1].y = 120 * FX;
    const ev3 = play(air, 12, press(0, -100, BTN.SPECIAL));
    check('command grab: cannot grab someone in the air', hits(ev3).length === 0);
  }

  // ---- placed trap: the kickflip
  {
    const g = duel(punk, plain, -600);
    play(g, 20, press(0, -100, BTN.SPECIAL));
    check('trap: the kickflip trap is placed on the floor ahead of the fighter', g.shots.length === 1 && g.shots[0].kind === 1 && g.shots[0].y === 0 && g.shots[0].x > g.fighters[0].x, `${g.shots.length} trap`);
    const owner = g.fighters[0];
    play(g, 60, () => NO_INPUT, () => NO_INPUT, 20);
    check('trap: the owner can stand on it and nothing goes off', g.shots.length === 1 && owner.percent === 0);
    // A second trap replaces the first: never more than one per fighter.
    owner.x += 200 * FX;
    play(g, 30, (i) => press(0, -100, BTN.SPECIAL)(i - 80), () => NO_INPUT, 80);
    check('trap: at most one per fighter (placing another replaces the first)', g.shots.length === 1 && g.shots[0].x > -100 * FX, `${g.shots.length} trap at ${units(g.shots[0]?.x ?? 0)}`);

    const hit = duel(punk, plain, 190);
    const ev = play(hit, 90, press(0, -100, BTN.SPECIAL), (i) => (i >= 12 ? packInput(-RIGHT, 0, 0) : NO_INPUT));
    check('trap: an enemy walking onto it sets it off, takes the hit and the trap is gone',
      hits(ev).length === 1 && hit.shots.length === 0 && hit.fighters[1].percent > 0 && hit.fighters[1].lastHitBy === 0, `dummy ${hit.fighters[1].percent / 10}%`);

    const early = duel(punk, plain, 58);
    play(early, 10, press(0, -100, BTN.SPECIAL));
    check('trap: it does not go off while still arming', early.fighters[1].percent === 0 && early.shots.length <= 1);

    const air = duel(punk, plain, -600);
    air.fighters[0].grounded = 0;
    air.fighters[0].platform = -1;
    air.fighters[0].y = 300 * FX;
    play(air, 20, press(0, -100, BTN.SPECIAL));
    check('trap: needs a floor (in the air the move places nothing)', air.shots.length === 0);
  }

  // ---- multi-hit flurry
  {
    const g = duel(kitA, plain, 64);
    const ev = play(g, 80, press(0, 0, BTN.SPECIAL));
    const n = hits(ev).length;
    check('flurry: five hits land in a row on a standing target, the last one launches', n === 5 && g.fighters[1].percent >= 22 * 4, `${n} hits, ${g.fighters[1].percent / 10}%`);
    const last = hits(ev).pop() as Extract<SimEvent, { type: 'hit' }> | undefined;
    check('flurry: the finisher knocks back harder than the jabs', !!last && last.kb > 3 && hits(ev).slice(0, 4).every((e) => e.type === 'hit' && e.kb < (last?.kb ?? 0)), `finisher kb ${last?.kb}`);
  }

  // ---- recovery variants
  {
    const maxY = (g: GameState, frames: number, input: (i: number) => number) => {
      let top = 0;
      let helpless = 0;
      for (let i = 0; i < frames; i++) {
        step(g, [input(i), NO_INPUT]);
        top = Math.max(top, g.fighters[0].y);
        if (g.fighters[0].action === ACT.HELPLESS) helpless++;
      }
      return { top, helpless };
    };
    const hold = (sx: number) => (i: number) => (i < 2 ? packInput(sx, 100, BTN.SPECIAL) : packInput(sx, 0, 0));
    const angled = duel(punk, plain, -600);
    // Over the left edge, away from the platforms, aimed out over the void.
    angled.fighters[0].x = -700 * FX;
    const r1 = maxY(angled, 60, hold(-RIGHT));
    check('recovery (angled): the ollie climbs 150+ units, carries toward the stick and ends helpless', r1.top > 150 * FX && angled.fighters[0].x < -760 * FX && r1.helpless > 0, `top ${units(r1.top)}, x ${units(angled.fighters[0].x)}`);
    const angledL = duel(punk, plain, 600);
    angledL.fighters[0].x = 300 * FX;
    angledL.fighters[0].facing = 1;
    maxY(angledL, 60, hold(-RIGHT));
    check('recovery (angled): the stick aims it, so holding away turns it around', angledL.fighters[0].x < 300 * FX && angledL.fighters[0].facing === -1);

    const straight = duel(kitB, plain, -600);
    const x0 = straight.fighters[0].x;
    const r2 = maxY(straight, 90, hold(0));
    check('recovery (straight): climbs straight up with no sideways drift, then helpless', r2.top > 150 * FX && Math.abs(straight.fighters[0].x - x0) < 20 * FX && r2.helpless > 0, `top ${units(r2.top)}`);

    const glide = duel(kitA, plain, -600);
    const x1 = glide.fighters[0].x;
    let slow = 0;
    let everHelpless = 0;
    for (let i = 0; i < 60; i++) {
      step(glide, [hold(RIGHT)(i), NO_INPUT]);
      const f = glide.fighters[0];
      if (!f.grounded && f.vy < 0 && f.vy > -3 * FX && f.action === ACT.ATTACK) slow++;
      if (f.action === ACT.HELPLESS) everHelpless++;
    }
    check('recovery (glide): rises a little, then glides forward with a slow fall and is never helpless', slow > 15 && everHelpless === 0 && glide.fighters[0].x - x1 > 150 * FX, `${slow} gliding frames, ${units(glide.fighters[0].x - x1)} units`);

    const ledge = duel(punk, plain, -600);
    const lf = ledge.fighters[0];
    lf.x = -900 * FX;
    lf.grounded = 0;
    lf.platform = -1;
    lf.y = -120 * FX;
    let grabbed = false;
    for (let i = 0; i < 100 && !grabbed; i++) {
      step(ledge, [hold(RIGHT)(i), NO_INPUT]);
      grabbed = lf.action === ACT.LEDGE;
    }
    check('recovery: a recovery special can grab the ledge', grabbed);
  }

  // ---- hashing and rollback
  {
    const g = duel(punk, plain, 600);
    play(g, 12, press(0, 0, BTN.SPECIAL));
    const before = hashState(g);
    g.shots[0].x += FX;
    check('rollback: the desync hash covers projectiles and traps', g.shots.length > 0 && hashState(g) !== before);
  }

  interface Scenario {
    name: string;
    setup: () => GameState;
    a: (i: number) => number;
    b?: (i: number) => number;
    frames: number;
    /** The moment to snapshot: the entity or move is in flight. */
    mid: (g: GameState) => boolean;
  }
  const none = () => NO_INPUT;
  const scenarios: Scenario[] = [
    { name: 'projectile', setup: () => duel(punk, plain, 500), a: press(0, 0, BTN.SPECIAL), frames: 90, mid: (g) => g.shots.some((o) => o.kind === 0) },
    { name: 'dash strike', setup: () => duel(punk, plain, 160), a: press(RIGHT, 0, BTN.SPECIAL), frames: 50, mid: (g) => g.fighters[0].move === MOVE.SSPECIAL && g.fighters[0].frame > 8 },
    { name: 'counter', setup: () => duel(kitA, plain, 60), a: press(RIGHT, 0, BTN.SPECIAL), b: (i) => (i === 10 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT), frames: 80, mid: (g) => g.fighters[0].move === MOVE.SSPECIAL && g.fighters[0].frame > 10 },
    { name: 'command grab', setup: () => duel(kitA, plain, 70), a: press(0, -100, BTN.SPECIAL), frames: 60, mid: (g) => g.fighters[0].move === MOVE.DSPECIAL && g.fighters[0].frame > 8 },
    { name: 'placed trap', setup: () => duel(punk, plain, 190), a: press(0, -100, BTN.SPECIAL), b: (i) => (i >= 12 ? packInput(-RIGHT, 0, 0) : NO_INPUT), frames: 100, mid: (g) => g.shots.some((o) => o.kind === 1) },
    { name: 'multi-hit flurry', setup: () => duel(kitA, plain, 64), a: press(0, 0, BTN.SPECIAL), frames: 80, mid: (g) => g.fighters[0].move === MOVE.NSPECIAL && g.fighters[1].percent > 40 },
    { name: 'recovery (angled)', setup: () => duel(punk, plain, -600), a: (i) => (i < 2 ? packInput(RIGHT, 100, BTN.SPECIAL) : packInput(RIGHT, 0, 0)), frames: 90, mid: (g) => g.fighters[0].move === MOVE.UPB && g.fighters[0].frame > 8 },
    { name: 'recovery (straight)', setup: () => duel(kitB, plain, -600), a: press(0, 100, BTN.SPECIAL), frames: 90, mid: (g) => g.fighters[0].move === MOVE.UPB && g.fighters[0].frame > 8 },
    { name: 'recovery (glide)', setup: () => duel(kitA, plain, -600), a: (i) => (i < 2 ? packInput(RIGHT, 100, BTN.SPECIAL) : packInput(RIGHT, 0, 0)), frames: 90, mid: (g) => g.fighters[0].move === MOVE.UPB && g.fighters[0].frame > 20 },
  ];
  for (const sc of scenarios) {
    const b = sc.b ?? none;
    const ref = sc.setup();
    let snap: GameState | null = null;
    let at = 0;
    for (let i = 0; i < sc.frames; i++) {
      if (!snap && sc.mid(ref)) {
        snap = cloneState(ref);
        at = i;
      }
      step(ref, [sc.a(i), b(i)]);
    }
    const want = hashState(ref);
    let same = false;
    let again = false;
    if (snap) {
      // A wrong guess for a few frames on a copy, then back to the snapshot and the real inputs.
      const wrong = cloneState(snap);
      for (let i = 0; i < 8; i++) step(wrong, [packInput(-100, -100, BTN.SHIELD), packInput(100, 100, BTN.SPECIAL)]);
      const restored = cloneState(snap);
      for (let i = at; i < sc.frames; i++) step(restored, [sc.a(i), b(i)]);
      same = hashState(restored) === want;
      // The same run from the start lands on the same hash.
      const second = sc.setup();
      for (let i = 0; i < sc.frames; i++) step(second, [sc.a(i), b(i)]);
      again = hashState(second) === want;
    }
    check(`rollback: ${sc.name} replays to the same hash`, !!snap && same && again, `${want.toString(16)} from frame ${at}`);
  }

  // Random inputs on every kit across stages: determinism, and rollback from the middle of the run.
  {
    const kit = [{ char: punk }, { char: kitA }, { char: kitB }, { char: plain }];
    const BTNS = [BTN.ATTACK, BTN.SPECIAL, BTN.SPECIAL, BTN.SPECIAL, BTN.JUMP, BTN.SHIELD, 0, 0];
    const inputsFor = (seed: number, frames: number): number[][] => {
      let r = seed;
      const held = kit.map(() => [0, 0, 0]);
      const out: number[][] = [];
      for (let i = 0; i < frames; i++) {
        const row: number[] = [];
        for (let p = 0; p < kit.length; p++) {
          let v: number;
          [r, v] = rngNext(r);
          if (v % 6 === 0) held[p] = [((v >> 3) % 201) - 100, ((v >> 11) % 201) - 100, BTNS[(v >> 19) % BTNS.length]];
          row.push(packInput(held[p][0], held[p][1], held[p][2]));
        }
        out.push(row);
      }
      return out;
    };
    for (const stage of [0, 1, 2]) {
      const opts = { stocks: 3, seed: 31 + stage, stage };
      const inputs = inputsFor(opts.seed, 2400);
      const runAll = (g: GameState, from = 0) => {
        let made = 0;
        for (let i = from; i < inputs.length; i++) {
          step(g, inputs[i]);
          made = Math.max(made, g.shots.length);
        }
        return made;
      };
      const a = newGame(kit, opts);
      const shotsSeen = runAll(a);
      const b = newGame(kit, opts);
      runAll(b);
      const live = newGame(kit, opts);
      for (let i = 0; i < 1000; i++) step(live, inputs[i]);
      const snap = cloneState(live);
      for (let i = 0; i < 8; i++) step(live, kit.map(() => packInput(0, 0, BTN.JUMP)));
      const restored = cloneState(snap);
      runAll(restored, 1000);
      check(`specials: four kits on random inputs are deterministic and rollback-safe (stage ${stage})`, hashState(a) === hashState(b) && hashState(restored) === hashState(a) && shotsSeen > 0, `${hashState(a).toString(16)}, up to ${shotsSeen} shots`);
    }
  }
}
