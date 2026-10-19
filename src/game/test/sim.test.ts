// Headless checks for the simulation: run with `npm test`.
// 1. The same inputs always produce the same state hash, on every stage.
// 2. Restoring a snapshot and replaying (what rollback does) lands on the same hash.
// 3. Bots finish matches on every stage, including teams, giants and odd rules.

import { rngNext } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { BTN, packInput } from '../sim/input.ts';
import { STAGES } from '../sim/stage.ts';
import { cloneState, hashState, newGame, type FighterSetup, type GameOptions, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { Match, type SlotSetup } from '../match.ts';
import { CHAPTERS, SEASONS, isOpen, seasonOpen } from '../campaign/story.ts';

declare const process: { exit(code: number): never };

const BUTTONS = [BTN.ATTACK, BTN.SPECIAL, BTN.JUMP, BTN.SHIELD, BTN.C_LEFT, BTN.C_UP, 0, 0, 0];

function randomInputs(seed: number, frames: number, players: number): number[][] {
  let r = seed;
  const out: number[][] = [];
  const held = new Array(players).fill(0).map(() => [0, 0, 0]);
  for (let i = 0; i < frames; i++) {
    const row: number[] = [];
    for (let p = 0; p < players; p++) {
      let v: number;
      [r, v] = rngNext(r);
      // Change the held input every ~8 frames so moves actually play out.
      if (v % 8 === 0) held[p] = [(v >> 3) % 201 - 100, (v >> 11) % 201 - 100, BUTTONS[(v >> 19) % BUTTONS.length]];
      row.push(packInput(held[p][0], held[p][1], held[p][2]));
    }
    out.push(row);
  }
  return out;
}

function run(state: GameState, inputs: number[][], from = 0): number {
  for (let i = from; i < inputs.length; i++) step(state, inputs[i]);
  return hashState(state);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const four: FighterSetup[] = [{ char: 0 }, { char: 2 }, { char: 8 }, { char: 12 }];

// A stage that uses every dynamic system (events, zones, hazards, platform
// toggles), so they are held to the same determinism and rollback checks.
{
  const base = STAGES[0];
  const top = Math.max(...base.platforms.map((p) => p.y));
  STAGES.push({
    ...base,
    id: 'test-dynamic',
    name: 'Test Dynamic',
    platforms: base.platforms.map((p, i) => (i === base.platforms.length - 1 ? { ...p, offDuring: 'storm' } : p)),
    events: [
      { id: 'storm', every: [2, 4], first: 1, warn: 1, duration: 3 },
      { id: 'cheer', trigger: 'ko', duration: 0 },
      { id: 'tilt', trigger: 'hit', chance: 20, duration: 1 },
    ],
    zones: [
      { kind: 'wind', x1: -2000, x2: 2000, y1: -500, y2: 2000, during: 'storm', force: [90, 0] },
      // Off to the side: under the whole stage, bots float below the floor and never come back.
      { kind: 'water', x1: 900, x2: 2000, y1: -900, y2: -150 },
      { kind: 'damage', x1: -3000, x2: 3000, y1: -900, y2: 3000, damage: 1, tick: 4, knock: 30, angle: 60 },
      { kind: 'gravity', x1: -300, x2: 300, y1: top, y2: top + 600, gravity: 60, during: 'tilt' },
    ],
    hazards: [
      { id: 'hawk', during: 'storm', path: [{ x: -1200, y: 300 }, { x: 0, y: 40 }, { x: 1200, y: 300 }], r: 60, dmg: 12, angle: 45, bkb: 40, kbg: 90 },
      { id: 'saw', period: 3, path: [{ x: -400, y: 60 }, { x: 400, y: 60 }], r: 30, dmg: 4, angle: 80, bkb: 20, kbg: 40 },
    ],
  });
}

STAGES.forEach((stage, si) => {
  const opts: GameOptions = { stocks: 3, seed: 11 + si, stage: si };
  const inputs = randomInputs(opts.seed, 3000, 4);
  const a = run(newGame(four, opts), inputs);
  const b = run(newGame(four, opts), inputs);

  // Simulate a rollback: snapshot at frame 1000, run on with wrong guesses
  // for 8 frames, restore, then replay the real inputs.
  const live = newGame(four, opts);
  run(live, inputs.slice(0, 1000));
  const snap = cloneState(live);
  for (let i = 0; i < 8; i++) step(live, [0, 0, 0, 0].map(() => packInput(0, 0, BTN.JUMP)));
  const restored = cloneState(snap);
  for (let i = 1000; i < inputs.length; i++) step(restored, inputs[i]);
  check(`${stage.name}: deterministic and rollback-safe`, a === b && hashState(restored) === a, a.toString(16));
});

function botMatch(setup: FighterSetup[], opts: GameOptions, level = 6): { state: GameState; secs: number; hits: number } {
  const state = newGame(setup, opts);
  const bots = setup.map((_, i) => new Bot(i, level, 1000 + i));
  let frames = 0;
  let hits = 0;
  while (!state.over && frames < 60 * 60 * 8) {
    hits += step(state, bots.map((b) => b.think(state))).filter((e) => e.type === 'hit').length;
    frames++;
  }
  return { state, secs: Math.round(frames / 60), hits };
}

STAGES.forEach((stage, si) => {
  const { state, secs, hits } = botMatch(four, { stocks: 2, seed: 99, stage: si });
  check(`${stage.name}: four bots finish`, state.over === 1, `${secs}s, ${hits} hits, winner P${state.winner + 1}`);
});

{
  // Two-on-one: allies never damage each other, and a team wins together.
  const { state } = botMatch([{ char: 9, team: 0 }, { char: 1, team: 1 }, { char: 20, team: 1 }], { stocks: 2, seed: 5, stage: 0 });
  const p = state.fighters;
  check('teams finish with a winning team', state.over === 1 && state.winnerTeam >= 0, `team ${state.winnerTeam}`);
  check('teammates never land hits on each other', p[1].damageDealt + p[2].damageDealt <= p[0].percent + 9999 * p[0].falls);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 22, scale: 150 }], { stocks: 2, seed: 8, stage: 1 });
  check('a giant fighter finishes a match', state.over === 1);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 13 }], { stocks: 3, seed: 3, stage: 2, rules: { gravity: 55, damage: 140 } });
  check('low gravity and high damage finish', state.over === 1);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 26 }], { stocks: 5, seed: 4, stage: 4, rules: { timeLimit: 60 * 20 } });
  check('a time limit ends the match', state.over === 1 && state.frame <= 60 * 20 + 1, `timedOut=${state.timedOut}`);
}

