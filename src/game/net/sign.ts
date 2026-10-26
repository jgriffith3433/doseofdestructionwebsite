// Schnorr keys and signed events (Nostr's NIP-01 shape): the leaderboard's profile key, its signed results and the
// records they're kept as on Hawkes Net (records.ts). Nothing here talks to a network.
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, seconds, sha256Hex, toHex } from './util.ts';

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
