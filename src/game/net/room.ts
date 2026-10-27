// A match room: the two paired players, in a Hawkes Net room of their own (docs/online.md, "The fight"). Both join the
// same name ("m/<a hash of the pairing>", a pair room: two players at most) and the room starts peer to peer, a direct
// WebRTC link between the two browsers, the shortest path there is; when they can't link (strict networks) Hawkes Net
// moves it to its relay on the same connections, so two players who could never meet before still can.
//
// Over it: the game's messages (reliable, once and in order: the handshake, the start, hashes, results), and express
// frames (Hawkes Net's: sent at once, forwarded at once, never queued, between the browsers on an unordered channel)
// for what can't wait: the fight's inputs (sendInputs) and a ping every second, so the round trip is the inputs' own.
import { join, type Room } from './hawkes/hawkes-net.mjs';
import { Emitter, netError, now, sha256Hex } from './util.ts';
import { NET_ENDPOINT, NET_PROJECT, roomName } from './hawkes.ts';

const PING_MS = 1000;
const SILENT_MS = 6000;
/** A tick this much later than due means our own page was frozen (loading a stage): we heard nothing because we couldn't. */
const FROZEN_MS = 2500;
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

  constructor(room: string, id: string, remote: string, _options: RoomOptions = {}) {
    super();
    this.room = room;
    this.id = id;
    this.remote = remote;
  }

  async start(): Promise<void> {
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
      this.fail(`no room (${(e as Error)?.message ?? e})`);
      return;
    }
    if (this.closed) {
      void net.leave('left');
      return;
    }
    this.net = net;
    net.on<{ id?: string }>('~hi', (d, from) => {
      if (!from || d?.id !== this.remote) return;
      const first = !this.peer || this.peer !== from.id;
      this.peer = from.id;
      this.lastHeard = now();
      if (first) net.send('~hi', { id: this.id }, { to: from.id }); // (they may have joined after our first hello)
      this.opened();
    });
    net.on<{ k?: string; d?: string }>('g', (m, from) => {
      if (!from || from.id !== this.peer) return;
      this.lastHeard = now();
      if (typeof m?.k !== 'string') return;
      if (m.k === '~bye') return this.close('left', false);
      this.recv.r++;
      this.emit('message', { kind: m.k, data: typeof m.d === 'string' ? m.d : '', reliable: true });
    });
    net.onExpress((bytes, from) => {
      if (from !== this.peer || !bytes.length) return;
      this.lastHeard = now();
      this.onExpress(bytes);
    });
    // Whoever joins (the other player, or them again on a new connection) hears who we are.
    net.when('peer:join', (p) => net.send('~hi', { id: this.id }, { to: p.id }));
    net.when('peer:leave', ({ peer }) => {
      if (peer.id === this.peer) this.close('left', false);
    });
    net.when('status', ({ status }) => {
      if (status !== 'closed' || this.closed) return;
      if (this.everOpened) this.close('lost', false);
      else this.fail('no link');
    });
    net.when('transport', (e) => console.info(`[dod-online] match room moved: ${e.from} to the ${e.to} (${e.why})`));
    net.send('~hi', { id: this.id });
    this.ticker = setInterval(() => this.tick(), PING_MS);
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
    return Boolean(this.net && this.peer && !this.closed && this.net.status !== 'closed');
  }

  private tick(): void {
    if (this.closed || !this.net) return;
    if (!this.peer) {
      // Not heard yet: say hello again (they may have joined after us and missed it).
      if (this.pingN++ % 3 === 0) this.net.send('~hi', { id: this.id });
      return;
    }
    this.updateRoute();
    const t = now();
    if (this.lastTickAt && t - this.lastTickAt > FROZEN_MS) this.lastHeard = t;
    this.lastTickAt = t;
    if (t - this.lastHeard > this.silentMs) return this.close('silent', false);
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
    const net = this.net;
    if (tell && net && this.peer) net.send('g', { k: '~bye' }, { to: this.peer });
    // (A moment for the bye to go before the room is left.)
    setTimeout(() => void net?.leave('left'), 300);
    if (!failed) this.emit('closed', { reason, opened: this.everOpened });
  }
}
