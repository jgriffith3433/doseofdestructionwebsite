// Episode grades: 1 clear, 2 no stock lost, 3 also under par; survive's third star is damage; every chapter has a par.
import assert from 'node:assert/strict';
import { bestStars, gradeEpisode, mergeBest, scoreEpisode } from '../campaign/grade.ts';
import { CHAPTERS } from '../campaign/story.ts';

const base = { won: true, stocksStart: 3, stocksLeft: 3, frames: 50 * 60, damageTaken: 40, par: 60 };
assert.equal(gradeEpisode({ ...base }).stars, 3);
assert.equal(gradeEpisode({ ...base, frames: 61 * 60 }).stars, 2);
assert.equal(gradeEpisode({ ...base, stocksLeft: 2 }).stars, 1, 'a lost stock caps it at 1 even when fast');
assert.equal(gradeEpisode({ ...base, won: false }).stars, 0);
assert.equal(gradeEpisode({ ...base, objective: 'survive', frames: 60 * 60, par: 60, damageTaken: 99 }).stars, 3);
assert.equal(gradeEpisode({ ...base, objective: 'survive', damageTaken: 100 }).stars, 2);
assert.equal(gradeEpisode({ ...base, par: 75 }).parLabel, 'Under 1:15');
assert.equal(bestStars(3, 1), 3);
assert.equal(bestStars(undefined, 2), 2);
for (const c of CHAPTERS) assert.ok(Number.isFinite(c.par) && c.par >= 15, `${c.id} has a par time`);
const sc = scoreEpisode({ kos: 3, dealt: 200, taken: 50, frames: 60 * 60, par: 60 });
assert.equal(sc.total, 1000 + 1500 + 1000 - 150 + 600, 'clear + KOs + dealt - taken + time bonus');
assert.equal(scoreEpisode({ kos: 0, dealt: 0, taken: 900, frames: 99999, par: 10 }).total, 0, 'never under 0');
assert.ok(scoreEpisode({ kos: 3, dealt: 200, taken: 0, frames: 60 * 40, par: 60 }).total > sc.total, 'faster and cleaner scores more');
assert.deepEqual(mergeBest(undefined, { score: 5, frames: 9 }), { best: { score: 5, frames: 9 }, beat: [] });
assert.deepEqual(mergeBest({ score: 5, frames: 9 }, { score: 6, frames: 10 }), { best: { score: 6, frames: 9 }, beat: ['score'] });
assert.deepEqual(mergeBest({ score: 5, frames: 9 }, { score: 4, frames: 8 }), { best: { score: 5, frames: 8 }, beat: ['time'] });
console.log('grade ok');