{
  // Every fighter can play a match without the sim falling over.
  let ok = true;
  for (let c = 0; c < CHARACTERS.length; c += 2) {
    const { state } = botMatch([{ char: c }, { char: (c + 1) % CHARACTERS.length }], { stocks: 1, seed: c, stage: c % STAGES.length });
    if (!state.over) ok = false;
  }
  check(`all ${CHARACTERS.length} fighters play`, ok);
}

{
  // The dynamic stage really does its things.
  const si = STAGES.findIndex((st) => st.id === 'test-dynamic');
  const setup: FighterSetup[] = [{ char: 0 }, { char: 2 }];
  const state = newGame(setup, { stocks: 2, seed: 21, stage: si });
  const bots = setup.map((_, i) => new Bot(i, 6, 40 + i));
  const seen = new Set<string>();
  for (let i = 0; i < 60 * 60 && !state.over; i++) {
    for (const e of step(state, bots.map((b) => b.think(state)))) {
      if (e.type === 'stage') seen.add(`${STAGES[si].events![e.event].id}:${e.phase}`);
      if (e.type === 'hurt') seen.add(e.source);
    }
  }
  const want = ['storm:warn', 'storm:start', 'storm:end', 'zone', 'hazard'];
  check('stage events, zones and hazards fire', want.every((w) => seen.has(w)), [...seen].sort().join(' '));
  const quiet = newGame(setup, { stocks: 2, seed: 21, stage: si, rules: { hazards: 0 } });
  let fired = 0;
  for (let i = 0; i < 60 * 30; i++) fired += step(quiet, [0, 0]).filter((e) => e.type === 'stage' || e.type === 'hurt').length;
  check('hazards off keeps the stage quiet', fired === 0);
}

