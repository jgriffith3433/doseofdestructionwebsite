// The leaderboard's data (docs/online.md, "The leaderboard"): signed match results on the same public Nostr relays
// the lobby uses, a cache in localStorage so the table shows at once (and offline), and a background refresh. The
// rules (what counts, the Elo) are in ratings.ts; this file only moves and keeps results.
//
// A result is a NIP-78 app-data event (kind 30078, one per match and publisher: d = hawkes-dod/result/<match id>),
// tagged hawkes-dod/results/<lobby> (test lobbies have their own table), signed by the publisher's profile key.
// Content: { v: 1, r: <ResultRecord>, me: { n, a } (the publisher's name and picture), o: { n, a } (the opponent's,
// as the publisher saw them: used only until that player publishes their own) }.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sharedPool, signEvent, type NostrEvent, type NostrPool } from './nostr.ts';
import { APP_ID, Emitter, fromHex, netError, seconds, toHex } from './util.ts';
import { cleanAvatar, cleanName, profile, profileId, profileKey } from './profile.ts';
import { checkRecord, computeBoard, parseRecord, settle, weekStart, type Board, type Checked, type ResultRecord } from './ratings.ts';

export const RESULT_KIND = 30078;
/** Results kept in the cache (newest first by match time). */
const CACHE_MAX = 3000;
/** Results checked per slice while the page runs: never a long task. */
const SLICE = 12;
/** A result stamped further ahead than this (a clock far off) waits until its time comes. */
const FUTURE_S = 3600;

export type Tab = 'week' | 'all';

interface Name {
  n: string;
  a: string;
  /** created_at of the event it came from. */
  at: number;
  /** From the player themselves (a verified event), not an opponent's hint. */
  own: boolean;
}

interface Cache {
  v: 1;
  records: { r: ResultRecord; k: 'full' | 'claim' }[];
  names: Record<string, Name>;
  /** The newest event seen (created_at): the next refresh asks from a little before it. */
  since: number;
  /** Our own results not yet sent to any relay. */
  outbox: ResultRecord[];
}

const encoder = new TextEncoder();

