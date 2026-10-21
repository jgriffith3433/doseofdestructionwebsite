// A small Nostr client: one pool of public relay sockets per page, shared by the lobby's presence and every match
// room's signalling. Events are signed with Schnorr keys (NIP-01); nothing here needs an account or a server of ours.
// Adapted from Yooba Land's hawkes-net (src/nostr.js).
import { schnorr } from '@noble/curves/secp256k1.js';
import { NOSTR_RELAYS, fromHex, netError, randomId, seconds, sha256Hex, toHex } from './util.ts';

export interface NostrKey {
  secret: Uint8Array;
  secretHex: string;
  pubkey: string;
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type Filter = Record<string, unknown>;

export function makeKey(secretHex?: string): NostrKey {
  const secret = secretHex ? fromHex(secretHex) : schnorr.utils.randomSecretKey();
  return { secret, secretHex: toHex(secret), pubkey: toHex(schnorr.getPublicKey(secret)) };
}

export async function signEvent(key: NostrKey, kind: number, tags: string[][], content: string, createdAt?: number): Promise<NostrEvent> {
  const created_at = createdAt || seconds();
  const id = await sha256Hex(JSON.stringify([0, key.pubkey, created_at, kind, tags, content]));
  const sig = toHex(schnorr.sign(fromHex(id), key.secret));
  return { id, pubkey: key.pubkey, created_at, kind, tags, content, sig };
}

class Relay {
  socket: WebSocket | null = null;
  open = false;
  failures = 0;
  closed = false;
  accepted = 0;
  refused = 0;
  lastRefusal = '';
  private refusedAt: number[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly pool: NostrPool;
  readonly url: string;

  constructor(pool: NostrPool, url: string) {
    this.pool = pool;
    this.url = url;
    this.connect();
  }

  connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (e) {
      netError(`relay ${this.url}: could not open a socket`, e);
      this.retry();
      return;
    }
    this.socket = socket;
    const timeout = setTimeout(() => {
      if (!this.open) socket.close();
    }, 8000);
    socket.onopen = () => {
      clearTimeout(timeout);
      this.open = true;
      this.failures = 0;
      this.pool.relayOpened(this);
    };
    socket.onmessage = (message) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (Array.isArray(data)) this.pool.received(this, data);
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      this.open = false;
      this.retry();
    };
    socket.onerror = () => {};
  }

