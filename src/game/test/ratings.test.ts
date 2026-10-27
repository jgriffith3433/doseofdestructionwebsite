// Headless checks for the leaderboard's rules (docs/online.md, "The leaderboard"): run with `npm test`.
// 1. Signing: a result counts only with good signatures; a changed field, a swapped key or a missing signature fails.
// 2. "left" results: the winner's signature plus the leaver's start (or result) signature; disagreeing claims void.
// 3. Dedupe: one result per match id; the pair-per-day limit.
// 4. Elo: integer, zero-sum, the same table whatever order the results arrive in.

import { makeKey } from '../net/sign.ts';
import {
  K, PAIR_PER_DAY, START_RATING, checkRecord, computeBoard, eloDelta, expected, formatDelta, parseRecord, resultBody, settle,
  signBody, startBody, weekStart, type Checked, type ResultRecord,
} from '../net/ratings.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const T0 = 1791000000; // 2026-10-03
const keys = Array.from({ length: 6 }, (_, i) => makeKey((i + 1).toString(16).padStart(64, '0')));
const pid = (i: number) => keys[i].pubkey;

let matchNo = 0;
/** A result between players a and b (slot 0 = a), signed as asked. */
function result(a: number, b: number, w: number, opts: { t?: number; r?: ResultRecord['r']; sign?: [boolean, boolean]; start?: [boolean, boolean]; m?: string } = {}): ResultRecord {
  const body = { m: opts.m ?? `m${String(++matchNo).padStart(4, '0')}-test`, p: [pid(a), pid(b)] as [string, string], w, f: ['exit-punk', 'break'] as [string, string], s: 'city-top', n: 3600, t: opts.t ?? T0 + matchNo * 60, r: opts.r ?? 'game' };
  const sign = opts.sign ?? [true, true];
  const start = opts.start ?? [true, true];
  return {
    ...body,
    sig: [sign[0] ? signBody(keys[a].secret, resultBody(body)) : '', sign[1] ? signBody(keys[b].secret, resultBody(body)) : ''],
    st: [start[0] ? signBody(keys[a].secret, startBody(body)) : '', start[1] ? signBody(keys[b].secret, startBody(body)) : ''],
  };
}
const checked = (list: ResultRecord[]): Checked[] => list.flatMap((record) => {
  const kind = checkRecord(record);
  return kind ? [{ record, kind }] : [];
});

// ------------------------------------------------------------------ signing

{
  const r = result(0, 1, 0);
  check(checkRecord(r) === 'full', 'a result both players signed counts');
  check(parseRecord(JSON.parse(JSON.stringify(r))) !== null, 'a result survives the trip through JSON');
  check(checkRecord({ ...r, w: 1 }) === null, 'changing the winner breaks the signatures');
  check(checkRecord({ ...r, n: r.n + 1 }) === null, 'changing the length breaks the signatures');
  check(checkRecord({ ...r, p: [pid(0), pid(2)] }) === null, 'swapping in another player breaks the signatures');
  check(checkRecord({ ...r, sig: [r.sig[0], r.sig[0]] }) === null, 'one player signing twice is not two signatures');
  check(checkRecord(result(0, 1, 0, { sign: [true, false] })) === null, 'a game result with one signature does not count');
  const flipped = r.sig[1].slice(0, 10) + (r.sig[1][10] === '0' ? '1' : '0') + r.sig[1].slice(11);
  check(checkRecord({ ...r, sig: [r.sig[0], flipped] }) === null, 'a bad signature does not count');
  check(parseRecord({ ...r, p: [pid(0), pid(0)] }) === null, 'a player against themselves is refused');
  check(parseRecord({ ...r, t: 1700000000 }) === null, 'a result from before online play is refused');
  check(parseRecord({ ...r, m: 'x' }) === null && parseRecord({ ...r, sig: ['zz', r.sig[1]] }) === null, 'malformed fields are refused');
}

// ------------------------------------------------------------------ "left"

{
  const claim = result(0, 1, 0, { r: 'left', sign: [true, false], start: [false, true] });
  check(checkRecord(claim) === 'claim', 'a "left" result counts with the winner\'s signature and the leaver\'s start');
  check(checkRecord(result(0, 1, 0, { r: 'left', sign: [true, false], start: [true, false] })) === null, 'a "left" claim without the leaver\'s start signature does not count');
  check(checkRecord(result(0, 1, 1, { r: 'left', sign: [true, false], start: [true, true] })) === null, 'a "left" claim signed only by the loser does not count');
  check(checkRecord(result(0, 1, 0, { r: 'left', sign: [true, true], start: [false, false] })) === 'full', 'a "left" result the leaver signed too is full');
  check(parseRecord(JSON.parse(JSON.stringify({ ...claim, n: 0 }))) === null, 'a "left" before a frame was played (quitting on the VS screen) is refused: never a win');
  check(parseRecord(JSON.parse(JSON.stringify({ ...claim, n: 1 }))) !== null, 'a "left" one frame in still counts');
  const m = 'mutual-drop-1';
  const a = result(0, 1, 0, { m, r: 'left', sign: [true, false] });
  const b = result(0, 1, 1, { m, r: 'left', sign: [false, true] });
  check(settle(checked([a, b])).length === 0, 'two "left" claims that disagree void the match');
  check(settle(checked([a, a])).length === 1, 'the same claim twice counts once');
}

