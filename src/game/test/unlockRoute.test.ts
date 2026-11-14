// The route to a locked fighter and the bar toward the next unlock come from the chapters' own `unlock` (no new rules).
import assert from 'node:assert/strict';
import { CHAPTERS, LOCKABLE, nextUnlock, unlockRoute } from '../campaign/story.ts';

for (const id of LOCKABLE) {
  const r = unlockRoute(id);
  assert.ok(r, `${id} has a route`);
  assert.equal(r.chapter.unlock, id);
  assert.match(r.text, /^Clear Season \d+, Episode \d+: /);
}
assert.equal(unlockRoute('exit-punk'), undefined);

const fresh = nextUnlock(new Set(), new Set());
assert.ok(fresh && fresh.away === 1 && fresh.fill === 0, 'a fresh save is one episode from the first unlock');
assert.equal(fresh.fighter, CHAPTERS.find((c) => c.unlock)!.unlock);
// Already unlocked: skip to the next one.
const second = nextUnlock(new Set(), new Set([fresh.fighter]));
assert.ok(second && second.away > 1 && second.fighter !== fresh.fighter);
console.log('unlockRoute ok');
