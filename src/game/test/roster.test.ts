// Bot against bot across all 33 fighters (each with its own four specials): every pair plays both
// sides on four stages, and each fighter's win rate has to stay between 35% and 65%, so no kit is a free win or a
// free loss. `runRosterTests` is run by sim.test.ts; run this file alone with ROSTER_REPORT=1 for the table.

import { CHARACTERS, FIGHTERS, MOVE, MOVE_KEYS, characterIndex } from '../sim/characters.ts';
import { ACT, newGame, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
declare const process: { env: Record<string, string | undefined> };

export const SEASON_1 = [
  'exit-punk', 'kaelen', 'break', 'dj-wont-read', 'shutup-bot', 'small-weather', 'blog-man',
  'evil-blue-bird', 'got-ur-back', 'slice', 'ss-boulder', 'stratabots', 'orchestrator',
];
/** Every fighter in content/fighters.json: the 13 above and the 20 newer ones. */
export const ROSTER: string[] = FIGHTERS.map((f) => f.id);

/** The four archetypes of a fighter's kit, neutral / side / up / down, e.g. "projectile/dash/recovery-angled/trap". */
export function kitOf(char: number): string {
  const m = CHARACTERS[char].moves;
  const kind = (key: string): string => {
    const mv = m[MOVE_KEYS.indexOf(key as (typeof MOVE_KEYS)[number])];
    if (mv.kind !== 'recovery') return mv.kind ?? 'shared';
    return mv.helpless ? (mv.drive?.[0]?.aim ? 'recovery-angled' : 'recovery-straight') : 'recovery-glide';
  };
  return ['nspecial', 'sspecial', 'upb', 'dspecial'].map(kind).join('/');
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
  const ids = ROSTER.map(characterIndex);
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
  return ids.map((_, k) => ({ id: ROSTER[k], rate: pts[k] / games[k], games: games[k] }));
}

const SPECIAL_SLOTS: number[] = [MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL];

/** How many special presses (a special started) and how many different specials each fighter's bot used in a match. */
function specialUse(char: number, opp: number, level: number, seed: number): { used: number; presses: number } {
  const g: GameState = newGame([{ char }, { char: opp }], { stocks: 3, seed, stage: seed % STAGE_COUNT, rules: {} });
  const bots = [new Bot(0, level, seed * 7 + 1), new Bot(1, level, seed * 7 + 2)];
  const used = new Set<number>();
  let presses = 0;
  let was = -1;
  for (let i = 0; i < 9000 && !g.over; i++) {
    step(g, bots.map((x) => x.think(g)));
    const f = g.fighters[0];
    const now = f.action === ACT.ATTACK && SPECIAL_SLOTS.includes(f.move) ? f.move : -1;
    if (now >= 0) used.add(now);
    if (now >= 0 && was < 0) presses++;
    was = now;
  }
  return { used: used.size, presses };
}

export function runRosterTests(check: Check): void {
  const kits = new Map<string, string>();
  for (const id of ROSTER) kits.set(id, kitOf(characterIndex(id)));
  // No two fighters share the same four archetypes, and none of them is stuck with the shared specials.
  // The up special is a recovery for everyone, so it also may not be the only thing apart: the other three differ.
  const three = (id: string) => kits.get(id)!.split('/').filter((_, i) => i !== 2).join('/');
  const dup = ROSTER.filter((id) => ROSTER.some((o) => o !== id && three(o) === three(id)));
  check(`roster: all ${ROSTER.length} fighters have their own four specials, none the same four archetypes as another`,
    ROSTER.length === 33 && ROSTER.every((id) => CHARACTERS[characterIndex(id)].specials && !kits.get(id)!.includes('shared')) && dup.length === 0,
    dup.map((id) => `${id} ${kits.get(id)}`).join('; '));
  check('roster: every kit has a recovery up and no archetype twice among neutral, side and down',
    ROSTER.every((id) => { const t = three(id).split('/'); return new Set(t).size === 3 && kits.get(id)!.split('/')[2].startsWith('recovery'); }),
    ROSTER.filter((id) => new Set(three(id).split('/')).size < 3).join(', '));

  // The fitted hitbox offsets (tools/fit-hitboxes.mjs) are on every fighter and reach the compiled moves.
  const unfitted = ROSTER.filter((id) => {
    const entry = FIGHTERS.find((f) => f.id === id);
    const fsmash = entry?.hitboxes?.fsmash?.[0];
    const box = CHARACTERS[characterIndex(id)].moves[MOVE.FSMASH].hits[0]?.boxes[0];
    return !fsmash || !box || box.x !== Math.round(fsmash.x) || box.y !== Math.round(fsmash.y);
  });
  check(`roster: the ${ROSTER.length} have fitted hitbox offsets (fit-hitboxes) and the sim plays them`, unfitted.length === 0, unfitted.join(', '));

  // The bot uses its kit: at level 7 and up a fighter's bot uses at least three different specials in a match
  // (on average over a few matches), and a harder bot presses specials more often than an easy one.
  const n = ROSTER.length;
  const mean = (level: number, key: 'used' | 'presses', games: number): number => {
    let sum = 0;
    for (let k = 0; k < n; k++) for (let g = 0; g < games; g++) sum += specialUse(characterIndex(ROSTER[k]), characterIndex(ROSTER[(k + 1 + g * 7) % n]), level, k * 10 + g + 3)[key];
    return sum / (n * games);
  };
  const usedAt7 = mean(7, 'used', 2);
  const pressesLow = mean(2, 'presses', 1);
  const pressesHigh = mean(8, 'presses', 1);
  check('roster: a level 7 bot uses at least three different specials per match (mean over every fighter)', usedAt7 >= 3, usedAt7.toFixed(2));
  check('roster: a level 8 bot presses its specials more often than a level 2 bot', pressesHigh > pressesLow * 1.2, `${pressesLow.toFixed(1)} -> ${pressesHigh.toFixed(1)}`);

  const rates = rosterWinRates();
  if (process.env.ROSTER_REPORT) for (const r of rates) console.log(`${r.id.padEnd(26)} ${(r.rate * 100).toFixed(1)}%  (${r.games} games)  ${kits.get(r.id)}`);
  const bad = rates.filter((r) => r.rate < 0.35 || r.rate > 0.65);
  check('roster: bot-vs-bot win rates among all 33 stay between 35% and 65%', bad.length === 0,
    bad.map((r) => `${r.id} ${(r.rate * 100).toFixed(0)}%`).join(', ') || `${Math.min(...rates.map((r) => r.rate)).toFixed(2)}-${Math.max(...rates.map((r) => r.rate)).toFixed(2)}`);
}

if (process.env.ROSTER_REPORT) {
  const t = Date.now();
  runRosterTests((n, ok, d) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`));
  console.log(`${((Date.now() - t) / 1000).toFixed(0)}s`);
}
