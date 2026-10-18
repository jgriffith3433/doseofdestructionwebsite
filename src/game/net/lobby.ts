// The one global lobby (docs/online.md, "The lobby"). Every page joins it on load, with no clicks: it publishes a
// presence beat on the public Nostr relays (a NIP-78 app-data event, replaceable per key, with a NIP-40 expiration)
// and listens for everyone else's. A beat carries the player's id, name, picture and status (idle, queued with the
// time the search started, or in a match). There is no server and no WebRTC here: the lobby is just these beats, so
// it holds any number of players. WebRTC only links the two players of a match (room.ts).
//
// Beats go out every 20 s (8 s while queued) and at once on a change; a player is in the lobby while their last beat
// is under 60 s old (queued: under 25 s, so a closed tab stops being paired soon). Leaving publishes a "left" beat.

import { makeKey, sharedPool, signEvent, type NostrEvent, type NostrKey, type NostrPool } from './nostr.ts';
import { APP_ID, Emitter, netError, now, randomId, seconds } from './util.ts';
import { cleanAvatar, cleanName } from './profile.ts';

export const PRESENCE_KIND = 30078;
const BEAT_MS = 20000;
const QUEUED_BEAT_MS = 8000;
const ALIVE_MS = 60000;
const QUEUED_ALIVE_MS = 25000;
const MIN_GAP_MS = 1200;

export type Status = 'idle' | 'queued' | 'in-match';

export interface Player {
  id: string;
  name: string;
  avatar: string;
  status: Status;
  /** When the current search started (the queue order); 0 when not queued. */
  queuedAt: number;
  /** When we last heard from them (local ms). */
  seenAt: number;
  self?: boolean;
}

/** One id and signing key per tab (kept across a reload of that tab), so two tabs are two players. */
function tabIdentity(): { id: string; key: NostrKey } {
  let id = '';
  let secret = '';
  try {
    id = sessionStorage.getItem('dod.net.id') ?? '';
    secret = sessionStorage.getItem('dod.net.key') ?? '';
  } catch {
    // No sessionStorage: a fresh identity per load.
  }
  if (!/^[0-9a-z]{12}$/.test(id)) id = randomId(12);
  const key = makeKey(/^[0-9a-f]{64}$/.test(secret) ? secret : undefined);
  try {
    sessionStorage.setItem('dod.net.id', id);
    sessionStorage.setItem('dod.net.key', key.secretHex);
  } catch {
    // As above.
  }
  return { id, key };
}

/**
 * Events: "change" (the player list or our status changed), "state" (connecting / online / offline).
 */
export class Lobby extends Emitter {
  readonly lobby: string;
  readonly id: string;
  private readonly key: NostrKey;
  private readonly pool: NostrPool;
  private readonly tag: string;
  readonly me: Player;
  private readonly others = new Map<string, Player>();
  private readonly made = new Map<string, number>();
  private live = false;
  state: 'connecting' | 'online' | 'offline' = 'connecting';
  private lastCreated = 0;
  private lastBeat = 0;
  private beatTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  beats = 0;

  constructor(lobby: string, me: { name: string; avatar: string }, pool?: NostrPool) {
    super();
    this.lobby = lobby;
    const ident = tabIdentity();
    this.id = ident.id;
    this.key = ident.key;
    this.pool = pool ?? sharedPool();
    this.tag = `${APP_ID}/lobby/${lobby}`;
    this.me = { id: this.id, name: me.name, avatar: me.avatar, status: 'idle', queuedAt: 0, seenAt: now(), self: true };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pool.subscribe([{ kinds: [PRESENCE_KIND], '#t': [this.tag], since: seconds() - Math.ceil(ALIVE_MS / 1000) }], (event) => this.onBeat(event), () => (this.live = true));
    void this.pool.ready(10000).then((ok) => {
      this.setState(ok ? 'online' : 'offline');
      if (!ok) netError(`lobby: no Nostr relay opened in 10 s (${this.pool.urls.length} tried); online play is unavailable on this network`);
      this.beat();
    });
    // Keep the state honest if relays drop or come back later.
    setInterval(() => {
      const open = this.pool.openUrls().length > 0;
      if (open && this.state !== 'online') {
        this.setState('online');
        this.beat();
      } else if (!open && this.state === 'online') this.setState('offline');
      this.expire();
    }, 2000);
    if (typeof addEventListener === 'function') addEventListener('pagehide', () => this.leave());
  }

