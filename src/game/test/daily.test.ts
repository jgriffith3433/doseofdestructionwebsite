// Tonight's Episode (campaign/daily.ts, net/daily.ts): the same episode for a date, a different one for another, only
// valid picks from the campaign's own pool, the score and the day streak, and the board built from signed records
// (forged, wrong-date and wrong-room records don't count; one line per player, their best). Run: npm test.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { CHAPTER_ENTRIES } from '../campaign/story.ts';
import {
  DAILY_POOL, EMPTY_DAILY, addDays, countdown, dailyEpisode, dailyScore, dailySetup, dateKey, liveStreak, msToNext, objectiveLine, recordClear, twistLine,
  type DailyEpisode,
} from '../campaign/daily.ts';
import { makeKey, signEvent } from '../net/sign.ts';
import { DAILY_KIND, buildBoard, dailyTag, parseDaily } from '../net/daily.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const sig = (e: DailyEpisode) => JSON.stringify(e);

// ---- the pick
const D1 = '2026-11-11';
check(sig(dailyEpisode(D1)) === sig(dailyEpisode(D1)), 'the same date gives the same episode');
check(sig(dailyEpisode(D1)) !== sig(dailyEpisode(addDays(D1, 1))), 'a different date gives a different episode');
const days = Array.from({ length: 365 }, (_, i) => addDays('2026-01-01', i));
const eps = days.map((d) => dailyEpisode(d));
const distinct = new Set(eps.map(sig)).size;
check(distinct >= 360, `365 days give ${distinct} different episodes`);
check(new Set(eps.map((e) => e.player)).size >= 20, `the player's fighter varies (${new Set(eps.map((e) => e.player)).size} different over a year)`);
check(new Set(eps.map((e) => e.stage)).size === STAGES.length, 'every stage comes up');
check(new Set(eps.map((e) => e.objective)).size === 4, 'every objective comes up (ko, quota, streak, survive)');
check(new Set(eps.flatMap((e) => e.twists.map((t) => t.kind))).size === 5, 'every twist kind comes up (damage, gravity, startPercent, scale, teams)');
check(eps.some((e) => e.twists.length === 2) && eps.some((e) => e.twists.length === 1), 'one or two twists');
// Time of day and the player's clock don't enter: the date key is UTC.
check(dateKey(Date.UTC(2026, 10, 11, 23, 59, 59)) === '2026-11-11' && dateKey(Date.UTC(2026, 10, 12, 0, 0, 0)) === '2026-11-12', 'the day turns over at midnight UTC');
check(msToNext(Date.UTC(2026, 10, 11, 23, 0, 0)) === 3600000, 'the countdown runs to the next UTC midnight');
check(countdown(5 * 3600000 + 2 * 60000) === '5h 02m' && countdown(12 * 60000 + 9000) === '12m 09s', 'the countdown reads 5h 02m / 12m 09s');

const ids = new Set(CHARACTERS.map((c) => c.id));
const stages = new Set(STAGES.map((s) => s.id));
const objs = new Set(DAILY_POOL.objectives.map((o) => `${o.objective}|${o.timeLimit}`));
let bad = '';
for (const e of eps) {
  const who = [e.player, ...e.foes, ...(e.ally ? [e.ally] : [])];
  if (!who.every((x) => ids.has(x))) bad ||= `${e.date}: unknown fighter`;
  if (new Set(who).size !== who.length) bad ||= `${e.date}: a fighter twice`;
  if (who.includes('the-mechanic')) bad ||= `${e.date}: the Mechanic is not canon yet`;
  if (!stages.has(e.stage)) bad ||= `${e.date}: unknown stage`;
  if (!objs.has(`${e.objective}|${e.timeLimit}`)) bad ||= `${e.date}: an objective the campaign doesn't have`;
  if (e.twists.length < 1 || e.twists.length > 2 || new Set(e.twists.map((t) => t.kind)).size !== e.twists.length) bad ||= `${e.date}: twists`;
  if (!!e.ally !== e.twists.some((t) => t.kind === 'teams')) bad ||= `${e.date}: partner and teams twist disagree`;
  if (!CHAPTER_ENTRIES.some((c) => c.id === e.blogChapter)) bad ||= `${e.date}: Blog Man chapter`;
  if (twistLine(e).length > 40 || objectiveLine(e).length > 30) bad ||= `${e.date}: the card's line is long`;
  const s = dailySetup(e);
  if (s.slots.length < 2 || s.slots.length > 4 || s.slots[0].cpu !== null || s.slots.filter((x) => x.cpu === null).length !== 1) bad ||= `${e.date}: slots`;
  if (s.rules.timeLimit !== e.timeLimit || s.stage < 0 || s.slots.some((x) => x.char < 0)) bad ||= `${e.date}: setup`;
  if (!s.slots.some((x) => x.team === 1)) bad ||= `${e.date}: no foe`;
}
check(!bad, `every pick over a year is valid${bad ? `: ${bad}` : ''}`);

