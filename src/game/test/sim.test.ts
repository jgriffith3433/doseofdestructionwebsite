// Headless checks for the simulation: run with `npm test`.
// 1. The same inputs always produce the same state hash.
// 2. Restoring a snapshot and replaying (what rollback does) lands on the same hash.
// 3. Bots finish a match.

import { rngNext } from '../sim/fixed.ts';
import { BTN, packInput } from '../sim/input.ts';
import { cloneState, hashState, newGame, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';

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

const setup = [{ char: 0 }, { char: 1 }, { char: 2 }, { char: 3 }];
for (const seed of [1, 7, 1234]) {
  const inputs = randomInputs(seed, 3600, 4);
  const a = run(newGame(setup, 3, seed), inputs);
  const b = run(newGame(setup, 3, seed), inputs);
  check(`deterministic, seed ${seed}`, a === b, a.toString(16));

  // Simulate a rollback: snapshot at frame 1000, run on with wrong guesses
  // for 8 frames, restore, then replay the real inputs.
  const live = newGame(setup, 3, seed);
  run(live, inputs.slice(0, 1000));
  const snap = cloneState(live);
  for (let i = 0; i < 8; i++) step(live, [0, 0, 0, 0].map(() => packInput(0, 0, BTN.JUMP)));
  const restored = cloneState(snap);
  for (let i = 1000; i < inputs.length; i++) step(restored, inputs[i]);
  check(`rollback replay matches, seed ${seed}`, hashState(restored) === a);
}

// Four bots should finish a 3-stock match well inside 10 minutes.
{
  const state = newGame(setup, 3, 99);
  const bots = setup.map((_, i) => new Bot(i, 6, 1000 + i));
  let frames = 0;
  let hits = 0;
  while (!state.over && frames < 60 * 60 * 10) {
    const inputs = bots.map((b) => b.think(state));
    hits += step(state, inputs).filter((e) => e.type === 'hit').length;
    frames++;
  }
  check('bots finish a match', state.over === 1, `${(frames / 60).toFixed(0)}s, ${hits} hits, winner P${state.winner + 1}`);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
