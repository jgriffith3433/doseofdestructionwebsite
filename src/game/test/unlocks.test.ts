// Headless checks for hero unlocks (docs/story.md, "Unlocks"): run with `npm test`.
// 1. Data: every chapter `unlock` names a real fighter, one chapter per fighter, and never Exit Punk (the campaign player).
// 2. The rule: locked until the chapter is cleared; unlocked fighters stay; everyone else is open from the start.
// 3. The store (dod-unlocks): saved, read back, and older saves get the unlocks of the chapters they already cleared.
// 4. Online: the profile picture (the fighter played online) follows the same rule as Versus select.

import { CHAPTERS, LOCKABLE, fighterOpen, loadUnlocks, saveUnlocks, unlockFor } from '../campaign/story.ts';
import { CHARACTERS } from '../sim/characters.ts';

declare const process: { exit(code: number): never };
declare const globalThis: { localStorage?: unknown };

let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

// A tiny localStorage, as in a browser.
const data = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
};

// ------------------------------------------------------------------ data
{
  const named = CHAPTERS.filter((c) => c.unlock);
  check(named.length > 0, 'some chapters name a fighter to unlock');
  check(named.every((c) => CHARACTERS.some((f) => f.id === c.unlock)), 'every unlock names a fighter in the roster');
  check(new Set(named.map((c) => c.unlock)).size === named.length, 'no fighter is unlocked by two chapters');
  check(!LOCKABLE.has('exit-punk'), 'Exit Punk, the campaign player, is never locked');
  check(CHAPTERS.some((c) => !c.unlock), 'a chapter may leave `unlock` out');
  check(LOCKABLE.size < CHARACTERS.length, 'not every fighter is locked');
}

// ------------------------------------------------------------------ the rule
{
  const first = CHAPTERS.find((c) => c.unlock)!;
  const fighter = first.unlock!;
  const have = new Set<string>();
  check(!fighterOpen(fighter, have), `${fighter} is locked on a fresh save`);
  check(fighterOpen('exit-punk', have), 'Exit Punk is open on a fresh save');
  check(CHARACTERS.filter((c) => !fighterOpen(c.id, have)).length === LOCKABLE.size, 'a fresh save locks exactly the named fighters');
  check(unlockFor(first, have) === fighter, 'clearing the chapter unlocks its fighter');
  check(fighterOpen(fighter, have), `${fighter} is open after the chapter`);
  check(unlockFor(first, have) === null, 'clearing it again unlocks nothing new');
  const noUnlock = CHAPTERS.find((c) => !c.unlock);
  check(!noUnlock || unlockFor(noUnlock, new Set()) === null, 'a chapter with no unlock field unlocks nothing');
}

// ------------------------------------------------------------------ the store
{
  data.clear();
  check(loadUnlocks(new Set()).size === 0, 'a fresh save has nothing unlocked');
  saveUnlocks(new Set(['kaelen']));
  check(data.get('dod-unlocks') === '["kaelen"]', 'the store is the localStorage key dod-unlocks');
  check(loadUnlocks(new Set()).has('kaelen'), 'saved unlocks load again');
  data.set('dod-unlocks', 'not json');
  check(loadUnlocks(new Set()).size === 0, 'a broken store is a fresh one');
  data.set('dod-unlocks', '[1,"kaelen",null]');
  check(loadUnlocks(new Set()).size === 1, 'only ids are read from the store');
  data.clear();
  const done = new Set(CHAPTERS.filter((c) => c.unlock).slice(0, 2).map((c) => c.id));
  const loaded = loadUnlocks(done);
  check([...done].every((id) => loaded.has(CHAPTERS.find((c) => c.id === id)!.unlock!)), 'an older save gets the unlocks of its cleared chapters');
}

// ------------------------------------------------------------------ online
{
  data.clear();
  const { profile, setProfile, avatarChar } = await import('../net/profile.ts');
  const locked = [...LOCKABLE][0];
  const open = CHARACTERS.find((c) => !LOCKABLE.has(c.id))!.id;
  check(profile().avatar !== '' && !LOCKABLE.has(profile().avatar), 'a fresh profile picture is a fighter that is open');
  setProfile({ avatar: locked });
  check(profile().avatar !== locked, 'the profile picture (the fighter played online) cannot be a locked fighter');
  setProfile({ avatar: open });
  check(profile().avatar === open && CHARACTERS[avatarChar(profile().avatar)].id === open, 'an open fighter can be the picture');
  const first = CHAPTERS.find((c) => c.unlock === locked)!;
  const { unlocks } = await import('../campaign/story.ts');
  unlockFor(first, unlocks());
  setProfile({ avatar: locked });
  check(profile().avatar === locked, 'after the chapter, the same fighter can be picked online');
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all unlock checks passed');
