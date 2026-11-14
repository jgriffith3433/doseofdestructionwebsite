// Episode grades: 1 clear, 2 no stock lost, 3 also under par; survive's third star is damage; every chapter has a par.
import assert from 'node:assert/strict';
import { bestStars, gradeEpisode } from '../campaign/grade.ts';
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
console.log('grade ok');
