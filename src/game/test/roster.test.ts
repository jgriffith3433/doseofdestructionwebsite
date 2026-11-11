// Bot against bot across the 13 Season 1 fighters (the ones with their own four specials): every pair plays both
// sides on two stages, and each fighter's win rate has to stay between 35% and 65%, so no kit is a free win or a
// free loss. `runRosterTests` is run by sim.test.ts; run this file alone with ROSTER_REPORT=1 for the table.

import { CHARACTERS, MOVE_KEYS, characterIndex } from '../sim/characters.ts';
import { newGame, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
declare const process: { env: Record<string, string | undefined> };

export const SEASON_1 = [
  'exit-punk', 'kaelen', 'break', 'dj-wont-read', 'shutup-bot', 'small-weather', 'blog-man',
  'evil-blue-bird', 'got-ur-back', 'slice', 'ss-boulder', 'stratabots', 'orchestrator',
];

/** The four archetypes of a fighter's kit, neutral / side / up / down, e.g. "projectile/dash/recovery/trap". */
export function kitOf(char: number): string {
  const m = CHARACTERS[char].moves;
  return [MOVE_KEYS.indexOf('nspecial'), MOVE_KEYS.indexOf('sspecial'), MOVE_KEYS.indexOf('upb'), MOVE_KEYS.indexOf('dspecial')]
    .map((i) => m[i].kind ?? 'shared')
    .join('/');
}

const LEVEL = 7;
const STAGE_COUNT = 4;
const TIME = 60 * 100;

function duel(a: number, b: number, stage: number, seed: number): 0 | 1 | 0.5 {
  const g: GameState = newGame([{ char: a }, { char: b }], { stocks: 2, seed, stage, rules: { timeLimit: TIME } });
  const bots = [new Bot(0, LEVEL, seed * 7 + 1), new Bot(1, LEVEL, seed * 7 + 2)];
  for (let i = 0; i < TIME + 600 && !g.over; i++) step(g, bots.map((x) => x.think(g)));
  if (g.winner === 0) return 1;
  if (g.winner === 1) return 0;
  return 0.5;
}

export function rosterWinRates(): { id: string; rate: number; games: number }[] {
  const ids = SEASON_1.map(characterIndex);
  const pts = ids.map(() => 0);
  const games = ids.map(() => 0);
  let seed = 11;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let s = 0; s < STAGE_COUNT; s++) {
        for (const flip of [false, true]) {
          const r = flip ? 1 - duel(ids[j], ids[i], s, seed++) : duel(ids[i], ids[j], s, seed++);
          pts[i] += r;
          pts[j] += 1 - r;
          games[i]++;
          games[j]++;
        }
      }
    }
  }
  return ids.map((_, k) => ({ id: SEASON_1[k], rate: pts[k] / games[k], games: games[k] }));
}

export function runRosterTests(check: Check): void {
  const kits = new Map<string, string>();
  for (const id of SEASON_1) kits.set(id, kitOf(characterIndex(id)));
  const dup = [...kits].filter(([id, k]) => [...kits].some(([o, ok]) => o !== id && ok === k));
  check('roster: all 13 Season 1 fighters have their own four specials, none the same four archetypes as another',
    SEASON_1.every((id) => CHARACTERS[characterIndex(id)].specials && !kits.get(id)!.includes('shared')) && dup.length === 0,
    dup.map(([id, k]) => `${id} ${k}`).join('; '));

  const rates = rosterWinRates();
  if (process.env.ROSTER_REPORT) for (const r of rates) console.log(`${r.id.padEnd(16)} ${(r.rate * 100).toFixed(1)}%  (${r.games} games)  ${kits.get(r.id)}`);
  const bad = rates.filter((r) => r.rate < 0.35 || r.rate > 0.65);
  check('roster: bot-vs-bot win rates among the 13 stay between 35% and 65%', bad.length === 0,
    bad.map((r) => `${r.id} ${(r.rate * 100).toFixed(0)}%`).join(', ') || `${Math.min(...rates.map((r) => r.rate)).toFixed(2)}-${Math.max(...rates.map((r) => r.rate)).toFixed(2)}`);
}

if (process.env.ROSTER_REPORT) {
  const t = Date.now();
  runRosterTests((n, ok, d) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`));
  console.log(`${((Date.now() - t) / 1000).toFixed(0)}s`);
}