{
  // The campaign map's seasons: in order, every chapter in one, and a season opens once the one before is cleared.
  check('chapters run in season order', CHAPTERS.every((c, i) => i === 0 || CHAPTERS[i - 1].season <= c.season));
  check('every chapter is in a season', SEASONS.reduce((n, s) => n + s.chapters.length, 0) === CHAPTERS.length, SEASONS.map((s) => `S${s.number}: ${s.chapters.length}`).join(', '));
  check('season 1 opens with nothing cleared', seasonOpen(1, new Set()) && isOpen(0, new Set()));
  for (const s of SEASONS.slice(1)) {
    const before = CHAPTERS.filter((c) => c.season < s.number).map((c) => c.id);
    const first = CHAPTERS.indexOf(s.chapters[0]);
    const allButOne = new Set(before.slice(0, -1));
    const all = new Set(before);
    check(`season ${s.number} waits on the season before`, !seasonOpen(s.number, allButOne) && !isOpen(first, allButOne) && seasonOpen(s.number, all) && isOpen(first, all));
  }
}

{
  // The 'ko' objective: N KOs before the clock wins (the match ends on the last one); the clock running out loses.
  const char = (id: string) => CHARACTERS.findIndex((c) => c.id === id);
  const koMatch = (foe: SlotSetup, timeLimit: number, seed: number) => {
    const m = new Match({ mode: 'campaign', stage: STAGES.findIndex((st) => st.id === 'yo-house'), stocks: 9, rules: { timeLimit }, objective: 'ko', kos: 3, slots: [{ char: char('exit-punk'), cpu: null, team: 0 }, { team: 1, stocks: 9, ...foe }] }, seed);
    const me = new Bot(0, 9, seed + 1);
    for (let i = 0; i < 60 * 60 * 5 && !m.state.over; i++) m.tick(me.think(m.state));
    return m;
  };
  // Kaelen starts every life at 120%, so three KOs come well inside the 2 minutes.
  const win = koMatch({ char: char('kaelen'), cpu: 1, startPercent: 1200 }, 60 * 120, 11);
  const foeLeft = win.state.fighters[1].stocks;
  check('ko objective: 3 KOs before the clock wins', win.state.over === 1 && !win.state.timedOut && win.playerWon() && win.koCount() === 3, `${Math.round(win.state.frame / 60)}s, ${win.koCount()} KOs`);
  check('ko objective: the match ends on the third KO, foe still in', foeLeft > 0 && win.state.winner === 0 && win.state.frame < 60 * 120, `foe has ${foeLeft} stocks`);
  const late = koMatch({ char: char('break'), cpu: 9, scale: 135 }, 60 * 15, 12);
  check('ko objective: time running out first loses', late.state.over === 1 && late.state.timedOut === 1 && !late.playerWon() && late.koCount() < 3, `${late.koCount()} KOs in 15s`);
  // Two KOs scored when the clock runs out is still a loss.
  const short = new Match({ mode: 'campaign', stage: 0, stocks: 9, rules: { timeLimit: 60 }, objective: 'ko', kos: 3, slots: [{ char: char('exit-punk'), cpu: null }, { char: char('kaelen'), cpu: 0, stocks: 9 }] }, 3);
  short.stats[0].kos = 2;
  while (!short.state.over) short.tick(0);
  check('ko objective: 2 of 3 KOs at the bell is a loss', short.state.timedOut === 1 && !short.playerWon());
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