/** A relay event is what it says: its id is the hash of its body and the signature is the pubkey's. */
function eventOk(e: NostrEvent): boolean {
  try {
    const id = toHex(sha256(encoder.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    return id === e.id && schnorr.verify(fromHex(e.sig), fromHex(e.id), fromHex(e.pubkey));
  } catch {
    return false;
  }
}

/**
 * Events: "change" (the table or names changed), "state" (the refresh state).
 */
export class Leaderboard extends Emitter {
  readonly tag: string;
  private readonly storeKey: string;
  private readonly pool: NostrPool;
  /** Every result whose signatures checked out, by match id + winner + signatures. */
  private readonly results = new Map<string, Checked>();
  private readonly names = new Map<string, Name>();
  private outbox: ResultRecord[] = [];
  /** Our own result for a match nobody else counts yet (we left, or they never signed): only for our own screens. */
  private readonly provisional = new Map<string, ResultRecord>();
  private since = 0;
  private queue: NostrEvent[] = [];
  private draining = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private memo: { key: string; boards: Partial<Record<Tab | 'prov', Board>> } = { key: '', boards: {} };
  private version = 0;
  private started = false;
  state: 'cached' | 'loading' | 'live' | 'offline' = 'cached';
  /** When the relays last answered (ms), 0 never. */
  updatedAt = 0;
  /** Players whose own result events came back from the relays this visit: the playtest's proof of the round trip. */
  readonly heardFrom = new Set<string>();

  constructor(lobby: string, pool?: NostrPool) {
    super();
    this.tag = `${APP_ID}/results/${lobby}`;
    this.storeKey = `dod.board.${lobby}`;
    this.pool = pool ?? sharedPool();
    this.load();
  }

  /** Subscribes to the relays (once). The cached table is there before this and stays if the relays never answer. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setState('loading');
    const since = this.since ? this.since - 86400 : undefined;
    this.pool.subscribe(
      [{ kinds: [RESULT_KIND], '#t': [this.tag], limit: CACHE_MAX, ...(since ? { since } : {}) }],
      (event) => this.receive(event),
      () => {
        this.updatedAt = Date.now();
        this.setState('live');
        this.flushOutbox();
      },
    );
    void this.pool.ready(10000).then((ok) => {
      if (!ok && this.state === 'loading') this.setState('offline');
      if (ok) this.flushOutbox();
    });
    // Relays that come back later get the outbox too.
    setInterval(() => {
      if (this.outbox.length && this.pool.openUrls().length) this.flushOutbox();
      if (!this.pool.openUrls().length && this.state === 'live') this.setState('offline');
    }, 15000);
  }

  private setState(s: Leaderboard['state']): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
    this.emit('change');
  }

  // ------------------------------------------------------------------ cache

  private load(): void {
    let c: Partial<Cache> = {};
    try {
      c = JSON.parse(localStorage.getItem(this.storeKey) ?? '{}') ?? {};
    } catch {
      return;
    }
    // Our own cache is trusted (it holds only results that checked out); shapes are still checked.
    for (const item of Array.isArray(c.records) ? c.records : []) {
      const r = parseRecord(item?.r);
      if (r && (item.k === 'full' || item.k === 'claim')) this.results.set(keyOf(r), { record: r, kind: item.k });
    }
    for (const [id, n] of Object.entries(c.names ?? {})) {
      const name = cleanName(n?.n);
      if (/^[0-9a-f]{64}$/.test(id) && name) this.names.set(id, { n: name, a: cleanAvatar(n.a), at: Number(n.at) || 0, own: !!n.own });
    }
    this.outbox = (Array.isArray(c.outbox) ? c.outbox : []).map(parseRecord).filter((r): r is ResultRecord => !!r);
    this.since = Number(c.since) || 0;
    this.version++;
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    if (typeof localStorage === 'undefined') return;
    this.saveTimer = setTimeout(() => {
      const records = [...this.results.values()].sort((a, b) => b.record.t - a.record.t).slice(0, CACHE_MAX);
      const keep = new Set(records.flatMap((c) => c.record.p));
      const names: Record<string, Name> = {};
      for (const [id, n] of this.names) if (keep.has(id)) names[id] = n;
      const cache: Cache = { v: 1, records: records.map((c) => ({ r: c.record, k: c.kind })), names, since: this.since, outbox: this.outbox };
      try {
        localStorage.setItem(this.storeKey, JSON.stringify(cache));
      } catch (e) {
        netError('leaderboard: could not save the cache (storage full or blocked); the table still works this visit', e);
      }
    }, 800);
  }

  // ---------------------------------------------------------------- results

  private receive(event: NostrEvent): void {
    this.queue.push(event);
    if (!this.draining) {
      this.draining = true;
      setTimeout(() => this.drain(), 0);
    }
  }

  /** Checks queued events a few at a time, so a big first load never blocks the game. */
  private drain(): void {
    const batch = this.queue.splice(0, SLICE);
    let changed = false;
    for (const event of batch) changed = this.take(event) || changed;
    if (changed) {
      this.version++;
      this.save();
      this.emit('change');
    }
    if (this.queue.length) setTimeout(() => this.drain(), 0);
    else this.draining = false;
  }

  private take(event: NostrEvent): boolean {
    let c: { r?: unknown; me?: { n?: unknown; a?: unknown }; o?: { n?: unknown; a?: unknown } };
    try {
      c = JSON.parse(event.content);
    } catch {
      return false;
    }
    const r = parseRecord(c?.r);
    if (!r) return false;
    this.since = Math.max(this.since, Math.min(event.created_at, seconds()));
    const key = keyOf(r);
    let changed = false;
    if (!this.results.has(key)) {
      const kind = checkRecord(r);
      if (!kind) {
        console.warn(`[dod-online] leaderboard: ignored result ${r.m} (signatures don't check out)`);
        return false;
      }
      this.results.set(key, { record: r, kind });
      this.provisional.delete(r.m);
      changed = true;
    }
    // Names: the publisher's own (only from an event that checks out and only for a player in the result), else the
    // opponent's hint until that player is heard from.
    const self = r.p.indexOf(event.pubkey);
    if (self >= 0 && eventOk(event)) {
      this.heardFrom.add(event.pubkey);
      changed = this.name(event.pubkey, c.me, event.created_at, true) || changed;
      changed = this.name(r.p[1 - self], c.o, event.created_at, false) || changed;
    }
    return changed;
  }

  private name(id: string, raw: { n?: unknown; a?: unknown } | undefined, at: number, own: boolean): boolean {
    const n = cleanName(raw?.n);
    if (!n) return false;
    const old = this.names.get(id);
    if (old && (old.own && !own || (old.own === own && old.at >= at))) return false;
    this.names.set(id, { n, a: cleanAvatar(raw?.a), at, own });
    return true;
  }

  /**
   * Our own finished match: counted at once (so the result screen shows the change), cached, and published for
   * everyone. A result only we signed is kept for our own screens until the other side's arrives.
   */
  addOwn(record: ResultRecord, opponent: { n: string; a: string }): void {
    const kind = checkRecord(record);
    const me = profileId();
    const other = record.p.find((p) => p !== me);
    if (other) this.name(other, opponent, seconds() - 3600 * 24 * 365, false);
    if (!kind) {
      this.provisional.set(record.m, record);
      this.version++;
      this.emit('change');
      return;
    }
    this.results.set(keyOf(record), { record, kind });
    this.provisional.delete(record.m);
    this.outbox.push(record);
    this.version++;
    this.save();
    this.emit('change');
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (!this.outbox.length || !this.pool.openUrls().length) return;
    const list = this.outbox.splice(0);
    const p = profile();
    for (const r of list) {
      const other = r.p.find((x) => x !== profileId());
      const o = other ? this.names.get(other) : undefined;
      const content = JSON.stringify({ v: 1, r, me: { n: p.name, a: p.avatar }, o: o ? { n: o.n, a: o.a } : undefined });
      const tags = [['d', `${APP_ID}/result/${r.m}`], ['t', this.tag]];
      signEvent(profileKey(), RESULT_KIND, tags, content)
        .then((event) => {
          if (!this.pool.publish(event)) {
            this.outbox.push(r);
            this.save();
          }
        })
        .catch((e) => {
          netError(`leaderboard: publishing result ${r.m} failed (kept, tried again later)`, e);
          this.outbox.push(r);
          this.save();
        });
    }
    this.save();
  }

  // ------------------------------------------------------------------ table

  /** The table for a tab: every client with the same results shows the same one. */
  board(tab: Tab): Board {
    return this.boards()[tab]!;
  }

  /** The all-time table with our own unconfirmed results in it: our expected change while the other side's is missing. */
  private provisionalBoard(): Board {
    return this.boards().prov!;
  }

  private boards(): Partial<Record<Tab | 'prov', Board>> {
    const now = seconds();
    const week = weekStart(now);
    const key = `${this.version}|${week}|${Math.floor(now / 600)}`;
    if (this.memo.key === key) return this.memo.boards;
    const settled = settle([...this.results.values()]);
    const until = now + FUTURE_S;
    const counted = new Set(settled.map((r) => r.m));
    const prov = [...this.provisional.values()].filter((r) => !counted.has(r.m));
    this.memo = {
      key,
      boards: {
        all: computeBoard(settled, { until }),
        week: computeBoard(settled, { since: week, until }),
        prov: prov.length ? computeBoard([...settled, ...prov], { until }) : undefined,
      },
    };
    if (!this.memo.boards.prov) this.memo.boards.prov = this.memo.boards.all;
    return this.memo.boards;
  }

  /** A player's name and picture: ours from the profile, others' from their own results (or an opponent's hint). */
  who(id: string): { name: string; avatar: string } {
    if (id === profileId()) return { name: profile().name, avatar: profile().avatar };
    const n = this.names.get(id);
    return { name: n?.n ?? 'Player', avatar: n?.a ?? '' };
  }

  /** What a finished match did to our rating: confirmed when it counts for everyone, else expected. */
  change(matchId: string): { delta: number; rating: number; theirs: number; theirRating: number; confirmed: boolean; overLimit: boolean } | null {
    const me = profileId();
    for (const [board, confirmed] of [[this.board('all'), true], [this.provisionalBoard(), false]] as const) {
      const d = board.deltas.get(matchId);
      const record = [...this.results.values()].find((c) => c.record.m === matchId)?.record ?? this.provisional.get(matchId);
      if (board.overLimit.has(matchId)) return { delta: 0, rating: board.players.get(me)?.rating ?? 0, theirs: 0, theirRating: 0, confirmed, overLimit: true };
      if (!d || !record) continue;
      const slot = record.p.indexOf(me);
      if (slot < 0) return null;
      const them = record.p[1 - slot];
      return { delta: d[slot], rating: board.players.get(me)?.rating ?? 0, theirs: d[1 - slot], theirRating: board.players.get(them)?.rating ?? 0, confirmed, overLimit: false };
    }
    return null;
  }

  /** A player's line in a tab's table, or null when they have no counted match there. */
  stats(tab: Tab, id = profileId()) {
    return this.board(tab).table.find((p) => p.id === id) ?? null;
  }
}

function keyOf(r: ResultRecord): string {
  return `${r.m}|${r.w}|${r.r}|${r.sig.join('.')}`;
}

let shared: Leaderboard | null = null;

/** The page's leaderboard (made on first use; refreshes once started). */
export function leaderboard(lobby: string): Leaderboard {
  if (!shared) shared = new Leaderboard(lobby);
  return shared;
}

export function sharedBoard(): Leaderboard | null {
  return shared;
}
