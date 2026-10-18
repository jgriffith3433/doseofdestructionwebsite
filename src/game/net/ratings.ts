// The leaderboard's rules (docs/online.md, "The leaderboard"), pure so every page and the Node tests run the same
// code: what a signed match result is, when it counts, and the Elo table built from the results. Every client builds
// its table from the same public results with this code, so every client shows the same ratings and ranks.
//
// A result names the match, both players' profile ids (their public keys), the winner, the fighters, the stage, the
// length and the time, and carries each player's Schnorr signature over that body. It counts when:
//   - both players signed it ("game", "time"), or
//   - it is marked "left" (a player left or the link dropped): the winner signed it, and the leaver signed either it
//     or the match's start (proof they were in the match). Two "left" claims for one match that disagree void it.
// One result per match id; at most PAIR_PER_DAY rated matches a day for the same two players.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex } from './util.ts';

export const START_RATING = 1000;
export const K = 32;
/** Matches a day between the same two players that count; later ones that day are ignored. */
export const PAIR_PER_DAY = 5;
/** No result from before online play existed (2026-10-01 UTC). */
const EPOCH = 1790812800;

export type ResultReason = 'game' | 'time' | 'left';

export interface ResultRecord {
  /** Match id (made by the host). */
  m: string;
  /** Profile ids (public keys, hex) by slot; slot 0 hosted. */
  p: [string, string];
  /** The winning slot, or -1 for a draw. */
  w: number;
  /** Fighter ids by slot. */
  f: [string, string];
  /** Stage id. */
  s: string;
  /** Sim frames played (60 a second). */
  n: number;
  /** When the match was set up, unix seconds (the host's clock, in the setup both signed). */
  t: number;
  r: ResultReason;
  /** Each slot's signature over the result body, '' when missing. */
  sig: [string, string];
  /** Each slot's signature over the match's start body, '' when missing. */
  st: [string, string];
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MATCH_ID = /^[0-9a-z-]{8,60}$/;
const SLUG = /^[0-9a-z-]{1,40}$/;

/** What both players sign before the fight: proof each was in this match. */
export function startBody(r: Pick<ResultRecord, 'm' | 'p' | 'f' | 's' | 't'>): string {
  return JSON.stringify(['dod-start', 1, r.m, r.p[0], r.p[1], r.f[0], r.f[1], r.s, r.t]);
}

/** What both players sign after the fight. */
export function resultBody(r: Omit<ResultRecord, 'sig' | 'st'>): string {
  return JSON.stringify(['dod-result', 1, r.m, r.p[0], r.p[1], r.w, r.f[0], r.f[1], r.s, r.n, r.t, r.r]);
}

const encoder = new TextEncoder();
const digest = (body: string) => sha256(encoder.encode(body));

export function signBody(secret: Uint8Array, body: string): string {
  return toHex(schnorr.sign(digest(body), secret));
}

export function verifyBody(pubkey: string, body: string, sig: string): boolean {
  if (!HEX64.test(pubkey) || !HEX128.test(sig)) return false;
  try {
    return schnorr.verify(fromHex(sig), digest(body), fromHex(pubkey));
  } catch {
    return false;
  }
}

/** A result's shape (anything from a relay goes through here first), or null. Signatures aren't checked here. */
export function parseRecord(raw: unknown): ResultRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pair = (v: unknown, ok: (x: unknown) => boolean) => Array.isArray(v) && v.length === 2 && v.every(ok);
  const str = (re: RegExp) => (x: unknown) => typeof x === 'string' && re.test(x);
  const sigOk = (x: unknown) => x === '' || str(HEX128)(x);
  if (!str(MATCH_ID)(r.m) || !pair(r.p, str(HEX64)) || !pair(r.f, str(SLUG)) || !str(SLUG)(r.s)) return null;
  if ((r.p as string[])[0] === (r.p as string[])[1]) return null;
  if (r.w !== -1 && r.w !== 0 && r.w !== 1) return null;
  if (r.r !== 'game' && r.r !== 'time' && r.r !== 'left') return null;
  if (!Number.isInteger(r.n) || (r.n as number) < 0 || (r.n as number) > 60 * 60 * 60) return null;
  if (!Number.isInteger(r.t) || (r.t as number) < EPOCH || (r.t as number) > 0xffffffff) return null;
  if (!pair(r.sig, sigOk) || !pair(r.st, sigOk)) return null;
  if (r.r === 'left' && r.w === -1) return null;
  return {
    m: r.m as string,
    p: [...(r.p as [string, string])],
    w: r.w,
    f: [...(r.f as [string, string])],
    s: r.s as string,
    n: r.n as number,
    t: r.t as number,
    r: r.r,
    sig: [...(r.sig as [string, string])],
    st: [...(r.st as [string, string])],
  } as ResultRecord;
}

