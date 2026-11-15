// Balance round robin: every fighter against every fighter, level-9 bots on a neutral stage, a few seeds, both sides.
// Deterministic (the sim and the bots are seeded), so the same build always prints the same table.
// Used by test/balance.test.ts (npm test) and tools/balance-table.ts (writes docs/balance.md).

import { CHARACTERS } from './sim/characters.ts';
import { stageIndex } from './sim/stage.ts';
import { newGame } from './sim/state.ts';
import { step } from './sim/step.ts';
import { Bot } from './ai/bot.ts';

export const BALANCE_STAGE = 'city-top'; // flat, no events, hazards or zones
export const BALANCE_SEEDS = [11, 23, 37, 41, 59, 71];
export const BALANCE_LEVEL = 9;
export const BALANCE_STOCKS = 2;
export const BALANCE_SECONDS = 60;
/** The band, in win rate (0..1). Wide on purpose while the table is new: tighten it as kits are tuned. */
export const BALANCE_BAND = { min: 0.25, max: 0.75 };

export interface BalanceRow {
  id: string;
  name: string;
  wins: number;
  games: number;
  rate: number;
}

/** 1 if slot 0 won, 0 if slot 1 won, 0.5 for a draw. */
function play(a: number, b: number, seed: number): number {
  const stage = stageIndex(BALANCE_STAGE);
  const s = newGame([{ char: a }, { char: b }], {
    stocks: BALANCE_STOCKS,
    seed,
    stage,
    rules: { timeLimit: 60 * BALANCE_SECONDS },
  } as never);
  const bots = [new Bot(0, BALANCE_LEVEL, seed * 2), new Bot(1, BALANCE_LEVEL, seed * 2 + 1)];
  let frames = 0;
  while (!s.over && frames < 60 * 60 * 5) {
    step(s, bots.map((x) => x.think(s)));
    frames++;
  }
  return s.winner === 0 ? 1 : s.winner === 1 ? 0 : 0.5;
}

export function roundRobin(): BalanceRow[] {
  const n = CHARACTERS.length;
  const wins = new Array(n).fill(0);
  const games = new Array(n).fill(0);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (const seed of BALANCE_SEEDS) {
        // Both sides, so a start-position edge cancels out.
        const r1 = play(a, b, seed);
        const r2 = play(b, a, seed + 1000);
        wins[a] += r1 + (1 - r2);
        wins[b] += 1 - r1 + r2;
        games[a] += 2;
        games[b] += 2;
      }
    }
  }
  return CHARACTERS.map((c, i) => ({ id: c.id, name: c.name, wins: wins[i], games: games[i], rate: wins[i] / games[i] }));
}

export function tableText(rows: BalanceRow[]): string {
  const sorted = [...rows].sort((x, y) => y.rate - x.rate);
  const out = ['| # | Fighter | Win rate | Wins | Games |', '|--:|---|--:|--:|--:|'];
  sorted.forEach((r, i) => out.push(`| ${i + 1} | ${r.name} (${r.id}) | ${(r.rate * 100).toFixed(1)}% | ${r.wins} | ${r.games} |`));
  return out.join('\n');
}
