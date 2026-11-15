// Headless checks for colour looks (looks.ts, content/fighters.json `looks`): run with `npm test`.
// 1. Data: every fighter has at least four looks, the first is today's art, 3 and 4 unlock at 3 and 10 wins, names differ.
// 2. Wins: stored in dod-wins, unlock looks at 3 and 10, a pick that is not open falls back to Classic.
// 3. Same fighter twice: the second moves to the next colour (an open one); different fighters are left alone.
// 4. The palette maths: Classic changes nothing; an outfit look turns its main hue and keeps skin and black; a neutral look tints greys.
// 5. Online: a setup from the other page is range-checked and never carries the same fighter in the same colour twice.

import { CHARACTERS } from '../sim/characters.ts';
import { MIN_LOOKS, addWin, lookOpen, lookOf, looksOf, openLook, preferredLook, recolor, rememberLook, separateLooks, winsToUnlock, winsWith, swatchColor } from '../looks.ts';
import { checkSetup, type OnlineSetup } from '../net/matchmaker.ts';

declare const process: { exit(code: number): never };
declare const globalThis: { localStorage?: unknown };

let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}
const data = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
};

// ------------------------------------------------------------------ data
{
  check(CHARACTERS.every((c) => c.looks.length >= MIN_LOOKS), `every fighter has at least ${MIN_LOOKS} looks`);
  check(CHARACTERS.every((c) => c.looks[0].from === undefined && c.looks[0].wins === 0), "look 1 is today's art (no palette change), open from the start");
  check(CHARACTERS.every((c) => c.looks[1].wins === 0), 'look 2 is open');
  check(CHARACTERS.every((c) => c.looks[2].wins === 3 && c.looks[3].wins === 10), 'looks 3 and 4 unlock at 3 and 10 wins');
  check(CHARACTERS.every((c) => new Set(c.looks.map((l) => l.name)).size === c.looks.length), 'look names differ within a fighter');
  check(CHARACTERS.every((c) => c.looks.slice(1).every((l) => l.from !== undefined)), 'every later look has a palette');
  check(winsToUnlock(looksOf(0)[2]) === '3 wins to unlock' && winsToUnlock(looksOf(0)[3]) === '10 wins to unlock', 'a locked swatch reads "3 wins to unlock" / "10 wins to unlock"');
  check(CHARACTERS.every((c, i) => new Set(c.looks.map((_, k) => swatchColor(i, k))).size === c.looks.length), 'swatch colours differ within a fighter');
}

// ------------------------------------------------------------------ wins
{
  const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
  check(winsWith('exit-punk') === 0 && lookOpen(ep, 0) && lookOpen(ep, 1) && !lookOpen(ep, 2) && !lookOpen(ep, 3), 'a fresh save has looks 1 and 2 only');
  check(openLook(ep, 2) === 0, 'a locked pick falls back to Classic');
  addWin('exit-punk');
  addWin('exit-punk');
  check(addWin('exit-punk').length === 1 && lookOpen(ep, 2) && !lookOpen(ep, 3), 'the third win unlocks look 3 (and says so)');
  check(data.get('dod-wins') === '{"exit-punk":3}', 'wins are kept in localStorage dod-wins');
  for (let i = 0; i < 6; i++) addWin('exit-punk');
  check(!lookOpen(ep, 3), '9 wins: look 4 still locked');
  check(addWin('exit-punk').includes(looksOf(ep)[3].name) && lookOpen(ep, 3), 'the tenth win unlocks look 4');
  check(winsWith('break') === 0, "another fighter's wins are its own");
  rememberLook(ep, 3);
  check(preferredLook(ep) === 3, 'the colour last picked comes back');
  data.set('dod-wins', 'junk');
  check(winsWith('exit-punk') === 0 && preferredLook(ep) === 0, 'unreadable storage falls back to a fresh save');
  data.clear();
}

