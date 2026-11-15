// Season 8 to 10 rewards: every episode of those seasons has one, ids are unique, a stage variant borrows a real grade,
// earning is kept, titles and tints work only once earned, and tints become extra looks.
import assert from 'node:assert/strict';
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 } as Storage;
const { CHAPTERS } = await import('../campaign/story.ts');
const R = await import('../campaign/rewards.ts');
const { STAGES } = await import('../sim/stage.ts');
const { lookOpen, looksOf, lookCount } = await import('../looks.ts');

const late = CHAPTERS.filter((c) => c.season >= 8);
assert.equal(late.length, 10);
for (const c of late) assert.ok(c.reward && c.reward.name && c.reward.line, `${c.id} has a reward`);
assert.equal(new Set(R.REWARDS.map((r) => r.reward.id)).size, R.REWARDS.length, 'unique ids');
for (const { reward } of R.REWARDS) {
  if (reward.kind === 'stage') assert.ok(STAGES.some((s) => s.id === reward.stage) && STAGES.some((s) => s.id === reward.grade) && reward.stage !== reward.grade, `${reward.id} uses real stages`);
}
const kinds = new Set(R.REWARDS.map((r) => r.reward.kind));
assert.deepEqual([...kinds].sort(), ['stage', 'tint', 'title']);
assert.equal(R.owned().size, 0);
assert.equal(lookCount(0), 4, 'no tint swatch before it is earned');

const title = late.find((c) => c.reward!.kind === 'title')!;
assert.equal(R.earnReward(title)?.id, title.reward!.id, 'first win earns it');
assert.equal(R.earnReward(title), null, 'a second win is not news');
R.pickTitle(title.reward!.id);
assert.equal(R.pickedTitle()?.id, title.reward!.id);
const other = late.find((c) => c.reward!.kind === 'title' && c !== title)!;
R.pickTitle(other.reward!.id);
assert.equal(R.pickedTitle(), null, 'a title not earned is never worn');

const stage = late.find((c) => c.reward!.kind === 'stage')!;
R.earnReward(stage);
const sr = stage.reward!;
assert.equal(R.gradeSource(sr.stage!), sr.stage);
R.setVariant(sr.id);
assert.equal(R.gradeSource(sr.stage!), sr.grade);
assert.equal(R.gradeSource('some-other-stage'), 'some-other-stage');
R.setVariant(null);
assert.equal(R.gradeSource(sr.stage!), sr.stage);
R.setVariant(other.reward!.id);
assert.equal(R.activeVariant(), null, 'a reward you do not own is not applied');

const tint = late.find((c) => c.reward!.kind === 'tint')!;
R.earnReward(tint);
assert.equal(lookCount(0), 5);
assert.ok(lookOpen(0, 4) && looksOf(0)[4].name === tint.reward!.name);
R.clearRewards();
assert.equal(lookCount(0), 4);
console.log('rewards ok');
