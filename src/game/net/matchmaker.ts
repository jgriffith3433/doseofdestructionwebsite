// The online queue (docs/online.md, "Pairing"). Find match puts the player in the lobby's queue; every second the
// pairing rule (pairing.ts) runs on the lobby's view of the queue, and a partner gets a match room (room.ts). The
// pair becomes real only through a handshake on that link:
//   1. both send hello: "I'm in search <q>, and I paired with your search <you>";
//   2. each checks the hello names its own current search and the one it paired with, then sends ok (a promise:
//      from now on it pairs with nobody else until this resolves) or no;
//   3. with both oks the pair is committed: both go "in a match" in the lobby, the host sends the setup.
// A partner that doesn't link within 20 s, declines, or vanishes is skipped for a while and the search goes on.

import { PairRoom } from './room.ts';
import { pairFor, type QueueEntry } from './pairing.ts';
import type { Lobby } from './lobby.ts';
import { cleanAvatar, cleanName } from './profile.ts';
import { Emitter, netError, now } from './util.ts';
import type { Rules } from '../sim/state.ts';
import { STAGES } from '../sim/stage.ts';
import { CHARACTERS } from '../sim/characters.ts';

/** A setup from the other page is checked before it's used: ids in range, sane numbers, names cleaned. */
export function checkSetup(s: OnlineSetup, ids: string[], pids?: string[]): OnlineSetup | null {
  if (!s || typeof s !== 'object') return null;
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (typeof s.matchId !== 'string' || !/^[0-9a-z-]{8,60}$/.test(s.matchId)) return null;
  if (!int(s.seed, -0x80000000, 0x7fffffff) || !int(s.stage, 0, STAGES.length - 1) || !int(s.stocks, 1, 9) || !int(s.timeLimit, 0, 60 * 60 * 20)) return null;
  if (!Array.isArray(s.ids) || s.ids.length !== 2 || s.ids[0] !== ids[0] || s.ids[1] !== ids[1]) return null;
  if (!Array.isArray(s.chars) || s.chars.length !== 2 || !s.chars.every((c) => int(c, 0, CHARACTERS.length - 1))) return null;
  // Profile ids (the leaderboard's): two different keys, ours where we sit; the time both will sign.
  if (!Array.isArray(s.pids) || s.pids.length !== 2 || !s.pids.every((k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))) return null;
  if (pids && (s.pids[0] !== pids[0] || s.pids[1] !== pids[1])) return null;
  if (!int(s.at, 0, 0xffffffff)) return null;
  const rules: Partial<Rules> = {};
  if (s.rules && typeof s.rules === 'object') {
    if (int(s.rules.gravity, 10, 400)) rules.gravity = s.rules.gravity;
    if (int(s.rules.damage, 10, 400)) rules.damage = s.rules.damage;
    if (s.rules.hazards === 0 || s.rules.hazards === 1) rules.hazards = s.rules.hazards;
  }
  const names = [0, 1].map((i) => cleanName(s.names?.[i]) || 'Player');
  const avatars = [0, 1].map((i) => cleanAvatar(s.avatars?.[i]) || CHARACTERS[s.chars[i]].id);
  return { matchId: s.matchId, seed: s.seed, stage: s.stage, stocks: s.stocks, timeLimit: s.timeLimit, rules, ids: s.ids.slice(), names, avatars, chars: s.chars.slice(), pids: s.pids.slice(), at: s.at };
}

const HANDSHAKE_MS = 20000;
const SETUP_MS = 8000;
const SKIP_UNREACHABLE_MS = 90000;
const SKIP_DECLINED_MS = 3000;

export interface OnlineSetup {
  matchId: string;
  seed: number;
  stage: number;
  stocks: number;
  rules: Partial<Rules>;
  /** Frames, 0 for none. */
  timeLimit: number;
  /** By slot: 0 is the host. */
  ids: string[];
  names: string[];
  avatars: string[];
  chars: number[];
  /** Profile ids (public keys) by slot: who the leaderboard credits. */
  pids: string[];
  /** When the host set the match up, unix seconds: the time both players sign into the result. */
  at: number;
}

export interface Opponent {
  id: string;
  name: string;
  avatar: string;
}

export interface Found {
  room: PairRoom;
  slot: number;
  opponent: Opponent;
  setup: OnlineSetup;
}

interface Me {
  name: string;
  avatar: string;
  char: number;
  /** Profile id (public key). */
  pid: string;
}

interface Pending {
  partner: QueueEntry;
  name: string;
  avatar: string;
  char: number;
  pid: string;
  host: boolean;
  room: PairRoom;
  startedAt: number;
  promised: boolean;
  theyOk: boolean;
  committed: boolean;
  committedAt: number;
  done: boolean;
}

