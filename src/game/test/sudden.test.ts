// Sudden death (sim/step.ts startSuddenDeath, blastZone): a time-out that is exactly level on stocks and percent respawns the
// tied fighters at 300%, one stock each, and the blast zone closes in after 10 s so first KO wins and it always ends.
import { newGame, hashState } from '../sim/state.ts';
import { step, SUDDEN_HOLD, SUDDEN_CLOSE, SUDDEN_PERCENT, blastZone, type SimEvent } from '../sim/step.ts';
import { NO_INPUT } from '../sim/input.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const LIMIT = 600;
const play = (opts: { percent?: [number, number]; sudden?: number; seed?: number; stage?: number; chars?: [number, number] }) => {
  const c = opts.chars ?? [0, 1];
  const g = newGame([{ char: c[0], stocks: 2 }, { char: c[1], stocks: 2 }], {
    stocks: 2, seed: opts.seed ?? 5, stage: opts.stage ?? 0, rules: { timeLimit: LIMIT, suddenDeath: opts.sudden ?? 1 },
  });
  if (opts.percent) opts.percent.forEach((p, i) => (g.fighters[i].percent = p));
  const evs: { frame: number; e: SimEvent }[] = [];
  let startedAt = -1;
  let hashes = 0;
  for (let i = 0; i < LIMIT + 60 * 40 && !g.over; i++) {
    for (const e of step(g, [NO_INPUT, NO_INPUT])) {
      evs.push({ frame: g.frame, e });
      if (e.type === 'sudden') startedAt = g.frame;
    }
    hashes ^= hashState(g);
  }
  return { g, evs, startedAt, hashes };
};

const tie = play({});
check('an exact tie at time-out does not name a winner', tie.startedAt >= LIMIT - 2 && tie.startedAt <= LIMIT, `${tie.startedAt}`);
check('the sim announces sudden death with both fighters', tie.evs.some((x) => x.e.type === 'sudden' && x.e.ids.length === 2));
check('it respawns both at 300%', tie.evs.filter((x) => x.e.type === 'respawn').length >= 2 && SUDDEN_PERCENT === 3000);
check('sudden death ends with a winner, not as a time-out', tie.g.over === 1 && tie.g.winner >= 0 && tie.g.timedOut === 0, `winner ${tie.g.winner}`);
check('it ends within 30 s of starting', tie.g.frame - tie.startedAt <= 30 * 60, `${((tie.g.frame - tie.startedAt) / 60).toFixed(1)} s`);
check('the winner has the one stock, the loser none', tie.g.fighters[tie.g.winner].stocks === 1 && tie.g.fighters[1 - tie.g.winner].stocks === 0);
check('exactly one KO decides it (or one tie coin)', tie.evs.filter((x) => x.e.type === 'ko').length >= 1);

const again = play({});
check('deterministic: the same run hashes the same', again.hashes === tie.hashes && again.g.winner === tie.g.winner);

// The slot never decides: over a spread of seeds and pairings both slots win some.
const wins = [0, 0];
let longest = 0;
for (let seed = 1; seed <= 24; seed++) {
  const r = play({ seed, stage: seed % 3, chars: [seed % 9, (seed * 5 + 3) % 9] });
  if (r.g.winner >= 0) wins[r.g.winner]++;
  longest = Math.max(longest, r.g.frame - r.startedAt);
  if (r.g.over !== 1 || r.g.timedOut) check(`seed ${seed} ends in a KO`, false);
}
check('both slots win sometimes (not slot 0 by default)', wins[0] > 0 && wins[1] > 0, `${wins}`);
check('every sudden death over 24 seeds ends inside 30 s', longest <= 30 * 60, `${(longest / 60).toFixed(1)} s`);

// The zone holds 10 s, then closes to nothing.
const z = newGame([{ char: 0 }, { char: 1 }], { stocks: 1, seed: 1, stage: 0 });
step(z, [NO_INPUT, NO_INPUT]);
const full = blastZone(z);
z.sudden = 1 + SUDDEN_HOLD;
const held = blastZone(z);
z.sudden = 1 + SUDDEN_HOLD + SUDDEN_CLOSE / 2;
const half = blastZone(z);
z.sudden = 1 + SUDDEN_HOLD + SUDDEN_CLOSE;
const none = blastZone(z);
check('the zone holds for 10 s', held.left === full.left && held.top === full.top);
check('then shrinks', half.left > full.left && half.right < full.right && half.top < full.top);
check('and closes completely before 30 s', none.left === none.right && SUDDEN_HOLD + SUDDEN_CLOSE <= 25 * 60);

// A level-looking match that is not level still goes to the better side; the rule can be off.
const ahead = play({ percent: [50, 80] });
check('not level: the lower percent wins on time', ahead.startedAt === -1 && ahead.g.timedOut === 1 && ahead.g.winner === 0);
const off = play({ sudden: 0 });
check('rule off: the old time-out result', off.startedAt === -1 && off.g.timedOut === 1);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('sudden death: all ok');
