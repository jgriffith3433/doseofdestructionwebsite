// Tonight's Episode's board (docs/online.md "Tonight's Episode"): a score is a signed Hawkes Net record keyed by the
// UTC date (NIP-78 shape like the leaderboard's results, signed with the profile key through sign.ts, kept by
// records.ts), one per player per day (the newest replaces: only a better score is sent). The board is read once,
// when results open (RecordsPool.fetchOnce: no subscription, no polling), checked here and shown best first. ?room
// test lobbies and the beta site have their own boards (the same tag rules as the leaderboard's lobbies).
import { signEvent, type NostrEvent } from './sign.ts';
import { sharedRecords, type RecordsPool } from './records.ts';
import { APP_ID, netError, seconds } from './util.ts';
import { IS_LIVE, TEST_ROOM } from './hawkes.ts';
import { cleanAvatar, cleanName, profile, profileId, profileKey } from './profile.ts';
import { eventOk } from './board.ts';
import { SCORE_MAX, isDateKey } from '../campaign/daily.ts';

export const DAILY_KIND = 30078;
/** Players shown on the board (more are counted, and the player's own line is always shown). */
export const BOARD_SHOWN = 10;

/** The same split as the leaderboard's lobbies: live, beta, a playtest's own room. */
const lobby = (): string => (TEST_ROOM ? `test-${TEST_ROOM}` : IS_LIVE ? 'global' : 'beta');

export const dailyTag = (date: string, room = lobby()): string => `${APP_ID}/daily/${room}/${date}`;

export interface DailyEntry {
  id: string;
  name: string;
  avatar: string;
  score: number;
}

export interface DailyBoard {
  date: string;
  /** Best first, ties by who posted first. */
  entries: DailyEntry[];
  /** The player's place (1-based), 0 if not on it. */
  rank: number;
  /** Players on the board. */
  total: number;
}

/** A record's entry, or null when it is not a good score for that date (shape, range, the signature). */
export function parseDaily(e: NostrEvent, date: string, room = lobby()): (DailyEntry & { at: number }) | null {
  if (e.kind !== DAILY_KIND || !eventOk(e)) return null;
  if (!e.tags.some((t) => t[0] === 't' && t[1] === dailyTag(date, room))) return null;
  let c: { v?: number; d?: string; s?: number; n?: unknown; a?: unknown };
  try {
    c = JSON.parse(e.content);
  } catch {
    return null;
  }
  if (c?.v !== 1 || c.d !== date || !Number.isInteger(c.s) || (c.s as number) < 1 || (c.s as number) > SCORE_MAX) return null;
  return { id: e.pubkey, name: cleanName(c.n) || 'Player', avatar: cleanAvatar(c.a), score: c.s as number, at: e.created_at };
}

/** The board from records: one line per player (their best), best first. `me` is shown even if the read missed them. */
export function buildBoard(events: NostrEvent[], date: string, me?: DailyEntry, room = lobby()): DailyBoard {
  const best = new Map<string, DailyEntry & { at: number }>();
  for (const e of events) {
    const p = parseDaily(e, date, room);
    if (!p) continue;
    const old = best.get(p.id);
    if (!old || p.score > old.score) best.set(p.id, p);
  }
  // Our own score is shown at once: the record may not be readable yet.
  if (me) {
    const old = best.get(me.id);
    if (!old || me.score > old.score) best.set(me.id, { ...me, at: seconds() });
  }
  const entries = [...best.values()].sort((a, b) => b.score - a.score || a.at - b.at).map(({ at: _at, ...x }) => x);
  const who = me?.id ?? profileId();
  return { date, entries, rank: entries.findIndex((x) => x.id === who) + 1, total: entries.length };
}

/** Signs and sends today's score (a better one replaces ours). Returns our entry. */
export async function postDaily(date: string, score: number, pool: RecordsPool = sharedRecords()): Promise<DailyEntry> {
  const p = profile();
  const me = selfEntry(score);
  if (!isDateKey(date)) return me;
  const content = JSON.stringify({ v: 1, d: date, s: score, n: p.name, a: p.avatar });
  const tags = [['d', `${APP_ID}/daily/${lobby()}/${date}`], ['t', dailyTag(date)]];
  try {
    pool.publish(await signEvent(profileKey(), DAILY_KIND, tags, content));
  } catch (e) {
    netError('daily: could not send the score (kept for this visit only)', e);
  }
  return me;
}

/** Reads the date's board once. Resolves with just the player's own line when Hawkes Net doesn't answer. */
export async function readDailyBoard(date: string, me?: DailyEntry, pool: RecordsPool = sharedRecords()): Promise<DailyBoard & { ok: boolean }> {
  try {
    const events = await pool.fetchOnce(dailyTag(date), 500);
    return { ...buildBoard(events, date, me), ok: true };
  } catch (e) {
    console.warn(`[dod-online] daily: the board could not be read (${(e as Error)?.message ?? e})`);
    return { ...buildBoard([], date, me), ok: false };
  }
}

/** This player's line for a score (their name and picture). */
export function selfEntry(score: number): DailyEntry {
  const p = profile();
  return { id: profileId(), name: p.name, avatar: p.avatar, score };
}