export interface MatchmakerOptions {
  me(): Me;
  /** The host's choice of stage, seed and rules for a new match. */
  makeSetup(host: Me & { id: string }, guest: Me & { id: string }): OnlineSetup;
  sameMachine?: boolean;
}

type Msg =
  | { t: 'hello'; q: number; you: number; n: string; a: string; c: number; k: string }
  | { t: 'ok' }
  | { t: 'no' }
  | { t: 'setup'; s: OnlineSetup }
  | { t: 'cancel' };

/**
 * Events: "state" (idle / searching / found), "found" (Found), "notice" (a line for the player), "cancelled"
 * ({ name }: the opponent backed out during the countdown).
 */
export class Matchmaker extends Emitter {
  state: 'idle' | 'searching' | 'found' = 'idle';
  /** When the current search started (the lobby's queue order). */
  queuedAt = 0;
  /** Two links in a row failed: this network may not allow peer-to-peer links. */
  natTrouble = false;
  attempts = 0;
  private linkFailures = 0;
  private readonly skip = new Map<string, number>();
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lobby: Lobby;
  private readonly opts: MatchmakerOptions;

  constructor(lobby: Lobby, opts: MatchmakerOptions) {
    super();
    this.lobby = lobby;
    this.opts = opts;
    lobby.on('change', () => {
      if (this.state === 'searching') this.think();
    });
  }