  retry(): void {
    if (this.closed) return;
    this.failures++;
    clearTimeout(this.retryTimer);
    // A relay that never opened on the first try (or failed 3 times after opening before) is swapped out for a
    // fallback right away so the browser does not log repeated WebSocket 503/connection errors for a dead relay.
    if ((!this.pool.everOpened(this) && this.failures >= 1) || this.failures >= 3) {
      this.pool.relayGaveUp(this);
      return;
    }
    const delay = Math.min(30000, 1500 * Math.pow(2, this.failures));
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  recordRefusal(why: string): boolean {
    const t = Date.now();
    this.refused++;
    this.lastRefusal = why;
    this.refusedAt = this.refusedAt.filter((at) => t - at < 60000).concat(t);
    return (this.refused >= 2 && this.accepted === 0) || this.refusedAt.length >= 3;
  }

  // Back from the background or the network: a closed socket tries again now, not at the end of its back-off.
  wake(): void {
    if (this.closed || this.open || !this.socket || this.socket.readyState === 0) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  send(data: unknown): boolean {
    if (this.open && this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch (e) {
        netError(`relay ${this.url}: send failed`, e);
      }
    }
    return false;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}

// What a relay says when it will not take our events (rate limits, bans, web-of-trust and sign-up policies, NIP-05,
// kinds it does not allow, proof of work, auth). Two of these and the relay is swapped for the next one.
const REFUSED = /rate|limit|banned|blocked|restricted|policy|trust|not allowed|pow|auth|sign up|nip-05|paid|whitelist/i;

interface Sub {
  id: string;
  filters: Filter[];
  onEvent: (event: NostrEvent, url: string) => void;
  onEose?: (url: string, count: number) => void;
  seen: Set<string>;
  eose: Set<string>;
}

export class NostrPool {
  readonly urls: string[];
  readonly max: number;
  relays: Relay[] = [];
  readonly subs = new Map<string, Sub>();
  readonly opened = new Set<string>();
  private next = 0;
  published = 0;
  receivedEvents = 0;
  /** Every relay on the list refused to open (a network that blocks them): online can't work here. */
  exhausted = false;
  private readonly warned = new Set<string>();

  constructor(urls = NOSTR_RELAYS, max = 5) {
    this.urls = urls.slice();
    this.max = max;
    for (let i = 0; i < Math.min(max, this.urls.length); i++) this.add();
  }

  private add(): void {
    if (this.next >= this.urls.length) {
      if (!this.relays.length) this.exhausted = true;
      return;
    }
    this.relays.push(new Relay(this, this.urls[this.next++]));
  }

  everOpened(relay: Relay): boolean {
    return this.opened.has(relay.url);
  }

  relayOpened(relay: Relay): void {
    this.opened.add(relay.url);
    for (const sub of this.subs.values()) relay.send(['REQ', sub.id, ...sub.filters]);
  }

  // A relay that never opened, or that refuses our events: swap in the next one on the list.
  relayGaveUp(relay: Relay): void {
    relay.close();
    this.relays = this.relays.filter((r) => r !== relay);
    this.add();
    if (!this.relays.length) this.exhausted = true;
  }

  /** Every relay gave up (a network that blocked them all, or a device that was offline): start the list again. */
  revive(): void {
    if (this.relays.some((r) => !r.closed && !r.open)) {
      for (const relay of this.relays) relay.wake();
      return;
    }
    if (this.openUrls().length) return;
    for (const relay of this.relays) relay.close();
    this.relays = [];
    this.next = 0;
    this.exhausted = false;
    for (let i = 0; i < Math.min(this.max, this.urls.length); i++) this.add();
  }

  received(relay: Relay, data: unknown[]): void {
    const [type, subId, payload] = data as [string, string, NostrEvent | undefined];
    const sub = this.subs.get(subId);
    if (type === 'EVENT' && sub && payload && payload.id) {
      if (sub.seen.has(payload.id)) return;
      sub.seen.add(payload.id);
      if (sub.seen.size > 4000) sub.seen = new Set([...sub.seen].slice(-2000));
      this.receivedEvents++;
      sub.onEvent(payload, relay.url);
    } else if (type === 'EOSE' && sub) {
      sub.eose.add(relay.url);
      sub.onEose?.(relay.url, sub.eose.size);
    } else if (type === 'OK' && data[2] === true) {
      relay.accepted++;
    } else if (type === 'NOTICE' || (type === 'OK' && data[2] === false)) {
      // A relay refusing an event (rate limits, its own policy) is worth knowing about once, not fatal: the others
      // carry it, and a relay that keeps refusing is swapped for the next one on the list.
      const why = String(type === 'OK' ? data[3] : data[1]).slice(0, 160);
      const key = `${relay.url}|${why.replace(/[0-9a-f]{16,}/g, '')}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[dod-online] relay ${relay.url} refused: ${why}`);
      }
      if (type === 'OK' && REFUSED.test(why) && relay.recordRefusal(why)) {
        this.relayGaveUp(relay);
      }
    }
  }

  subscribe(filters: Filter[], onEvent: Sub['onEvent'], onEose?: Sub['onEose']): { close(): void } {
    const sub: Sub = { id: 'h' + randomId(10), filters, onEvent, onEose, seen: new Set(), eose: new Set() };
    this.subs.set(sub.id, sub);
    for (const relay of this.relays) relay.send(['REQ', sub.id, ...filters]);
    return {
      close: () => {
        this.subs.delete(sub.id);
        for (const relay of this.relays) relay.send(['CLOSE', sub.id]);
      },
    };
  }

  publish(event: NostrEvent): number {
    let sent = 0;
    for (const relay of this.relays) if (relay.send(['EVENT', event])) sent++;
    if (sent) this.published++;
    return sent;
  }

  openUrls(): string[] {
    return this.relays.filter((r) => r.open && !(r.refused >= 2 && r.accepted === 0)).map((r) => r.url);
  }

  /**Resolves once at least one relay is open (true), or after the timeout (false). */
  ready(timeoutMs = 8000): Promise<boolean> {
    if (this.openUrls().length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.openUrls().length || this.exhausted || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(this.openUrls().length > 0);
        }
      }, 100);
    });
  }
}

let shared: NostrPool | null = null;
export function sharedPool(): NostrPool {
  if (!shared) shared = new NostrPool();
  return shared;
}
