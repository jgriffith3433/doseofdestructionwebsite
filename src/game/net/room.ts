// A match room: the WebRTC link between the two paired players. Adapted from Yooba Land's neighborhood room
// (src/room.js) for exactly two peers who already know each other's id from the lobby: no roster, relay or host
// election, just the signalling and one link.
//
// Signalling (swapping WebRTC offers) goes over public Nostr relays as ephemeral events and, as the fallback, over
// public WebTorrent trackers; both carry the same sealed messages, so a browser that can't reach one still meets the
// other player through the other. Nothing we host is involved.
//
// On top of the link: a hello, a ping every second for the round trip, and a bye.
import { PeerLink } from './link.ts';
import { TrackerBus } from './tracker.ts';
import { makeKey, sharedPool, signEvent, type NostrKey, type NostrPool } from './nostr.ts';
import { APP_ID, Emitter, netError, now, randomId, roomKey, seal, seconds, sha256Hex, unseal } from './util.ts';

export const SIGNAL_KIND = 21791; // ephemeral (20000-29999): relays pass it on and don't keep it
const PING_MS = 1000;
const SILENT_MS = 6000;

interface Signal {
  t: 'hi' | 'offer' | 'answer' | 'bye';
  from?: string;
  to?: string;
  nonce?: string;
  sid?: string;
  sdp?: string;
}

export interface RoomOptions {
  /** Rewrite mDNS host candidates to 127.0.0.1: both players are in one browser (the two-tab playtest). */
  sameMachine?: boolean;
  rtc?: typeof RTCPeerConnection;
  pool?: NostrPool;
  signal?: 'both' | 'nostr' | 'torrent';
}

/**
 * Events: "open" (the link is up), "message" ({ kind, data, reliable }), "closed" ({ reason }) once the link is
 * lost for good, "failed" ({ reason }) when it never opened.
 */
export class PairRoom extends Emitter {
  readonly room: string;
  readonly id: string;
  readonly remote: string;
  link: PeerLink | null = null;
  rtt = -1;
  rttAvg = -1;
  route = '';
  closed = false;
  everOpened = false;
  lastHeard = 0;
  readonly sent = { r: 0, u: 0 };
  readonly recv = { r: 0, u: 0 };
  private key: CryptoKey | null = null;
  private topic = '';
  private readonly nostrKey: NostrKey = makeKey();
  private readonly pool: NostrPool | null;
  private tracker: TrackerBus | null = null;
  private sub: { close(): void } | null = null;
  private readonly seen = new Set<string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private pingN = 0;
  private readonly options: RoomOptions;

  constructor(room: string, id: string, remote: string, options: RoomOptions = {}) {
    super();
    this.room = room;
    this.id = id;
    this.remote = remote;
    this.options = options;
    this.pool = options.signal === 'torrent' ? null : (options.pool ?? sharedPool());
  }

  async start(): Promise<void> {
    try {
      this.key = await roomKey(this.room);
      this.topic = await sha256Hex(APP_ID + '|room|' + this.room);
    } catch (e) {
      netError('match room: WebCrypto is unavailable', e);
      this.fail('no WebCrypto');
      return;
    }
    if (this.closed) return;
    if (this.pool) {
      this.sub = this.pool.subscribe([{ kinds: [SIGNAL_KIND], '#x': [this.topic], since: seconds() - 10 }], (event) => void this.onSignal(event.content));
    }
    if (this.options.signal !== 'nostr') {
      try {
        this.tracker = new TrackerBus(this.topic, this.id, (text) => void this.onSignal(text));
      } catch (e) {
        netError('match room: trackers unavailable', e);
      }
    }
    // Say hello quickly at first (relays and trackers take a moment), then every 3 s until the link is up.
    for (const ms of [200, 1200, 2500]) this.timers.push(setTimeout(() => this.hello(), ms));
    this.ticker = setInterval(() => this.tick(), PING_MS);
  }

  private hello(): void {
    if (this.closed || this.link?.state === 'open') return;
    void this.sendSignal({ t: 'hi', to: this.remote });
  }