  /** Find match. `keepPlace` keeps the old search's place in the queue (the opponent backed out). */
  queue(keepPlace = false): void {
    if (this.state !== 'idle') return;
    this.queuedAt = keepPlace && this.queuedAt ? this.queuedAt : now();
    this.setState('searching');
    this.lobby.update({ status: 'queued', queuedAt: this.queuedAt });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.think(), 1000);
    this.think();
  }

  /** Cancel: leaves the queue; during the countdown it tells the opponent. */
  cancel(): void {
    if (this.state === 'idle') return;
    const p = this.pending;
    if (p) {
      this.send(p, p.committed ? { t: 'cancel' } : { t: 'no' });
      this.drop(p);
    }
    this.stop();
  }

  /** The online match is over (or never started): back to idle in the lobby. */
  matchOver(): void {
    this.pending = null;
    this.stop();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.queuedAt = this.state === 'found' ? 0 : this.queuedAt;
    this.lobby.update({ status: 'idle' });
    this.setState('idle');
  }

  private setState(s: Matchmaker['state']): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private think(): void {
    if (this.state !== 'searching') return;
    const t = now();
    for (const [id, until] of this.skip) if (until <= t) this.skip.delete(id);
    const queue = this.lobby.queue().map((p) => ({ id: p.id, queuedAt: p.queuedAt }));
    const pairing = pairFor(queue, this.lobby.id, new Set(this.skip.keys()));
    const p = this.pending;
    if (p) {
      if (p.committed) {
        if (!p.host && t - p.committedAt > SETUP_MS) this.fail(p, 'no setup from the host', SKIP_DECLINED_MS);
        return;
      }
      if (t - p.startedAt > HANDSHAKE_MS) {
        this.fail(p, p.room.everOpened ? 'the handshake timed out' : 'could not link in 20 s', p.room.everOpened ? SKIP_DECLINED_MS : SKIP_UNREACHABLE_MS, !p.room.everOpened);
        return;
      }
      // Not promised yet and the queue now pairs us differently: follow the queue.
      if (!p.promised && pairing?.partner.id !== p.partner.id) this.abandon(p);
      else return;
    }
    if (pairing) this.begin(pairing.partner, pairing.host);
  }

  private begin(partner: QueueEntry, host: boolean): void {
    const other = this.lobby.get(partner.id);
    const hostId = host ? this.lobby.id : partner.id;
    const guestId = host ? partner.id : this.lobby.id;
    const hostQ = host ? this.queuedAt : partner.queuedAt;
    const guestQ = host ? partner.queuedAt : this.queuedAt;
    const name = `${this.lobby.lobby}/m/${hostId}-${guestId}-${hostQ}-${guestQ}`;
    const room = new PairRoom(name, this.lobby.id, partner.id, { sameMachine: this.opts.sameMachine });
    const p: Pending = {
      partner,
      name: other?.name ?? 'Player',
      avatar: other?.avatar ?? '',
      char: -1,
      pid: '',
      host,
      room,
      startedAt: now(),
      promised: false,
      theyOk: false,
      committed: false,
      committedAt: 0,
      done: false,
    };
    this.pending = p;
    this.attempts++;
    console.info(`[dod-online] pairing with ${p.name} (${partner.id}) as ${host ? 'host' : 'guest'}`);
    room.on('open', () => {
      if (this.pending !== p) return;
      this.linkFailures = 0;
      this.natTrouble = false;
      const me = this.opts.me();
      this.send(p, { t: 'hello', q: this.queuedAt, you: partner.queuedAt, n: me.name, a: me.avatar, c: me.char, k: me.pid });
    });
    room.on('message', (m: { kind: string; data: string }) => {
      if (this.pending !== p || m.kind !== 'mm') return;
      let msg: Msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      this.onMessage(p, msg);
    });
    room.on('failed', (e: { reason: string }) => {
      if (this.pending === p && !p.done) this.fail(p, `no link (${e.reason})`, SKIP_UNREACHABLE_MS, true);
    });
    room.on('closed', (e: { reason: string }) => {
      if (this.pending === p && !p.done) this.fail(p, `they left (${e.reason})`, SKIP_DECLINED_MS);
    });
    void room.start();
  }

  private onMessage(p: Pending, msg: Msg): void {
    if (msg.t === 'hello') {
      const fits = this.state === 'searching' && msg.you === this.queuedAt && msg.q === p.partner.queuedAt;
      p.name = cleanName(msg.n) || p.name;
      p.avatar = cleanAvatar(msg.a) || p.avatar;
      p.char = Number.isInteger(msg.c) ? msg.c : -1;
      p.pid = typeof msg.k === 'string' && /^[0-9a-f]{64}$/.test(msg.k) ? msg.k : '';
      if (!fits || !p.pid) {
        this.send(p, { t: 'no' });
        return;
      }
      p.promised = true;
      this.send(p, { t: 'ok' });
      if (p.theyOk) this.commit(p);
    } else if (msg.t === 'ok') {
      p.theyOk = true;
      if (p.promised) this.commit(p);
    } else if (msg.t === 'no') {
      if (!p.committed) this.fail(p, 'they paired with someone else', SKIP_DECLINED_MS);
    } else if (msg.t === 'setup') {
      if (!p.committed || p.host || p.done) return;
      const setup = checkSetup(msg.s, [p.partner.id, this.lobby.id], [p.pid, this.opts.me().pid]);
      if (!setup) {
        netError(`queue: ${p.name} sent a setup this game can't use`, JSON.stringify(msg.s).slice(0, 300));
        this.send(p, { t: 'cancel' });
        this.fail(p, 'a bad setup', SKIP_UNREACHABLE_MS);
        return;
      }
      this.found(p, setup);
    } else if (msg.t === 'cancel') {
      if (!p.committed) return;
      this.drop(p);
      this.pending = null;
      this.emit('cancelled', { name: p.name });
      // Back in the queue in the same place: they backed out, not us.
      this.state = 'idle';
      this.queue(true);
    }
  }

  private commit(p: Pending): void {
    if (p.committed) return;
    p.committed = true;
    p.committedAt = now();
    this.lobby.update({ status: 'in-match' });
    if (!p.host) return;
    const me = this.opts.me();
    const char = p.char >= 0 ? p.char : me.char;
    const setup = this.opts.makeSetup({ ...me, id: this.lobby.id }, { name: p.name, avatar: p.avatar, char, pid: p.pid, id: p.partner.id });
    this.send(p, { t: 'setup', s: setup });
    this.found(p, setup);
  }

  private found(p: Pending, setup: OnlineSetup): void {
    p.done = true;
    clearInterval(this.timer);
    this.setState('found');
    const slot = p.host ? 0 : 1;
    this.emit('found', { room: p.room, slot, opponent: { id: p.partner.id, name: p.name, avatar: p.avatar }, setup } satisfies Found);
  }

  private send(p: Pending, msg: Msg): void {
    if (!p.room.send('mm', JSON.stringify(msg), true) && msg.t !== 'no') netError(`queue: could not send ${msg.t} to ${p.name}`);
  }

  private abandon(p: Pending): void {
    this.send(p, { t: 'no' });
    this.drop(p);
    this.pending = null;
  }

  private drop(p: Pending): void {
    p.done = true;
    p.room.close('cancelled');
  }

  private fail(p: Pending, why: string, skipMs: number, unreachable = false): void {
    if (p.done) return;
    this.drop(p);
    if (this.pending === p) this.pending = null;
    this.skip.set(p.partner.id, now() + skipMs);
    if (p.committed) this.lobby.update({ status: 'queued', queuedAt: this.queuedAt });
    if (unreachable) {
      this.linkFailures++;
      if (this.linkFailures >= 2) this.natTrouble = true;
      netError(`queue: couldn't link with ${p.name}: ${why}`);
      this.emit('notice', `Couldn't connect to ${p.name}. Still searching…`);
    } else {
      console.warn(`[dod-online] queue: pairing with ${p.name} fell through: ${why}`);
    }
  }
}
