// A match room: the two paired players, in a Hawkes Net room of their own (docs/online.md, "The fight"). Both join the
// same name ("m/<a hash of the pairing>", a pair room: two players at most) and the room starts peer to peer, a direct
// WebRTC link between the two browsers, the shortest path there is; when they can't link (strict networks) Hawkes Net
// moves it to its relay on the same connections, so two players who could never meet before still can.
//
// Over it: the game's messages (reliable, once and in order: the handshake, the start, hashes, results), and express
// frames (Hawkes Net's: sent at once, forwarded at once, never queued, between the browsers on an unordered channel)
// for what can't wait: the fight's inputs (sendInputs) and a ping every second, so the round trip is the inputs' own.
import { join, type Room } from '@hawkesgen/net';
import { Emitter, netError, now, sha256Hex } from './util.ts';
import { NET_ENDPOINT, NET_PROJECT, roomName } from './hawkes.ts';

const PING_MS = 1000;
const SILENT_MS = 6000;
/** A tick this much later than due means our own page was frozen (loading a stage): we heard nothing because we couldn't. */
const FROZEN_MS = 2500;
/** How long a dropped player has to come back (a new connection, the same player id) before the match is over. */
export const REJOIN_MS = 10000;
/** The same player dropping this many times in one match forfeits it (a rated quit). */
export const MAX_DROPS = 3;
// Express payloads: the first byte says what it is.
const X_PING = 1;
const X_PONG = 2;
const X_MSG = 3;
const X_INPUTS = 4;