// ---- the score
const ko = dailyEpisode(days.find((d) => dailyEpisode(d).objective === 'ko')!);
const run = { won: true, frames: 3000, taken: 80, stocksLeft: 2, margin: 0 };
check(dailyScore(ko, { ...run, won: false }) === 0, 'a loss scores nothing');
check(dailyScore(ko, { ...run, frames: 2000 }) > dailyScore(ko, run), 'faster scores more');
check(dailyScore(ko, { ...run, taken: 20 }) > dailyScore(ko, run), 'less damage taken scores more');
check(dailyScore(ko, { ...run, margin: 2 }) > dailyScore(ko, run), 'going past the target scores more');
check(dailyScore(ko, { ...run, stocksLeft: 3 }) > dailyScore(ko, run), 'more stocks left scores more');
check(dailyScore(ko, { ...run, taken: 9999, frames: ko.timeLimit, stocksLeft: 0 }) === 400, 'a hard-won clear never scores under 100');
check(dailyScore(ko, { won: true, frames: 0, taken: 0, stocksLeft: 5, margin: 99 }) <= 3000, 'a score never passes the ceiling');

// ---- the streak
let st = recordClear(EMPTY_DAILY, '2026-11-11', 1200);
check(st.streak === 1 && st.best['2026-11-11'] === 1200, 'the first clear starts a streak of 1');
st = recordClear(st, '2026-11-11', 1500);
check(st.streak === 1 && st.best['2026-11-11'] === 1500, 'a second clear the same day keeps the streak and the best score');
st = recordClear(st, '2026-11-11', 900);
check(st.best['2026-11-11'] === 1500, 'a worse score does not replace the best');
st = recordClear(st, '2026-11-12', 1000);
check(st.streak === 2 && st.longest === 2, 'the next day makes 2');
check(liveStreak(st, '2026-11-13') === 2 && liveStreak(st, '2026-11-14') === 0, 'the streak is alive until a day is missed');
st = recordClear(st, '2026-11-15', 1000);
check(st.streak === 1 && st.longest === 2, 'a gap starts it again (the longest stays)');

// ---- the board
const keys = [1, 2, 3, 4].map((i) => makeKey(i.toString(16).padStart(64, '0')));
const T = 1791000000;
async function post(k: number, date: string, score: number, o: { room?: string; at?: number; tamper?: boolean } = {}) {
  const room = o.room ?? 'beta';
  const content = JSON.stringify({ v: 1, d: date, s: score, n: `Player ${k}`, a: 'exit-punk' });
  const e = await signEvent(keys[k], DAILY_KIND, [['d', `hawkes-dod/daily/${room}/${date}`], ['t', dailyTag(date, room)]], content, o.at ?? T + k);
  return o.tamper ? { ...e, content: content.replace(`"s":${score}`, `"s":${score + 500}`) } : e;
}
const events = [
  await post(0, D1, 1200),
  await post(1, D1, 1800),
  await post(2, D1, 1500, { tamper: true }),
  await post(3, D1, 2000, { room: 'global' }),
  await post(0, '2026-11-10', 2900),
  await post(0, D1, 1300, { at: T + 100 }),
];
const board = buildBoard(events, D1, undefined, 'beta');
check(board.entries.length === 2, 'forged, wrong-room and other-date records are left out');
check(board.entries[0].id === keys[1].pubkey && board.entries[0].score === 1800, 'best first');
check(board.entries[1].score === 1300, 'one line per player: their best');
check(parseDaily(events[2], D1, 'beta') === null, 'a record whose body was changed fails its signature');
check(parseDaily(events[1], '2026-11-10', 'beta') === null, "a record doesn't count on another date");
const mine = { id: keys[3].pubkey, name: 'Me', avatar: 'break', score: 1500 };
const withMe = buildBoard(events, D1, mine, 'beta');
check(withMe.rank === 2 && withMe.entries.length === 3, "the player's own score is on the board at once, in its place");

console.log(failed ? `${failed} FAILED` : 'daily: all ok');
if (failed) process.exit(1);
