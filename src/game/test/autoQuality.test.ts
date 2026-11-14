declare const process: { exit(code: number): never };
// Auto quality (render/autoQuality.ts): steps down over budget inside 5 s, never on a hit-stop frame, skips levels that change
// nothing on this device, never after the decide window, steps back up only at a match start (and not again after a failed
// try), and does nothing while disabled (a quality picked by hand).

let failed = 0;
const ok = (c: unknown, m: string) => {
  if (!c) {
    failed++;
    console.error(`FAIL: ${m}`);
  }
};
import { AutoQuality, AUTO_LEVELS, DECIDE_MS, effectsFor, nextLevel, signature } from '../render/autoQuality.ts';

const desktop = { scale: 2, glow: true, quality: 'high' };
const phone = { scale: 1, glow: false, quality: 'low' };

/** Runs `ms` of play at a fixed frame time; the frame time follows `cost(level)`. Returns the changes and the time of the last one. */
const play = (a: AutoQuality, base: typeof desktop, ms: number, cost: (level: number) => number, calm = () => true) => {
  let t = 0;
  const seen: number[] = [];
  while (t < ms) {
    const dt = cost(a.level);
    t += dt;
    const c = a.frame(dt, calm(), base);
    if (c) seen.push(t);
  }
  return seen;
};

// Levels: cumulative and no-op levels skipped.
ok(effectsFor(0).scaleMax === Infinity && !effectsFor(0).glowOff, 'level 0 changes nothing');
ok(effectsFor(AUTO_LEVELS).scaleMax === 0.5 && effectsFor(AUTO_LEVELS).glowOff && effectsFor(AUTO_LEVELS).hideParallax, 'the last level is the cheapest');
ok(nextLevel(1, 1, phone) === 3, `on a phone (glow off, Low) level 2 is skipped (got ${nextLevel(1, 1, phone)})`);
ok(nextLevel(0, 1, desktop) === 1 && nextLevel(1, 1, desktop) === 2 && nextLevel(2, 1, desktop) === 3, 'on desktop every level counts');
ok(nextLevel(AUTO_LEVELS, 1, desktop) === AUTO_LEVELS, 'no level above the last');
ok(signature(1, { scale: 0.6, glow: false, quality: 'low' }) === signature(0, { scale: 0.6, glow: false, quality: 'low' }), 'a scale already under the cap makes level 1 a no-op');

// A slow device: 40 ms a frame at level 0, each step cheaper. It settles in under 5 s and holds 45 fps.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  const cost = (l: number) => [40, 28, 21, 14, 9][l];
  const steps = play(a, desktop, 12000, cost);
  ok(steps.length >= 1 && a.level >= 2, `a slow device steps down (level ${a.level})`);
  ok(steps.every((s) => s <= 5000), `every step inside 5 s (${steps.join(', ')})`);
  ok(1000 / cost(a.level) >= 45, `settles at 45 fps or better (level ${a.level})`);
  ok(a.settled && a.settledAtMs > 0 && a.settledAtMs < 6500, `settled at ${a.settledAtMs} ms`);
  ok(a.changes.every((c) => c.dir === 'down'), 'only steps down while measuring');
}

// A very slow device (60 ms) takes a double step.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  play(a, desktop, 1000, () => 60);
  ok(a.changes[0] && a.changes[0].to - a.changes[0].from === 2, 'far over budget takes two steps at once');
}

// A fast device stays at level 0 and nothing changes.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  ok(play(a, desktop, 12000, () => 16.7).length === 0 && a.level === 0 && a.settled, 'a device at 60 fps is left alone');
}

// Hit-stop and punch frames are never measured: a slow stretch that is all hit-stop moves nothing.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  ok(play(a, desktop, 6000, () => 50, () => false).length === 0 && a.level === 0, 'no step on a non-calm frame');
}

// A load stall (over 1.5 s) is not the picture's cost.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  ok(a.frame(2000, true, desktop) === null && a.level === 0, 'a stall is ignored');
}

// After the decide window the match plays as it settled.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  play(a, desktop, DECIDE_MS + 100, () => 16.7);
  const before = a.level;
  const late = play(a, desktop, 5000, () => 60);
  ok(late.length === 0 && a.level === before, 'no step down late in a match');
}

// Step up: only at the next match start, one level, only with headroom; a failed try is never repeated.
{
  const a = new AutoQuality();
  a.beginMatch(desktop);
  play(a, desktop, 12000, (l) => [40, 28, 21, 14, 9][l]);
  const settledAt = a.level;
  ok(a.headroomFps < 56 || settledAt === 0, 'a level that only just fits has no headroom');
  ok(a.beginMatch(desktop) === null && a.level === settledAt, 'no step up without headroom');
}
{
  const a = new AutoQuality(3);
  a.beginMatch(desktop);
  play(a, desktop, 4000, () => 10);
  ok(a.settled && a.headroomFps > 90, 'a fast level shows headroom');
  const up = a.beginMatch(desktop);
  ok(up && up.dir === 'up' && up.to === 2 && a.level === 2, 'the next match steps up one level');
  // The step up does not hold: it goes back down and stays down.
  const steps = play(a, desktop, 6000, (l) => (l >= 3 ? 10 : 30));
  ok(steps.length === 1 && a.level === 3 && a.upBlocked, 'a step up that does not hold goes back down and is blocked');
  a.beginMatch(desktop);
  play(a, desktop, 4000, () => 10);
  ok(a.beginMatch(desktop) === null && a.level === 3, 'no more step ups this visit');
}

// Disabled (a hand-picked quality): nothing is measured or changed, and a saved level does not step up.
{
  const a = new AutoQuality(2);
  a.enabled = false;
  ok(a.beginMatch(desktop) === null, 'disabled: no step up');
  ok(play(a, desktop, 8000, () => 80).length === 0 && a.level === 2 && a.changes.length === 0, 'disabled: no step down');
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('autoQuality: ok');
