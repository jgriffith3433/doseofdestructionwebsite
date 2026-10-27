// The one global lobby (docs/online.md, "The lobby"). Every page joins it on load, with no clicks: one shared Hawkes Net
// room on the relay ("lobby" live, "t-lobby" on beta and localhost; hawkes.ts), kept joined by the SDK's lobby (it joins
// again by itself, and moves to "lobby.2" if one ever fills). Each page tells the room who it is: its id, name, picture
// and status (idle, queued with the time its search started, or in a match), at once on a change and to every player
// who joins. A player is in the lobby exactly while they're in the room: no beats, no timeouts. Only presence and the
// queue live here; a match's two players get a room of their own (room.ts).

import { lobby as hawkesLobby, type Lobby as HawkesLobby } from '@hawkesgen/net';
import { Emitter, netError, now, randomId } from './util.ts';
import { cleanAvatar, cleanName } from './profile.ts';
import { IS_LIVE, LIVE_HOSTS, NET_ENDPOINT, NET_PROJECT } from './hawkes.ts';

/** How long the room may take before the lobby says "Offline" (it keeps trying). */
const OFFLINE_AFTER_MS = 10000;

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

/** One id per tab (kept across a reload of that tab), so two tabs are two players. */
function tabId(): string {
  let id = '';
  try {
    id = sessionStorage.getItem('dod.net.id') ?? '';
  } catch {
    // No sessionStorage: a fresh id per load.
  }
  if (!/^[0-9a-z]{12}$/.test(id)) id = randomId(12);
  try {
    sessionStorage.setItem('dod.net.id', id);
  } catch {
    // As above.
  }
  return id;
}

interface Presence {
  id?: unknown;
  n?: unknown;
  a?: unknown;
  s?: unknown;
  q?: unknown;
}

/**
 * Events: "change" (the player list or our status changed), "state" (connecting / online / offline).
 */
export class Lobby extends Emitter {
  readonly lobby: string;
  readonly id: string;
  readonly me: Player;
  state: 'connecting' | 'online' | 'offline' = 'connecting';
  /** Presence messages sent (the playtest's proof the lobby works). */
  beats = 0;
  private readonly others = new Map<string, Player>();
  /** Hawkes Net peer id -> our player id (a peer id is per connection; the player id per tab). */
  private readonly byPeer = new Map<string, string>();
  private net: HawkesLobby | null = null;
  private started = false;
  private startedAt = 0;

  constructor(lobby: string, me: { name: string; avatar: string }) {
    super();
    this.lobby = lobby;
    this.id = tabId();
    this.me = { id: this.id, name: me.name, avatar: me.avatar, status: 'idle', queuedAt: 0, seenAt: now(), self: true };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = now();
    try {
      this.net = hawkesLobby({
        project: NET_PROJECT,
        endpoint: NET_ENDPOINT,
        liveHosts: IS_LIVE ? LIVE_HOSTS : [],
        name: this.me.name,
        sub: this.id,
        transport: 'relay',
        config: { maxPlayers: 1000, profile: 'light' },
        log: false,
      });
    } catch (e) {
      netError('lobby: Hawkes Net could not start; online play is unavailable', e);
      this.setState('offline');
      return;
    }
    const net = this.net;
    net.when('status', ({ status }) => {
      if (status === 'online' || status === 'reconnecting') this.setState('online');
      else if (status === 'connecting' && this.state !== 'online' && now() - this.startedAt < OFFLINE_AFTER_MS) this.setState('connecting');
      else if (status !== 'connecting') this.setState('offline');
    });
    net.when('problem', ({ code, detail }) => {
      if (code !== 'full') netError(`lobby: ${code}${detail ? ` (${detail})` : ''}`);
    });
    net.when('joined', () => {
      this.others.clear();
      this.byPeer.clear();
      this.announce();
      this.emit('change');
    });
    net.when('left', () => {
      this.others.clear();
      this.byPeer.clear();
      this.emit('change');
    });
    // Everyone tells a newcomer who they are; a peer that leaves takes its player with it.
    net.when('peer:join', (p) => this.announce(p.id));
    net.when('peer:leave', ({ peer }) => {
      const id = this.byPeer.get(peer.id);
      this.byPeer.delete(peer.id);
      if (id && this.others.delete(id)) this.emit('change');
    });
    net.on<Presence>('p', (d, from) => from && this.onPresence(d, from.id));
    net.join('lobby');
    // Say "Offline" if the room hasn't answered in 10 s (the SDK keeps trying, and "online" comes back by itself).
    setTimeout(() => {
      if (this.state === 'connecting') {
        this.setState('offline');
        netError(`lobby: Hawkes Net's lobby room did not answer in ${OFFLINE_AFTER_MS / 1000} s (${net.lastProblem || 'no answer'}); online play is unavailable for now`);
      }
    }, OFFLINE_AFTER_MS);
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
    this.announce();
  }

  /** Tells the room (or one newcomer) who we are now. */
  private announce(to?: string): void {
    if (!this.net?.ready) return;
    this.net.send('p', { id: this.id, n: this.me.name, a: this.me.avatar, s: this.me.status, q: this.me.queuedAt }, to ? { to } : undefined);
    this.beats++;
  }

  private onPresence(c: Presence, peer: string): void {
    const id = typeof c.id === 'string' && /^[0-9a-z]{12}$/.test(c.id) ? c.id : '';
    if (!id || id === this.id) return;
    // The same player on a new connection (a reload, a rejoin): the old peer no longer speaks for them.
    for (const [p, pid] of this.byPeer) if (pid === id && p !== peer) this.byPeer.delete(p);
    this.byPeer.set(peer, id);
    const status: Status = c.s === 'queued' || c.s === 'in-match' ? c.s : 'idle';
    this.others.set(id, {
      id,
      name: cleanName(c.n) || 'Player',
      avatar: cleanAvatar(c.a),
      status,
      queuedAt: status === 'queued' && typeof c.q === 'number' && Number.isFinite(c.q) ? c.q : 0,
      seenAt: now(),
    });
    this.emit('change');
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
    this.net?.leave();
  }
}