// ------------------------------------------------------------------ dedupe

{
  const r = result(2, 3, 0);
  const copy = JSON.parse(JSON.stringify(r)) as ResultRecord;
  check(settle(checked([r, copy, r])).length === 1, 'the same match published by both players counts once');
  const claim = result(2, 3, 1, { m: r.m, r: 'left', sign: [false, true] });
  const won = settle(checked([claim, r]));
  check(won.length === 1 && won[0].w === 0, 'a fully signed result beats a "left" claim for the same match');
  const day = T0 + 86400 * 3;
  const many = Array.from({ length: PAIR_PER_DAY + 3 }, (_, i) => result(4, 5, 0, { t: day + i * 100 }));
  const board = computeBoard(settle(checked(many)));
  check(board.players.get(pid(4))!.wins === PAIR_PER_DAY && board.overLimit.size === 3, `the same pair counts ${PAIR_PER_DAY} matches a day, no more`);
  const nextDay = computeBoard(settle(checked([...many, result(5, 4, 0, { t: day + 86400 + 10 })])));
  check(nextDay.players.get(pid(5))!.wins === 1, 'the next day counts again (either seat)');
}

// ------------------------------------------------------------------ Elo

{
  check(expected(0) === 50 && expected(400) === 91 && expected(-400) === 9 && expected(2000) === 99, 'the expected score table (0 → 50%, +400 → 91%)');
  let symmetric = true;
  for (let d = 0; d <= 900; d++) if (expected(d) + expected(-d) !== 100) symmetric = false;
  check(symmetric, 'the expected score is symmetric, so every match is zero-sum');
  check(eloDelta(1000, 1000, 1) === K / 2 && eloDelta(1000, 1000, 0) === -K / 2 && eloDelta(1000, 1000, 0.5) === 0, `equal ratings: +${K / 2} / -${K / 2}, a draw ±0`);
  check(eloDelta(1200, 1000, 1) < K / 2 && eloDelta(1000, 1200, 1) > K / 2, 'beating a stronger player is worth more');

  // A season: 6 players, 200 random results.
  let seed = 11;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const season: ResultRecord[] = [];
  for (let i = 0; i < 200; i++) {
    const a = rand(6);
    const b = (a + 1 + rand(5)) % 6;
    season.push(result(a, b, rand(10) === 0 ? -1 : rand(2), { r: 'time', t: T0 + 86400 * 5 + i * 1000 }));
  }
  const one = computeBoard(settle(checked(season)));
  const shuffled = [...season].reverse();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const two = computeBoard(settle(checked([...shuffled, ...season.slice(0, 40)])));
  const row = (b: typeof one) => b.table.map((p) => `${p.rank}:${p.id.slice(0, 8)}:${p.rating}:${p.wins}-${p.losses}-${p.draws}:${p.streak}:${p.favourite}`).join(' ');
  check(row(one) === row(two), 'the same results in any order (and with repeats) give the same table');
  const total = one.table.reduce((sum, p) => sum + p.rating, 0);
  check(total === START_RATING * one.table.length, `ratings stay zero-sum (${total} over ${one.table.length} players)`);
  check(one.table.every((p, i) => i === 0 || one.table[i - 1].rating >= p.rating) && one.table.every((p) => Number.isInteger(p.rating)), 'the table is by rating, integers only');
  const games = one.table.reduce((s, p) => s + p.games, 0);
  check(games === 2 * (200 - one.overLimit.size), 'every counted match counts for both players');

  // Streaks and the favourite fighter.
  const x = [result(0, 1, 0, { t: T0 + 864000 }), result(0, 1, 0, { t: T0 + 864100 }), result(1, 0, 0, { t: T0 + 864200 })];
  const b = computeBoard(settle(checked(x)));
  check(b.players.get(pid(0))!.streak === -1 && b.players.get(pid(1))!.streak === 1, 'streaks: W W L is -1, L L W is +1');
  check(b.players.get(pid(0))!.favourite === 'exit-punk' && b.players.get(pid(1))!.favourite === 'break', 'the favourite fighter is the one played most');
  const [d0, d1] = b.deltas.get(x[0].m)!;
  check(d0 === 16 && d1 === -16, `the first match of two new players: ${formatDelta(d0)} / ${formatDelta(d1)}`);
}

// ------------------------------------------------------------------ weekly

{
  const monday = Date.UTC(2026, 9, 12) / 1000;
  check(weekStart(monday) === monday && weekStart(monday + 6 * 86400 + 86399) === monday && weekStart(monday - 1) === monday - 7 * 86400, 'the week runs Monday to Sunday, UTC');
  const old = result(0, 1, 0, { t: monday - 3600 });
  const fresh = result(0, 1, 1, { t: monday + 3600 });
  const week = computeBoard(settle(checked([old, fresh])), { since: monday });
  check(week.players.get(pid(1))!.rating === START_RATING + 16 && week.players.get(pid(0))!.wins === 0, 'the weekly table counts only this week, from a fresh start');
}

if (failed) {
  console.log(`\n${failed} rating check(s) failed`);
  process.exit(1);
}
console.log('\nall rating checks passed');
