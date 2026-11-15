// Invite a friend (docs/online.md, "Invite a friend"): a private Hawkes Net room for two, named by a short code in a
// link (?invite=CODE). The host makes the code and joins it; whoever opens the link joins the same room. The two
// say hello (id, name, picture) over the room's push events (no polling: Hawkes Net tells us who joins and leaves),
// and then pair for the fight through the matchmaker (matchmaker.ts `invite`), the same handshake and match room as
// Find match. A third player gets "full" (Hawkes Net refuses the join); a link whose host is gone gets "closed".

import { join, type Room } from '@hawkesgen/net';
import { Emitter, netError, randomId } from './util.ts';
import { cleanAvatar, cleanName } from './profile.ts';
import { NET_ENDPOINT, NET_PROJECT, TEST_ROOM, roomName } from './hawkes.ts';

/** No host heard this long after joining: the invite has ended. */
const CLOSED_AFTER_MS = 7000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type InviteState = 'joining' | 'waiting' | 'paired' | 'full' | 'closed' | 'offline' | 'ended';

export interface Friend {
  id: string;
  name: string;
  avatar: string;
}

/** A new invite code: 6 letters and numbers with nothing easy to mix up. A private test lobby always uses the same one. */
export function makeInviteCode(): string {
  if (TEST_ROOM) return 'TEST42';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** The code in a page address or link ("" if there is none or it is not one). */
export function inviteCodeFrom(search: string): string {
  const raw = new URLSearchParams(search).get('invite') ?? '';
  return /^[A-Za-z0-9]{4,12}$/.test(raw) ? raw.toUpperCase() : '';
}

/** The link for a code: this game's page with ?invite=CODE (a test lobby's or test network's own query goes with it). */
export function inviteUrl(code: string, base: string = location.href): string {
  const u = new URL(base);
  const keep = new URLSearchParams(u.search);
  u.search = '';
  u.hash = '';
  for (const k of ['room', 'net']) if (keep.has(k)) u.searchParams.set(k, keep.get(k) as string);
  u.searchParams.set('invite', code);
  return u.toString();
}

interface Hello {
  id?: unknown;
  n?: unknown;
  a?: unknown;
  host?: unknown;
}

/**
 * Events: "state" (InviteState), "friend" (Friend: the other player is in the room).
 */
export class Invite extends Emitter {
  readonly code: string;
  readonly host: boolean;
  state: InviteState = 'joining';
  friend: Friend | null = null;
  private net: Room | null = null;
  private closing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly me: { id: string; name: string; avatar: string };
  private readonly quiet: boolean;

  /** `quiet` (a playtest's stand-in for a third browser): takes a seat and says nothing. */
  constructor(code: string, host: boolean, me: { id: string; name: string; avatar: string }, quiet = false) {
    super();
    this.code = code;
    this.host = host;
    this.me = me;
    this.quiet = quiet;
  }

  async start(): Promise<void> {
    let net: Room;
    try {
      net = await join(roomName(`i/${this.code}`), {
        project: NET_PROJECT,
        endpoint: NET_ENDPOINT,
        transport: 'relay',
        name: this.me.name,
        sub: this.me.id,
        config: { maxPlayers: 2, profile: 'light' },
        log: false,
      });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (this.closing) return;
      if (err?.code === 4009 || /full/i.test(err?.message ?? '')) this.set('full');
      else {
        netError(`invite: could not open room ${this.code}`, e);
        this.set('offline');
      }
      return;
    }
    if (this.closing) {
      void net.leave('left');
      return;
    }
    this.net = net;
    this.set(this.host ? 'waiting' : 'joining');
    if (this.quiet) return;
    net.on<Hello>('hi', (d, from) => from && this.onHello(d, from.id));
    net.when('peer:join', (p) => this.hello(p.id));
    net.when('peer:leave', () => {
      // Whoever was here has left: before the match is made, the invite is over (the host's is waiting again).
      if (this.closing || this.state === 'closed') return;
      this.friend = null;
      if (this.host) this.set('waiting');
      else this.set('closed');
    });
    net.when('problem', ({ code, detail }) => {
      if (code === 'full') this.set('full');
      else if (code !== 'reload') netError(`invite: ${code}${detail ? ` (${detail})` : ''}`);
    });
    this.hello();
    if (!this.host) {
      // The host answers at once if the room is theirs; nobody answering means the invite has ended.
      this.timer = setTimeout(() => {
        if (!this.friend && !this.closing) {
          this.set('closed');
          this.close();
        }
      }, CLOSED_AFTER_MS);
    }
  }

  private hello(to?: string): void {
    this.net?.send('hi', { id: this.me.id, n: this.me.name, a: this.me.avatar, host: this.host }, to ? { to } : undefined);
  }

  private onHello(d: Hello, peer: string): void {
    const id = typeof d?.id === 'string' && /^[0-9a-z]{12}$/.test(d.id) ? d.id : '';
    if (!id || id === this.me.id || this.friend) return;
    // A host expects a guest and a guest expects the host; two hosts or two guests are the wrong room.
    if ((d.host === true) === this.host) return;
    clearTimeout(this.timer);
    this.friend = { id, name: cleanName(d.n) || 'Friend', avatar: cleanAvatar(d.a) };
    this.hello(peer);
    this.set('paired');
    this.emit('friend', this.friend);
  }

  private set(s: InviteState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  /** Leaves the room (the match is made, or the player backed out). */
  close(): void {
    this.closing = true;
    clearTimeout(this.timer);
    void this.net?.leave('left');
    this.net = null;
    if (this.state === 'joining' || this.state === 'waiting' || this.state === 'paired') this.set('ended');
  }
}

/** A player id for an invite (the lobby's own is used by the game; this is for a stand-in). */
export const standInId = (): string => randomId(12);
