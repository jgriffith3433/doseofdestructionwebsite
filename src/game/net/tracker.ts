// The fallback signalling path: public WebTorrent trackers. A tracker passes "offers" to random peers announcing the
// same info hash and "answers" to one named peer, so it works as a small message bus: a broadcast goes out as offers,
// a message to one peer as an answer to it. The payloads are the room's sealed signalling messages, never media.
// Adapted from Yooba Land's hawkes-net (src/tracker.js).
import { TRACKERS } from './util.ts';

const PAD = '-';

interface Entry {
  url: string;
  socket: WebSocket | null;
  open: boolean;
  failures: number;
}

export class TrackerBus {
  readonly infoHash: string;
  readonly peerId: string;
  private readonly onMessage: (payload: string, from: string) => void;
  private readonly sockets: Entry[];
  private closed = false;
  private lastBroadcast: string | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  // infoHash: 40 hex chars (the room's topic). peerId: the room peer's id.
  constructor(infoHash: string, peerId: string, onMessage: (payload: string, from: string) => void, urls = TRACKERS) {
    this.infoHash = infoHash.substring(0, 20);
    this.peerId = peerId.padEnd(20, PAD).substring(0, 20);
    this.onMessage = onMessage;
    this.sockets = urls.map((url) => ({ url, socket: null, open: false, failures: 0 }));
    for (const entry of this.sockets) this.connect(entry);
    this.timer = setInterval(() => this.reannounce(), 30000);
  }

  private connect(entry: Entry): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(entry.url);
    } catch {
      return;
    }
    entry.socket = socket;
    socket.onopen = () => {
      entry.open = true;
      entry.failures = 0;
      this.announce(entry, this.lastBroadcast ? [this.lastBroadcast] : [], 0, 'started');
    };
    socket.onmessage = (message) => {
      let data: { info_hash?: string; peer_id?: string; offer?: { sdp?: string }; answer?: { sdp?: string } };
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (data.info_hash !== this.infoHash || !data.peer_id || data.peer_id === this.peerId) return;
      const from = data.peer_id.replace(/-+$/, '');
      const payload = data.offer?.sdp ?? data.answer?.sdp;
      if (typeof payload === 'string') this.onMessage(payload, from);
    };
    socket.onclose = () => {
      entry.open = false;
      entry.failures++;
      if (!this.closed && entry.failures < 6) setTimeout(() => this.connect(entry), Math.min(60000, 3000 * Math.pow(2, entry.failures)));
    };
    socket.onerror = () => {};
  }

  private announce(entry: Entry, payloads: string[], copies: number, event?: string): boolean {
    if (!entry.open || !entry.socket) return false;
    const offers: unknown[] = [];
    for (const payload of payloads) {
      for (let i = 0; i < copies; i++) offers.push({ offer: { type: 'offer', sdp: payload }, offer_id: Math.random().toString(36).slice(2, 12).padEnd(20, '0') });
    }
    const message: Record<string, unknown> = { action: 'announce', info_hash: this.infoHash, peer_id: this.peerId, uploaded: 0, downloaded: 0, left: 1, numwant: offers.length, offers };
    if (event) message.event = event;
    try {
      entry.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private reannounce(): void {
    for (const entry of this.sockets) this.announce(entry, this.lastBroadcast ? [this.lastBroadcast] : [], 4);
  }

  // To up to `copies` random peers on each tracker.
  broadcast(payload: string, copies = 8): number {
    this.lastBroadcast = payload;
    let sent = 0;
    for (const entry of this.sockets) if (this.announce(entry, [payload], copies)) sent++;
    return sent;
  }

  sendTo(peerId: string, payload: string): number {
    const to = peerId.padEnd(20, PAD).substring(0, 20);
    let sent = 0;
    for (const entry of this.sockets) {
      if (!entry.open || !entry.socket) continue;
      try {
        entry.socket.send(JSON.stringify({ action: 'announce', info_hash: this.infoHash, peer_id: this.peerId, to_peer_id: to, answer: { type: 'answer', sdp: payload }, offer_id: 'x'.padEnd(20, '0') }));
        sent++;
      } catch {
        // A socket that just closed; the others carry it.
      }
    }
    return sent;
  }

  openUrls(): string[] {
    return this.sockets.filter((e) => e.open).map((e) => e.url);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const entry of this.sockets) {
      if (entry.open && entry.socket) {
        try {
          entry.socket.send(JSON.stringify({ action: 'announce', info_hash: this.infoHash, peer_id: this.peerId, event: 'stopped', uploaded: 0, downloaded: 0, left: 1, numwant: 0 }));
        } catch {
          // Closing anyway.
        }
      }
      entry.socket?.close();
    }
  }
}
