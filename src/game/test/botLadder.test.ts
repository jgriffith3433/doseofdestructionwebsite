// The CPU level ladder: across fighters and seeds, level n beats level n-2 most of the time; a level-1 bot misses a
// good share of its recoveries and a level-9 bot almost none; higher levels use more than one ledge option.
// Recoveries are measured two ways: staged (a fighter knocked off the edge at set spots, no opponent), and in the
// ladder matches themselves (a trip off the stage that ends in a KO with no hit in between).

import { CHARACTERS } from '../sim/characters.ts';
import { stageIndex, STAGES, ledges } from '../sim/stage.ts';
import { ACT, newGame } from '../sim/state.ts';
import { NO_INPUT } from '../sim/input.ts';
import { step } from '../sim/step.ts';
import { FX } from '../sim/fixed.ts';
import { Bot } from '../ai/bot.ts';

declare const process: { exit(code: number): never; env: Record<string, string | undefined> };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const STAGE = stageIndex('city-top');
const FIGHTERS = ['exit-punk', 'break', 'kaelen', 'wallit', 'gordon-lyle'].map((id) => CHARACTERS.findIndex((c) => c.id === id)).filter((i) => i >= 0);
const SEEDS = [11, 23, 37, 41, 53, 67];
const SECONDS = 60;

/** Plays one match; returns the winner (0 or 1, -1 draw) and the recovery tallies of both bots. */
function play(a: number, b: number, la: number, lb: number, seed: number) {
  const s = newGame([{ char: a }, { char: b }], { stocks: 2, seed, stage: STAGE, rules: { timeLimit: 60 * SECONDS } } as never);
  const bots = [new Bot(0, la, seed * 3 + 1), new Bot(1, lb, seed * 3 + 2)];
  const trips = [0, 0];
  const misses = [0, 0];
  const options = [new Set<string>(), new Set<string>()];
  const wasRec = [false, false];
  const hit = [false, false];
  let frames = 0;
  while (!s.over && frames < 60 * (SECONDS + 5)) {
    const rec = bots.map((x) => x.recovering);
    const ev = step(s, bots.map((x) => x.think(s)));
    for (const f of s.fighters) {
      if (f.action === ACT.HITSTUN) hit[f.id] = true;
      if (bots[f.id].recovering && !wasRec[f.id]) {
        trips[f.id]++;
        hit[f.id] = false;
      }
      wasRec[f.id] = bots[f.id].recovering;
    }
    for (const e of ev) {
      if (e.type === 'ledge-option') options[e.id].add(e.option);
      if (e.type === 'ko' && rec[e.victim] && !hit[e.victim]) misses[e.victim]++;
    }
    frames++;
  }
  return { winner: s.winner ?? -1, trips, misses, options };
}

/** Level n against level n-2 over fighters, seeds and both sides: n's win rate (draws half). */
function ladder(n: number): number {
  let w = 0;
  let g = 0;
  for (const a of FIGHTERS) {
    for (const b of FIGHTERS) {
      for (const seed of SEEDS) {
        const r1 = play(a, b, n, n - 2, seed);
        const r2 = play(b, a, n - 2, n, seed + 100);
        w += (r1.winner === 0 ? 1 : r1.winner < 0 ? 0.5 : 0) + (r2.winner === 1 ? 1 : r2.winner < 0 ? 0.5 : 0);
        g += 2;
      }
    }
  }
  return w / g;
}

/** Staged recoveries: a fighter knocked off the left or right edge at set depths, nobody to stop it. Returns [tries, misses]. */
function staged(level: number): [number, number] {
  const st = STAGES[STAGE];
  const main = st.platforms.find((p) => p.solid)!;
  let tries = 0;
  let misses = 0;
  for (const c of FIGHTERS) {
    for (const seed of SEEDS) {
      for (const side of [-1, 1]) {
        for (const [out, drop] of [[90, 40], [180, 120], [260, 200]]) {
          const g = newGame([{ char: c }, { char: c === FIGHTERS[0] ? FIGHTERS[1] : FIGHTERS[0] }], { stocks: 2, seed, stage: STAGE, rules: { timeLimit: 60 * 60 } } as never);
          const bot = new Bot(0, level, seed * 5 + out + (side > 0 ? 1 : 0));
          const me = g.fighters[0];
          const foe = g.fighters[1];
          foe.x = (main.x1 + main.x2) * (FX >> 1);
          foe.y = main.y * FX;
          foe.grounded = 1;
          foe.platform = st.platforms.indexOf(main);
          me.x = (side > 0 ? main.x2 + out : main.x1 - out) * FX;
          me.y = (main.y - drop) * FX;
          me.grounded = 0;
          me.platform = -1;
          me.action = ACT.AIR;
          me.vy = 0;
          me.vx = side * 2 * FX;
          tries++;
          let ok = false;
          for (let f = 0; f < 60 * 8; f++) {
            step(g, [bot.think(g), NO_INPUT]);
            if (me.action === ACT.DEAD || me.action === ACT.RESPAWN) break;
            if (me.grounded || me.action === ACT.LEDGE) {
              ok = true;
              break;
            }
          }
          if (!ok) misses++;
        }
      }
    }
  }
  return [tries, misses];
}

if (process.env.LADDER_MEASURE) {
  for (const lv of [1, 3, 5, 7, 9]) {
    const [t, m] = staged(lv);
    console.log(`staged L${lv}: ${m}/${t} missed (${((m / t) * 100).toFixed(0)}%)`);
  }
  for (const n of [3, 5, 7, 9]) console.log(`L${n} vs L${n - 2}: ${(ladder(n) * 100).toFixed(0)}%`);
  process.exit(0);
}

for (const n of [3, 5, 7, 9]) {
  const r = ladder(n);
  check(`level ${n} beats level ${n - 2} in 70%+ of matches`, r >= 0.7, `${(r * 100).toFixed(0)}%`);
}
const [t1, m1] = staged(1);
const [t9, m9] = staged(9);
check('level 1 misses at least 1 in 5 recoveries', m1 / t1 >= 0.2, `${m1}/${t1}`);
check('level 9 misses under 1 in 20 recoveries', m9 / t9 < 0.05, `${m9}/${t9}`);
check('each level misses no more than the one below it (1 → 5 → 9)', m1 >= staged(5)[1] && staged(5)[1] >= m9, '');

// Ledge options: a bot at a given level, run through many ledge hangs in matches.
{
  const seen: Record<number, Set<string>> = {};
  for (const lv of [1, 5, 9]) {
    seen[lv] = new Set();
    for (const seed of SEEDS) {
      const r = play(FIGHTERS[0], FIGHTERS[1], lv, lv, seed);
      for (const o of r.options) for (const x of o) seen[lv].add(x);
    }
  }
  check('level 9 uses more than one ledge option', seen[9].size > 1, [...seen[9]].join(','));
  check('level 5 uses more than one ledge option', seen[5].size > 1, [...seen[5]].join(','));
}
void ledges;

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
