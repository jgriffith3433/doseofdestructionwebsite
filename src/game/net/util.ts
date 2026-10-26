// Small helpers shared by the network code (docs/online.md): ids, hex, hashing, error reports, a tiny emitter. The
// network itself is Hawkes Net (hawkes.ts, lobby.ts, room.ts, records.ts).

export const APP_ID = 'hawkes-dod';

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
