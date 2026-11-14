// Campaign difficulty (campaign/difficulty.ts): CPU level shift, start damage, the run of losses and the Easy badge.
import { CHAPTERS } from '../campaign/story.ts';
import { clearLosses, easyCleared, foeLevels, lossesOn, markCleared, offerEasy, recordLoss, withDifficulty } from '../campaign/difficulty.ts';

declare const process: { exit(code: number): never };
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
};

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

for (const c of CHAPTERS) {
  const base = foeLevels(c.fight);
  const easy = foeLevels(withDifficulty(c.fight, 'easy'));
  const hard = foeLevels(withDifficulty(c.fight, 'hard'));
  ok(base.length > 0, `${c.id} has a foe`);
  base.forEach((b, i) => {
    ok(easy[i] === Math.max(1, b - 2), `${c.id} easy ${b} -> ${easy[i]}`);
    ok(hard[i] === Math.min(9, b + 1), `${c.id} hard ${b} -> ${hard[i]}`);
  });
  ok(withDifficulty(c.fight, 'normal') === c.fight, `${c.id} normal is untouched`);
  const e = withDifficulty(c.fight, 'easy');
  const h = withDifficulty(c.fight, 'hard');
  const me = (s: typeof e) => s.slots.find((x) => x.cpu === null)!;
  const foe = (s: typeof e) => s.slots.find((x) => x.cpu !== null && x.team !== me(s).team)!;
  ok((foe(e).startPercent ?? 0) === (foe(c.fight).startPercent ?? 0) + 300, `${c.id} easy hurts the foe`);
  ok((me(h).startPercent ?? 0) === (me(c.fight).startPercent ?? 0) + 200, `${c.id} hard hurts you`);
  ok(me(e).startPercent === me(c.fight).startPercent, `${c.id} easy leaves you alone`);
}

// Three losses in a row on one episode offer Easy; a loss elsewhere, or a win, starts the count again.
ok(recordLoss('a') === 1 && recordLoss('a') === 2, 'two losses count');
ok(!offerEasy('a', 'normal'), 'no offer after two');
ok(recordLoss('a') === 3 && offerEasy('a', 'normal') && offerEasy('a', 'hard'), 'offer after three');
ok(!offerEasy('a', 'easy'), 'no offer once on Easy');
ok(recordLoss('b') === 1 && lossesOn('a') === 0, 'a loss elsewhere restarts');
clearLosses();
ok(lossesOn('b') === 0, 'a win clears');

markCleared('x', 'easy');
ok(easyCleared().has('x'), 'easy clear is badged');
markCleared('x', 'normal');
ok(!easyCleared().has('x'), 'a later normal clear removes the badge');

if (fails) process.exit(1);
console.log('difficulty ok');