// ------------------------------------------------------------------ same fighter, same colour
{
  const a = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
  const b = CHARACTERS.findIndex((c) => c.id === 'break');
  const same = [{ char: a, look: 0 }, { char: a, look: 0 }];
  check(separateLooks(same).join() === '1' && same[0].look === 0 && same[1].look === 1, 'two of one fighter in Classic: the second moves to the next colour');
  const diff = [{ char: a, look: 0 }, { char: b, look: 0 }];
  check(separateLooks(diff).length === 0 && diff[1].look === 0, 'different fighters keep their colours');
  const wrap = [{ char: a, look: 1 }, { char: a, look: 1 }];
  separateLooks(wrap, (_, i) => i < 2);
  check(wrap[1].look === 0, 'the next colour skips locked ones and wraps');
  const three = [{ char: a, look: 0 }, { char: a, look: 0 }, { char: a, look: 0 }];
  separateLooks(three);
  check(new Set(three.map((s) => s.look)).size === 3, 'three of a kind all differ');
  const locked = [{ char: a, look: 0 }, { char: a, look: 0 }];
  separateLooks(locked, (_, i) => i === 0);
  check(locked[1].look === 0, 'with no colour free the pick stays (nothing to move to)');
}

// ------------------------------------------------------------------ the palette maths
{
  const orange = looksOf(CHARACTERS.findIndex((c) => c.id === 'exit-punk'));
  const flip = orange[1];
  const near = (a: number[], b: number[], t = 0.02) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  check(near(recolor(0.9, 0.4, 0.1, orange[0]), [0.9, 0.4, 0.1], 0), 'Classic changes nothing');
  const out = recolor(0.9, 0.5, 0.05, flip); // vivid orange, hue ~33: the main colour
  check(!near(out, [0.9, 0.5, 0.05], 0.1) && out[2] > out[0], 'the main colour turns (orange goes to a blue-ish colour)');
  check(near(recolor(0.05, 0.05, 0.05, flip), [0.05, 0.05, 0.05]), 'black outlines stay');
  check(near(recolor(0.97, 0.97, 0.97, flip), [0.97, 0.97, 0.97]), 'white stays');
  check(near(recolor(0.3, 0.7, 0.3, flip), [0.3, 0.7, 0.3]), 'a colour far from the main hue stays');
  const dark = CHARACTERS.findIndex((c) => c.id === 'susan');
  const tint = looksOf(dark)[1];
  check(tint.from === -1, 'a dark fighter tints its greys (from -1)');
  const grey = recolor(0.5, 0.5, 0.5, tint);
  check(Math.max(...grey) - Math.min(...grey) > 0.1, 'a grey mid-tone takes the tint');
  check(near(recolor(0.02, 0.02, 0.02, tint), [0.02, 0.02, 0.02]) && near(recolor(0.98, 0.98, 0.98, tint), [0.98, 0.98, 0.98], 0.03), 'neutral looks keep blacks and whites');
  check(near(recolor(0.9, 0.7, 0.55, tint), [0.9, 0.7, 0.55]), 'neutral looks leave skin tones');
}

// ------------------------------------------------------------------ online
{
  const ids = ['host-id-12', 'guest-id-12'];
  const key = (c: string) => c.repeat(64);
  const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
  const base: OnlineSetup = {
    matchId: 'abcdef12-guest-id-12-x1', seed: 5, stage: 0, stocks: 1, rules: {}, timeLimit: 0, ids, names: ['A', 'B'], avatars: ['', ''],
    chars: [ep, ep], looks: [2, 2], pids: [key('a'), key('b')], at: 1700000000,
  };
  const ok = checkSetup(base, ids, base.pids);
  check(!!ok && ok.looks![0] === 2 && ok.looks![1] === 3, 'the same fighter and colour in a setup: the second moves to the next');
  const bad = checkSetup({ ...base, looks: [99, -1] }, ids, base.pids);
  check(!!bad && bad.looks![0] === 0 && bad.looks![1] === 1, 'out-of-range colours become Classic (then separated)');
  const old = checkSetup({ ...base, looks: undefined }, ids, base.pids);
  check(!!old && old.looks!.length === 2, 'a setup from an older page without looks still works');
  const other = checkSetup({ ...base, chars: [ep, ep + 1 < CHARACTERS.length ? ep + 1 : 0], looks: [1, 1] }, ids, base.pids);
  check(!!other && other.looks![0] === 1 && other.looks![1] === 1, 'different fighters may share a colour number');
  check(lookOf(ep, 99).name === looksOf(ep)[0].name, 'an out-of-range look reads as Classic');
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall looks checks passed');