/**
 * Checks a result's signatures: "full" (both players signed the result), "claim" (a valid "left": the winner signed
 * it and the leaver signed the start), or null (it doesn't count).
 */
export function checkRecord(r: ResultRecord): 'full' | 'claim' | null {
  const body = resultBody(r);
  const signed = [0, 1].map((i) => !!r.sig[i] && verifyBody(r.p[i], body, r.sig[i]));
  if (signed[0] && signed[1]) return 'full';
  if (r.r !== 'left' || r.w < 0 || !signed[r.w]) return null;
  const leaver = 1 - r.w;
  return r.st[leaver] && verifyBody(r.p[leaver], startBody(r), r.st[leaver]) ? 'claim' : null;
}

export interface Checked {
  record: ResultRecord;
  kind: 'full' | 'claim';
}

/**
 * One result per match: a fully signed one wins (the lowest body if there were ever two); otherwise the "left" claims,
 * if they agree on the winner; claims that disagree (both sides say the other dropped) void the match.
 */
export function settle(results: Checked[]): ResultRecord[] {
  const byMatch = new Map<string, Checked[]>();
  for (const c of results) {
    const list = byMatch.get(c.record.m);
    if (list) list.push(c);
    else byMatch.set(c.record.m, [c]);
  }
  const out: ResultRecord[] = [];
  for (const list of byMatch.values()) {
    const full = list.filter((c) => c.kind === 'full');
    const pool = full.length ? full : list;
    if (!full.length && new Set(pool.map((c) => c.record.w)).size > 1) continue;
    let best = pool[0].record;
    let bestBody = resultBody(best);
    for (const c of pool.slice(1)) {
      const body = resultBody(c.record);
      if (body < bestBody) {
        best = c.record;
        bestBody = body;
      }
    }
    out.push(best);
  }
  return out;
}

// The expected score, integer-only so every browser agrees to the point: EXPECT_STEPS[i] is the smallest rating
// difference at which the stronger player is expected to score 51 + i percent (the logistic Elo curve, rounded, as
// FIDE tabulates it).
const EXPECT_STEPS = [4, 11, 18, 25, 32, 39, 46, 53, 60, 67, 75, 82, 89, 97, 104, 112, 120, 127, 135, 144, 152, 160, 169, 178, 187, 196, 206, 215, 225, 236, 247, 258, 270, 282, 295, 309, 323, 339, 355, 373, 392, 413, 437, 464, 495, 531, 577, 637, 727];

/** Expected score in percent (1..99) of a player rated `diff` above the other. */
export function expected(diff: number): number {
  if (diff < 0) return 100 - expected(-diff);
  let e = 50;
  for (const step of EXPECT_STEPS) if (diff >= step) e++;
  return e;
}

/** The rating change for slot 0's player (slot 1's is the negative): score is 1 win, 0.5 draw, 0 loss. */
export function eloDelta(r0: number, r1: number, score: number): number {
  // K * (100 * score - E) / 100 never lands on .5 with K = 32, so the rounding is the same everywhere.
  return Math.round((K * (Math.round(score * 100) - expected(r0 - r1))) / 100);
}

