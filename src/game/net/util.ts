// Small helpers shared by the network code (docs/online.md). Adapted from Yooba Land's hawkes-net
// (YoobaLand/Tools/Web/net/src/util.js): the same relays, trackers and sealing, with DoD's own app id.

export const APP_ID = 'hawkes-dod';

// Google's and Cloudflare's public STUN servers. No TURN: two players whose networks both refuse a direct link
// (strict NATs, some phone carriers) can't play each other, and the game says so.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Public Nostr relays that accept both the ephemeral signalling events and the stored presence events (Yooba Land's
// list, checked again 2026-10-18 for DoD: offchain.pub now refuses keys outside its web of trust, so it's out). A page
// uses the first five that open; a relay that refuses an event is warned about once and the others carry it.
export const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
];

// Public WebTorrent trackers: the fallback signalling path for a match's link.
export const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const now = (): number => Date.now();
export const seconds = (): number => Math.floor(Date.now() / 1000);

export function randomId(length = 12): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

// Signalling payloads are sealed with a key everyone in the room can derive from its name. It is not secrecy (the
// room names are public); it keeps addresses in the offers from being readable by anyone watching a relay.
export async function roomKey(room: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(APP_ID + '|seal|' + room));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value))));
  return toHex(iv) + toHex(data);
}

export async function unseal<T = Record<string, unknown>>(key: CryptoKey, text: string): Promise<T | null> {
  try {
    const iv = fromHex(text.substr(0, 24));
    const data = fromHex(text.substr(24));
    return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource)));
  } catch {
    return null;
  }
}

/** Every network failure goes through here: console.error with context, so the beta 🐞 capture and Studio's error reports see it. */
export function netError(context: string, err?: unknown): void {
  console.error(`[dod-online] ${context}`, err ?? '');
}

type Handler = (value: any) => void;

/** A tiny event emitter. A handler that throws is reported, not passed on. */
export class Emitter {
  private handlers: Record<string, Handler[]> = {};
  on(type: string, handler: Handler): () => void {
    (this.handlers[type] ??= []).push(handler);
    return () => this.off(type, handler);
  }
  off(type: string, handler: Handler): void {
    const list = this.handlers[type];
    if (list) this.handlers[type] = list.filter((h) => h !== handler);
  }
  emit(type: string, value?: unknown): void {
    for (const handler of this.handlers[type] ?? []) {
      try {
        handler(value);
      } catch (e) {
        netError(`${type} handler failed`, e);
      }
    }
  }
}