export interface RoomOptions {
  /** (Kept for callers: Hawkes Net links two tabs of one browser by itself.) */
  sameMachine?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Events: "open" (the other player is here), "message" ({ kind, data, reliable }), "inputs" (Uint8Array: the other
 * side's input packet), "closed" ({ reason }) once the room is lost for good, "failed" ({ reason }) when it never opened.
 */
export class PairRoom extends Emitter {
  readonly room: string;
  readonly id: string;
  readonly remote: string;
  net: Room | null = null;
  rtt = -1;
  rttAvg = -1;
  /** How the inputs travel: "direct" (a link between the two browsers), "relay" (Hawkes Net's), "signal" (via the node, before a link opens). */
  route = '';
  closed = false;
  everOpened = false;
  lastHeard = 0;
  /** How long without a word from the other page ends the room. The fight lengthens it while both pages load (a page
   *  compiling a stage blocks its main thread for seconds and answers nothing). */
  silentMs = SILENT_MS;
  private lastTickAt = 0;
  readonly sent = { r: 0, u: 0 };
  readonly recv = { r: 0, u: 0 };
  /** The other player's peer id in the room (known from their hello). */
  private peer = '';
  private ticker: ReturnType<typeof setInterval> | undefined;
  private pingN = 0;
  /** The open rejoin window, or null: who is away ("them" or "self"), why, when it ends (now() ms) and since when. */
  away: { who: 'them' | 'self'; cause: string; since: number; until: number } | null = null;
  /** How many times each player has dropped in this match. */
  readonly drops = { them: 0, self: 0 };
  private awayTimer: ReturnType<typeof setTimeout> | undefined;
  private watchingPage = false;

  constructor(room: string, id: string, remote: string, _options: RoomOptions = {}) {
    super();
    this.room = room;
    this.id = id;
    this.remote = remote;
  }

  async start(): Promise<void> {
    if (!(await this.connect())) return;
    this.ticker = setInterval(() => this.tick(), PING_MS);
    this.watchPage();
  }

  /** Joins the match room and wires it. Again after a cut (cutFor): the same id, a new connection. */
  private async connect(): Promise<boolean> {
    let net: Room;
    try {
      const name = roomName(`m/${(await sha256Hex(`dod|match|${this.room}`)).slice(0, 24)}`);
      net = await join(name, {
        project: NET_PROJECT,
        endpoint: NET_ENDPOINT,
        // Peer to peer first (the lowest latency a fight can have), the relay when the two can't link.
        transport: 'auto',
        name: this.id,
        sub: this.id,
        config: { topology: 'pair', maxPlayers: 2, p2pMax: 2, profile: 'light' },
        log: false,
      });
    } catch (e) {
      if (this.away) return false; // (a rejoin that failed: the window runs out by itself)
      this.fail(`no room (${(e as Error)?.message ?? e})`);
      return false;
    }
    if (this.closed) {
      void net.leave('left');
      return false;
    }
    this.net = net;
    net.on<{ id?: string }>('~hi', (d, from) => {
      if (!from || d?.id !== this.remote) return;
      const first = !this.peer || this.peer !== from.id;
      this.peer = from.id;
      this.heard();
      if (first) net.send('~hi', { id: this.id }, { to: from.id }); // (they may have joined after our first hello)
      this.opened();
    });
    net.on<{ k?: string; d?: string }>('g', (m, from) => {
      if (!from || from.id !== this.peer) return;
      this.heard();
      if (typeof m?.k !== 'string') return;
      if (m.k === '~bye') return this.close('left', false);
      if (m.k === '~away') return this.dropped('them', 'away'); // (their app went to the background)
      if (m.k === '~back') return;
      this.recv.r++;
      this.emit('message', { kind: m.k, data: typeof m.d === 'string' ? m.d : '', reliable: true });
    });
    net.onExpress((bytes, from) => {
      if (from !== this.peer || !bytes.length) return;
      this.lastHeard = now();
      this.onExpress(bytes);
      if (this.away?.who === 'them' && this.away.cause !== 'away') this.back();
    });
    // Whoever joins (the other player, or them again on a new connection) hears who we are.
    net.when('peer:join', (p) => net.send('~hi', { id: this.id }, { to: p.id }));
    // A peer leaving is a drop, not a goodbye (that is "~bye"): the same player id may come back on a new connection.
    net.when('peer:leave', ({ peer }) => {
      if (peer.id !== this.peer || net !== this.net) return;
      this.peer = '';
      this.dropped('them', 'leave');
    });
    net.when('status', ({ status }) => {
      if (net !== this.net || this.closed) return;
      if (status === 'reconnecting' && this.everOpened) return this.dropped('self', 'reconnecting');
      if (status === 'online' && this.away?.who === 'self' && this.away.cause === 'reconnecting') {
        net.send('~hi', { id: this.id }); // (they hear us again; their "~hi" back is what ends our window)
        if (this.peer) this.back();
        return;
      }
      if (status !== 'closed') return;
      if (this.away) return; // (a cut we made ourselves, or a drop whose window decides)
      if (this.everOpened) this.close('lost', false);
      else this.fail('no link');
    });
    net.when('transport', (e) => console.info(`[dod-online] match room moved: ${e.from} to the ${e.to} (${e.why})`));
    net.send('~hi', { id: this.id });
    return true;
  }

  /** Something from the other player arrived: if they were away, they are back. */
  private heard(): void {
    this.lastHeard = now();
    const a = this.away;
    // (Our own app in the background is ended by coming back to it, not by a word from them.)
    if (a && !(a.who === 'self' && a.cause === 'hidden')) this.back();
  }

  /** A connection went: opens the rejoin window (once), or ends the match on the third drop. */
  private dropped(who: 'them' | 'self', cause: string): void {
    if (this.closed || !this.everOpened) return;
    if (this.away) return; // already waiting: a second sign of the same drop changes nothing
    // Switching apps is not a drop to count (it comes back by itself); a lost connection is.
    if (cause !== 'away' && cause !== 'hidden') {
      this.drops[who]++;
      if (this.drops[who] >= MAX_DROPS) return this.close(who === 'them' ? 'repeat' : 'self-repeat', false);
    }
    const t = now();
    this.away = { who, cause, since: t, until: t + REJOIN_MS };
    clearTimeout(this.awayTimer);
    this.awayTimer = setTimeout(() => this.expire(), REJOIN_MS);
    this.emit('away', { who, cause, until: this.away.until, drops: this.drops[who] });
  }

  private expire(): void {
    const a = this.away;
    if (!a || this.closed) return;
    // A page that was frozen (a phone in the background) may run this late: it gets its moment to say it is back.
    if (typeof document !== 'undefined' && document.hidden && a.who === 'self') {
      this.awayTimer = setTimeout(() => this.expire(), 250);
      return;
    }
    this.close(a.who === 'them' ? 'dropped' : 'self-dropped', false);
  }

  /** The player is heard again (or we are): the window closes and play goes on. */
  private back(): void {
    const a = this.away;
    if (!a || this.closed) return;
    this.away = null;
    clearTimeout(this.awayTimer);
    this.lastHeard = now();
    this.emit('back', { who: a.who, ms: now() - a.since, cause: a.cause });
  }

  /** Seconds left in the rejoin window (0 when there is none). */
  secondsLeft(): number {
    return this.away ? Math.max(0, Math.ceil((this.away.until - now()) / 1000)) : 0;
  }

  /** Our app went to the background and came back: the other side is told, so nobody guesses. */
  private watchPage(): void {
    if (this.watchingPage || typeof document === 'undefined') return;
    this.watchingPage = true;
    const onVis = () => {
      if (this.closed) return document.removeEventListener('visibilitychange', onVis);
      if (document.hidden) {
        if (this.net && this.peer) this.net.send('g', { k: '~away' }, { to: this.peer });
        this.dropped('self', 'hidden');
      } else {
        this.lastHeard = now();
        this.lastTickAt = 0;
        if (this.net && this.peer) this.net.send('g', { k: '~back' }, { to: this.peer });
        this.net?.send('~hi', { id: this.id });
        if (this.away?.who === 'self' && this.away.cause === 'hidden') this.back();
      }
    };
    document.addEventListener('visibilitychange', onVis);
  }

  /**
   * Playtest shortcut (the real thing, not a pretend one): our connection is cut for `ms`, then joins again as the same
   * player. The other side sees us leave the room and has its rejoin window; we hold ours.
   */
  async cutFor(ms: number): Promise<void> {
    const net = this.net;
    if (!net || this.closed) return;
    this.net = null;
    this.peer = '';
    this.dropped('self', 'cut');
    await net.leave('left').catch(() => {});
    await new Promise((r) => setTimeout(r, ms));
    if (this.closed) return;
    await this.connect();
  }

  private opened(): void {
    this.updateRoute();
    if (this.everOpened) return;
    this.everOpened = true;
    this.emit('open', {});
  }

  private updateRoute(): void {
    const net = this.net;
    if (!net) return;
    const pr = this.peer ? net.peers.get(this.peer) : undefined;
    this.route = net.transport === 'relay' ? 'relay' : pr?.route === 'direct' ? 'direct' : 'signal';
  }

  private onExpress(b: Uint8Array): void {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (b[0]) {
      case X_PING:
        if (b.length === 9) this.express(Uint8Array.of(X_PONG, ...b.subarray(1)));
        return;
      case X_PONG: {
        if (b.length !== 9) return;
        const rtt = Math.max(0, now() - view.getFloat64(1, true));
        this.rtt = rtt;
        this.rttAvg = this.rttAvg < 0 ? rtt : this.rttAvg * 0.7 + rtt * 0.3;
        return;
      }
      case X_MSG: {
        const n = b[1] ?? 0;
        const kind = decoder.decode(b.subarray(2, 2 + n));
        if (!kind || kind[0] === '~') return;
        this.recv.u++;
        this.emit('message', { kind, data: decoder.decode(b.subarray(2 + n)), reliable: false });
        return;
      }
      case X_INPUTS:
        this.recv.u++;
        this.emit('inputs', b.subarray(1));
        return;
    }
  }

  private express(bytes: Uint8Array): boolean {
    if (!this.net || !this.peer || this.closed) return false;
    try {
      return this.net.express(bytes, { to: this.peer });
    } catch (e) {
      netError('match room: an express frame was refused', e);
      return false;
    }
  }

  /** A game message. `data` is the game's own string. Reliable: once and in order; else at once, may be lost. */
  send(kind: string, data: string, reliable = true): boolean {
    if (!this.net || !this.peer || this.closed) return false;
    if (reliable) {
      this.net.send('g', { k: kind, d: data }, { to: this.peer });
      this.sent.r++;
      return true;
    }
    const k = encoder.encode(kind).subarray(0, 255);
    const d = encoder.encode(data);
    const b = new Uint8Array(2 + k.length + d.length);
    b[0] = X_MSG;
    b[1] = k.length;
    b.set(k, 2);
    b.set(d, 2 + k.length);
    const ok = this.express(b);
    if (ok) this.sent.u++;
    return ok;
  }

  /** The fight's input packet (rollback.ts encodePacket), as an express frame. */
  sendInputs(packet: Uint8Array): boolean {
    const b = new Uint8Array(1 + packet.length);
    b[0] = X_INPUTS;
    b.set(packet, 1);
    const ok = this.express(b);
    if (ok) this.sent.u++;
    return ok;
  }

  get open(): boolean {
    return Boolean(this.net && this.peer && !this.closed && !this.away && this.net.status !== 'closed');
  }

  private tick(): void {
    if (this.closed || !this.net) return;
    if (!this.peer) {
      // Not heard yet (or gone, in a rejoin window): say hello again (they may have joined after us and missed it).
      if (this.pingN++ % 3 === 0) this.net.send('~hi', { id: this.id });
      return;
    }
    this.updateRoute();
    const t = now();
    if (this.lastTickAt && t - this.lastTickAt > FROZEN_MS) this.lastHeard = t;
    this.lastTickAt = t;
    if (this.away) {
      // (Waiting for them to come back: keep saying hello; the window ends it.)
      if (this.away.who === 'them' && this.away.cause !== 'away') this.net.send('~hi', { id: this.id });
    } else if (t - this.lastHeard > this.silentMs) return this.dropped('them', 'silent');
    const b = new Uint8Array(9);
    b[0] = X_PING;
    new DataView(b.buffer).setFloat64(1, now(), true);
    this.express(b);
    this.pingN++;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.emit('failed', { reason });
    this.close(reason, false, true);
  }

  /** Leave: tells the other player (bye) unless `tell` is false. */
  close(reason = 'left', tell = true, failed = false): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    clearTimeout(this.awayTimer);
    const net = this.net;
    if (tell && net && this.peer) net.send('g', { k: '~bye' }, { to: this.peer });
    // (A moment for the bye to go before the room is left.)
    setTimeout(() => void net?.leave('left'), 300);
    if (!failed) this.emit('closed', { reason, opened: this.everOpened });
  }
}
