// Bots and stage hazards (ai/bot.ts hazard read): over seeded matches on every hazard stage, count the hits the stage
// lands on bots (a hazard or a damage zone, sim `hurt` events). A level-9 bot must take at least 75% fewer than the bot
// before the hazard read did (BASELINE, measured on beta 98bdcd6 with this same harness), a level-1 bot must still get
// caught now and then, and a level-9 bot must read a warning and move before the hazard arrives.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { ACT, newGame } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { bodyOf, clearance, readDangers } from '../ai/hazardRead.ts';

declare const process: { exit(code: number): never; env: Record<string, string | undefined> };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

export const HAZARD_STAGES = ['desert', 'cursed-town', 'rainbow-full-pipe', 'watercolor-nebula', 'yo-house'];
const SEEDS = [3, 8, 13, 21, 34, 55, 89, 144];
const SECONDS = 150;

/** Hits taken by both bots over SEEDS matches, level-9 bots (measured before the hazard read existed). */
const BASELINE: Record<string, number> = {
  'desert': 29,
  'cursed-town': 1509,
  'rainbow-full-pipe': 38,
  'watercolor-nebula': 16,
  'yo-house': 13,
};

const A = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const B = CHARACTERS.findIndex((c) => c.id === 'break');

/** Plays the seeds on a stage; returns hits the stage landed, and for each warning the frames from warn to the first move. */
export function hazardHits(stageId: string, level: number): { hits: number; byZone: number; matches: number; threatened: number; reacted: number } {
  const stage = STAGES.findIndex((s) => s.id === stageId);
  let hits = 0;
  let byZone = 0;
  let threatened = 0;
  let reacted = 0;
  for (const seed of SEEDS) {
    const s = newGame([{ char: A, stocks: 2 }, { char: B, stocks: 2 }], { stocks: 2, seed, stage, rules: { timeLimit: 60 * SECONDS } } as never);
    const bots = [new Bot(0, level, seed * 7 + 1), new Bot(1, level, seed * 7 + 2)];
    let frames = 0;
    // Bots standing in a warned hazard's way when the warning shows, and whether each starts moving out within 20 frames.
    const watch: { id: number; until: number; seen: boolean }[] = [];
    while (!s.over && frames < 60 * (SECONDS + 5)) {
      const ev = step(s, bots.map((b) => b.think(s)));
      for (const w of watch) if (bots[w.id].avoiding) w.seen = true;
      // Knocked about before it could move (an opponent's hit, not the bot's choice): not counted either way.
      for (let k = watch.length - 1; k >= 0; k--) {
        const a = s.fighters[watch[k].id].action;
        if (!watch[k].seen && (a === ACT.HITSTUN || a === ACT.DEAD || a === ACT.RESPAWN)) {
          threatened--;
          watch.splice(k, 1);
        }
      }
      for (let k = watch.length - 1; k >= 0; k--) {
        if (watch[k].until <= frames) {
          reacted += watch[k].seen ? 1 : 0;
          watch.splice(k, 1);
        }
      }
      if (ev.some((e) => e.type === 'stage' && e.phase === 'warn')) {
        for (const b of s.fighters) {
          if (b.action === ACT.HITSTUN || b.action === ACT.DEAD || b.action === ACT.RESPAWN || b.hitlag > 0) continue;
          const d = readDangers(STAGES[stage], s, b);
          const [hw, h] = bodyOf(b);
          if (d.event && clearance(d, b.x / 1000, b.y / 1000, hw, h) < 10) {
            threatened++;
            watch.push({ id: b.id, until: frames + 20 + (9 - level) * 18 + 20, seen: false });
          }
        }
      }
      for (const e of ev) if (e.type === 'hurt') {
        hits++;
        if (e.source === 'zone') byZone++;
      }
      frames++;
    }
    // A warning the match ended inside: counted only when the bot had already moved.
    for (const w of watch) {
      if (w.seen) reacted++;
      else threatened--;
    }
  }
  return { hits, byZone, matches: SEEDS.length, threatened, reacted };
}

if (process.env.BOT_HAZARD_MEASURE) {
  const lv = Number(process.env.BOT_HAZARD_MEASURE);
  for (const id of HAZARD_STAGES) {
    const r = hazardHits(id, lv);
    console.log(`${id} L${lv}: hits ${r.hits} (zone ${r.byZone}), warned in the way ${r.threatened}, moved ${r.reacted}`);
  }
  process.exit(0);
}

for (const id of HAZARD_STAGES) {
  const hi = hazardHits(id, 9);
  const base = BASELINE[id];
  check(`${id}: level 9 takes 75% fewer hazard hits`, hi.hits <= base * 0.25, `${hi.hits} vs ${base} before`);
  const lo = hazardHits(id, 1);
  check(`${id}: level 1 still gets caught`, lo.hits > 0, `${lo.hits} hits`);
  check(`${id}: a level 9 bot in a warned hazard's way moves out`, hi.threatened === 0 || hi.reacted / hi.threatened >= 0.8, `${hi.reacted}/${hi.threatened}`);
  check(`${id}: level 9 does better than level 1`, hi.hits < lo.hits, `${hi.hits} < ${lo.hits}`);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