  private sdpFor(sdp: string): string {
    // Browsers hide their LAN address behind an mDNS name (abc.local) that a second tab on the same device (iOS Safari,
    // a private tab) often can't resolve. So every mDNS host candidate also goes out as a 127.0.0.1 copy: it only
    // connects when the other player is on this device, and costs a failed check otherwise. The playtest's two tabs
    // (sameMachine) use only the loopback one.
    return sdp.replace(/^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+\.local) (\d+) typ host(.*)$/gm, (line, f, c, proto, prio, _h, port, rest) =>
      this.options.sameMachine ? `a=candidate:${f} ${c} ${proto} ${prio} 127.0.0.1 ${port} typ host${rest}` : `${line}\r\na=candidate:l${f} ${c} ${proto} ${Number(prio) - 1} 127.0.0.1 ${port} typ host${rest}`);
  }

  private async sendSignal(message: Signal): Promise<void> {
    if ((this.closed && message.t !== 'bye') || !this.key) return;
    message.from = this.id;
    message.nonce = randomId(10);
    try {
      const text = await seal(this.key, message);
      if (this.pool) this.pool.publish(await signEvent(this.nostrKey, SIGNAL_KIND, [['x', this.topic]], text));
      if (this.tracker) {
        if (message.to) this.tracker.sendTo(message.to, text);
        else this.tracker.broadcast(text);
      }
    } catch (e) {
      netError(`match room: sending the ${message.t} signal failed`, e);
    }
  }

  private async onSignal(text: string): Promise<void> {
    if (this.closed || !this.key) return;
    const message = await unseal<Signal>(this.key, text);
    if (!message || message.from !== this.remote || (message.to && message.to !== this.id)) return;
    if (!message.nonce || this.seen.has(message.nonce)) return;
    this.seen.add(message.nonce);
    if (message.t === 'bye') {
      this.close('left', false);
      return;
    }
    const link = this.link;
    if (message.t === 'hi') {
      if (link?.state === 'open') return;
      // The smaller id offers; the other answers its hello with one of its own.
      if (this.id < this.remote) {
        if (link && link.initiator && link.state === 'connecting' && now() - link.startedAt > 4000) link.close('restart');
        if (!this.link) void this.connect();
      } else this.hello();
    } else if (message.t === 'offer' && message.sdp) {
      if (link?.state === 'open') return;
      if (link) link.close('restart');
      const answering = this.makeLink(false);
      answering.sid = message.sid ?? '';
      try {
        const sdp = this.sdpFor(await answering.answer(message.sdp));
        if (this.isCurrent(answering) && answering.state !== 'closed') void this.sendSignal({ t: 'answer', to: this.remote, sid: message.sid, sdp });
      } catch (e) {
        netError('match room: could not answer the offer', e);
        answering.close('bad offer');
      }
    } else if (message.t === 'answer' && message.sdp) {
      if (link && link.initiator && link.sid === message.sid) {
        try {
          await link.accept(message.sdp);
        } catch (e) {
          netError('match room: could not accept the answer', e);
          link.close('bad answer');
        }
      }
    }
  }

  private makeLink(initiator: boolean): PeerLink {
    let link: PeerLink;
    try {
      link = new PeerLink(this.remote, {
        open: () => {
          if (this.link !== link) return;
          this.everOpened = true;
          this.lastHeard = now();
          link.route().then((r) => (this.route = r)).catch(() => undefined);
          this.emit('open', {});
        },
        message: (text, reliable) => {
          if (this.link === link) this.onData(text, reliable);
        },
        close: (reason, was) => {
          if (this.link !== link) return;
          this.link = null;
          if (this.closed) return;
          if (was === 'open') {
            this.close(reason, false);
          } else if (reason !== 'restart') {
            this.attempts++;
            netError(`match room: link to ${this.remote} failed (${reason}, try ${this.attempts})`);
            if (this.attempts >= 3) this.fail(reason);
            else this.timers.push(setTimeout(() => this.hello(), 1000));
          }
        },
      }, this.options.rtc);
    } catch (e) {
      // No WebRTC at all (very old browsers, some in-app webviews).
      netError('match room: this browser has no WebRTC', e);
      this.fail('no WebRTC');
      throw e;
    }
    link.initiator = initiator;
    this.link = link;
    return link;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.link) return;
    let link: PeerLink;
    try {
      link = this.makeLink(true);
    } catch {
      return;
    }
    link.sid = randomId(8);
    try {
      const sdp = this.sdpFor(await link.offer());
      if (this.isCurrent(link) && link.state === 'connecting') void this.sendSignal({ t: 'offer', to: this.remote, sid: link.sid, sdp });
    } catch (e) {
      netError('match room: could not make an offer', e);
      link.close('offer failed');
    }
  }

  private isCurrent(link: PeerLink): boolean {
    return this.link === link;
  }

  private onData(text: string, reliable: boolean): void {
    let message: { k?: string; d?: string; n?: number; t?: number };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    this.lastHeard = now();
    if (message.k === '~ping') this.link?.send(JSON.stringify({ k: '~pong', n: message.n, t: message.t }), true);
    else if (message.k === '~pong') {
      const rtt = Math.max(0, now() - Number(message.t));
      this.rtt = rtt;
      this.rttAvg = this.rttAvg < 0 ? rtt : this.rttAvg * 0.7 + rtt * 0.3;
    } else if (message.k === '~bye') this.close('left', false);
    else if (typeof message.k === 'string' && message.k[0] !== '~') {
      this.recv[reliable ? 'r' : 'u']++;
      this.emit('message', { kind: message.k, data: typeof message.d === 'string' ? message.d : '', reliable });
    }
  }

  /** A game message. `data` is the game's own JSON string. */
  send(kind: string, data: string, reliable = true): boolean {
    if (!this.link || this.link.state !== 'open') return false;
    const ok = this.link.send(JSON.stringify({ k: kind, d: data }), reliable);
    if (ok) this.sent[reliable ? 'r' : 'u']++;
    return ok;
  }

  get open(): boolean {
    return this.link?.state === 'open';
  }

  private tick(): void {
    if (this.closed) return;
    if (this.link?.state === 'open') {
      if (now() - this.lastHeard > SILENT_MS) {
        this.link.close('silent');
        return;
      }
      this.link.send(JSON.stringify({ k: '~ping', n: ++this.pingN, t: now() }), true);
    } else if (!this.link && this.pingN % 3 === 0) {
      this.hello();
    }
    if (!this.link || this.link.state !== 'open') this.pingN++;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.emit('failed', { reason });
    this.close(reason, false, true);
  }

  /** Leave: tells the other player (bye) unless `quiet`. */
  close(reason = 'left', tell = true, failed = false): void {
    if (this.closed) return;
    this.closed = true;
    if (tell) {
      this.link?.send(JSON.stringify({ k: '~bye' }), true);
      void this.sendSignal({ t: 'bye' });
    }
    for (const t of this.timers) clearTimeout(t);
    clearInterval(this.ticker);
    const link = this.link;
    setTimeout(() => {
      link?.close('left');
      this.sub?.close();
      this.tracker?.close();
    }, 300);
    if (!failed) this.emit('closed', { reason, opened: this.everOpened });
  }
}