export interface PlayerStats {
  id: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  /** Current run: +3 is three wins in a row, -2 two losses; 0 after a draw. */
  streak: number;
  /** The fighter played most (ties: the one played last). */
  favourite: string;
  /** Unix seconds of the last counted match. */
  last: number;
}

export interface Board {
  players: Map<string, PlayerStats>;
  /** Each counted match's rating change by slot. */
  deltas: Map<string, [number, number]>;
  /** Matches over the day's limit for their pair (they don't count). */
  overLimit: Set<string>;
  /** Rows by rank, best first. */
  table: (PlayerStats & { rank: number })[];
}

export interface BoardOptions {
  /** Only matches from this unix second on (the weekly table). */
  since?: number;
  /** Ignore results stamped later than this (a clock far ahead); default: no limit. */
  until?: number;
  pairPerDay?: number;
}

/** Builds the table from settled results. The same results give the same table, rating for rating, on every client. */
export function computeBoard(results: ResultRecord[], opts: BoardOptions = {}): Board {
  const since = opts.since ?? 0;
  const until = opts.until ?? Infinity;
  const limit = opts.pairPerDay ?? PAIR_PER_DAY;
  const list = results.filter((r) => r.t >= since && r.t <= until).sort((a, b) => a.t - b.t || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
  const players = new Map<string, PlayerStats & { fighters: Map<string, { n: number; at: number }> }>();
  const deltas = new Map<string, [number, number]>();
  const overLimit = new Set<string>();
  const perPairDay = new Map<string, number>();
  const get = (id: string) => {
    let p = players.get(id);
    if (!p) {
      p = { id, rating: START_RATING, wins: 0, losses: 0, draws: 0, games: 0, streak: 0, favourite: '', last: 0, fighters: new Map() };
      players.set(id, p);
    }
    return p;
  };
  list.forEach((r, order) => {
    const pairDay = `${[...r.p].sort().join('|')}|${Math.floor(r.t / 86400)}`;
    const n = (perPairDay.get(pairDay) ?? 0) + 1;
    perPairDay.set(pairDay, n);
    if (n > limit) {
      overLimit.add(r.m);
      return;
    }
    const a = get(r.p[0]);
    const b = get(r.p[1]);
    const score = r.w === 0 ? 1 : r.w === 1 ? 0 : 0.5;
    const d = eloDelta(a.rating, b.rating, score);
    a.rating += d;
    b.rating -= d;
    deltas.set(r.m, [d, -d]);
    [a, b].forEach((p, slot) => {
      p.games++;
      p.last = r.t;
      if (r.w < 0) {
        p.draws++;
        p.streak = 0;
      } else if (r.w === slot) {
        p.wins++;
        p.streak = p.streak > 0 ? p.streak + 1 : 1;
      } else {
        p.losses++;
        p.streak = p.streak < 0 ? p.streak - 1 : -1;
      }
      const f = p.fighters.get(r.f[slot]) ?? { n: 0, at: 0 };
      p.fighters.set(r.f[slot], { n: f.n + 1, at: order });
    });
  });
  const stats: PlayerStats[] = [...players.values()].map(({ fighters, ...p }) => {
    let fav = '';
    let best = { n: 0, at: -1 };
    for (const [id, f] of fighters) if (f.n > best.n || (f.n === best.n && f.at > best.at)) [fav, best] = [id, f];
    return { ...p, favourite: fav };
  });
  stats.sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    players: new Map(stats.map((p) => [p.id, p])),
    deltas,
    overLimit,
    table: stats.map((p, i) => ({ ...p, rank: i + 1 })),
  };
}

/** Monday 00:00 UTC of the week holding `nowSec`: the weekly table starts there. */
export function weekStart(nowSec: number): number {
  const day = Math.floor(nowSec / 86400);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  return (day - ((day + 3) % 7)) * 86400;
}

/** "+18", "−12" (a real minus), "±0". */
export function formatDelta(d: number): string {
  return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0';
}
