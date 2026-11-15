// The pilot's Kaelen (ai/bot.ts pilotFight) must be beatable by a first-time player: a gentle stand-in player (a level 2-4
// bot, far below a person who has been taught the moves) wins the open-mic fight, lands a first KO early, and Kaelen
// does hop to a platform and throw a smash the Shield prompt can see.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { ACT, newGame } from '../sim/state.ts';
import { MOVE } from '../sim/characters.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { PILOT_KAELEN } from '../campaign/firstVisit.ts';

declare const process: { exit(code: number): never; env: Record<string, string | undefined> };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const kaelen = CHARACTERS.findIndex((c) => c.id === 'kaelen');
const stage = STAGES.findIndex((s) => s.id === 'city-top');

let wins = 0;
let games = 0;
const firstKos: number[] = [];
let perched = 0;
let smashes = 0;
for (const level of [4, 5, 6]) {
  for (let seed = 1; seed <= 6; seed++) {
    const s = newGame(
      [{ char: ep, stocks: 2 }, { char: kaelen, stocks: 2, startPercent: PILOT_KAELEN.startPercent }],
      { stocks: 2, seed: seed * 31, stage },
    );
    const me = new Bot(0, level, seed * 7);
    const foe = new Bot(1, PILOT_KAELEN.cpu, seed * 13, true);
    let frames = 0;
    let firstKo = -1;
    let sawPerch = false;
    let sawSmash = false;
    while (!s.over && frames < 60 * 150) {
      const ev = step(s, [me.think(s), foe.think(s)]);
      if (firstKo < 0 && ev.some((e) => e.type === 'ko' && e.victim === 1)) firstKo = frames;
      const k = s.fighters[1];
      if (k.platform >= 0 && !STAGES[stage].platforms[k.platform].solid) sawPerch = true;
      if (k.action === ACT.ATTACK && (k.move === MOVE.FSMASH || k.move === MOVE.USMASH || k.move === MOVE.DSMASH)) sawSmash = true;
      frames++;
    }
    games++;
    if (process.env.PILOT_DEBUG) console.log(`L${level} s${seed} over=${s.over} winner=${s.winner} frames=${frames} stocks=${s.fighters[0].stocks}/${s.fighters[1].stocks} pct=${s.fighters[0].percent}/${s.fighters[1].percent} firstKo=${firstKo}`);
    if (s.over && s.winner === 0) wins++;
    if (firstKo >= 0) firstKos.push(firstKo);
    if (sawPerch) perched++;
    if (sawSmash) smashes++;
  }
}
check('a gentle first-time stand-in beats the pilot Kaelen', wins / games >= 0.8, `${wins}/${games}`);
firstKos.sort((a, b) => a - b);
const medianKo = firstKos[Math.floor(firstKos.length / 2)] ?? Infinity;
check('the first KO comes inside about a minute of play (median)', medianKo <= 60 * 60, `${Math.round(medianKo / 60)} s median, ${Math.round((firstKos[firstKos.length - 1] ?? 0) / 60)} s slowest`);
check('Kaelen hops onto a platform (the Jump prompt\'s moment)', perched / games >= 0.7, `${perched}/${games}`);
check('Kaelen throws a smash (the Shield prompt\'s moment)', smashes / games >= 0.5, `${smashes}/${games}`);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