  private setState(s: Lobby['state']): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
    this.emit('change');
  }

  /** Changes what the lobby sees of us (name, picture, status) and tells everyone at once. */
  update(change: Partial<Pick<Player, 'name' | 'avatar' | 'status' | 'queuedAt'>>): void {
    Object.assign(this.me, change);
    if (this.me.status !== 'queued') this.me.queuedAt = 0;
    this.emit('change');
    this.beat();
  }

  private schedule(ms: number): void {
    clearTimeout(this.beatTimer);
    this.beatTimer = setTimeout(() => this.beat(), ms);
  }

  /** Publishes our beat now (or as soon as the minimum gap allows) and schedules the next. */
  beat(left = false): void {
    const wait = this.lastBeat + MIN_GAP_MS - now();
    if (wait > 0 && !left) {
      this.schedule(wait);
      return;
    }
    this.schedule(this.me.status === 'queued' ? QUEUED_BEAT_MS : BEAT_MS);
    if (this.state === 'connecting' && !left) return;
    this.lastBeat = now();
    // Each beat is at least a second newer than the last, so a relay keeps the latest one (replaceable per key).
    const created = Math.max(seconds(), this.lastCreated + 1);
    this.lastCreated = created;
    const content = JSON.stringify({ id: this.id, n: this.me.name, a: this.me.avatar, s: left ? 'left' : this.me.status, q: this.me.queuedAt, v: 1 });
    const tags = [['d', `${APP_ID}/lobby`], ['t', this.tag], ['expiration', String(created + Math.ceil(ALIVE_MS / 1000) + 30)]];
    signEvent(this.key, PRESENCE_KIND, tags, content, created)
      .then((event) => {
        if (this.pool.publish(event)) this.beats++;
      })
      .catch((e) => netError('lobby: signing a presence beat failed', e));
  }

  private onBeat(event: NostrEvent): void {
    let c: { id?: unknown; n?: unknown; a?: unknown; s?: unknown; q?: unknown };
    try {
      c = JSON.parse(event.content);
    } catch {
      return;
    }
    const id = typeof c.id === 'string' && /^[0-9a-z]{12}$/.test(c.id) ? c.id : '';
    if (!id || id === this.id) return;
    // Stored beats (before the relays' end of stored events) count from when they were made; live ones from now, so
    // a player whose clock is off still shows.
    const made = event.created_at;
    const seenAt = this.live ? now() : Math.min(now(), made * 1000 + 5000);
    if (now() - seenAt > ALIVE_MS) return;
    if (made < (this.made.get(id) ?? 0)) return;
    this.made.set(id, made);
    const old = this.others.get(id);
    if (c.s === 'left') {
      if (this.others.delete(id)) this.emit('change');
      return;
    }
    const status: Status = c.s === 'queued' || c.s === 'in-match' ? c.s : 'idle';
    const p: Player = {
      id,
      name: cleanName(c.n) || 'Player',
      avatar: cleanAvatar(c.a),
      status,
      queuedAt: status === 'queued' && typeof c.q === 'number' && Number.isFinite(c.q) ? c.q : 0,
      seenAt: Math.max(seenAt, old?.seenAt ?? 0),
    };
    this.others.set(id, p);
    this.emit('change');
  }

  private expire(): void {
    const t = now();
    let changed = false;
    for (const [id, p] of this.others) {
      if (t - p.seenAt > ALIVE_MS) {
        this.others.delete(id);
        changed = true;
      } else if (p.status === 'queued' && t - p.seenAt > QUEUED_ALIVE_MS) {
        // A queued player who stopped beating has probably closed the tab: not pairable any more.
        p.status = 'idle';
        p.queuedAt = 0;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  /** Everyone in the lobby, us first. */
  players(): Player[] {
    return [this.me, ...[...this.others.values()].sort((a, b) => b.seenAt - a.seenAt)];
  }

  get(id: string): Player | undefined {
    return id === this.id ? this.me : this.others.get(id);
  }

  /** How many are online, us included (0 when the lobby can't be reached). */
  count(): number {
    return this.state === 'online' ? 1 + this.others.size : 0;
  }

  /** Everyone searching, us included when we are. */
  queue(): Player[] {
    return this.players().filter((p) => p.status === 'queued' && p.queuedAt > 0);
  }

  leave(): void {
    if (this.beats > 0) this.beat(true);
  }
}
