// The winner's quote on the results screen (content/voice.json `winQuotes`, made by tools/win-quotes.mjs): every fighter has
// two general quotes (the older `fighter.<id>.win` line and one more) and one matchup quote against each story rival (the
// pairs in content/intros.json). Beating a rival picks the matchup quote; otherwise a general one. A fighter never plays the
// same quote twice in a row (the matchup quote gives way to a general one when it would repeat). Pure: audio and the screen
// read the pick.
import type { VoiceCatalog, VoiceLine } from './audio.ts';

export interface QuoteEntry {
  id: string;
  text: string;
  audio?: string;
  take?: { text: string; voice: string };
}
export interface FighterQuotes {
  general: QuoteEntry[];
  vs: Record<string, QuoteEntry>;
}
export interface WinQuote {
  id: string;
  text: string;
  /** The recorded take, or null while it is only text. */
  audio: string | null;
  kind: 'general' | 'rival';
  winner: string;
  /** The beaten fighter the quote was aimed at (the rival for a matchup quote). */
  loser: string | null;
}

/** Every winQuotes entry as a catalog line, so `audio.line(id)` and preloading find it. */
export function winQuoteLines(voice: VoiceCatalog & { winQuotes?: Record<string, FighterQuotes> }): VoiceLine[] {
  const out: VoiceLine[] = [];
  for (const [who, q] of Object.entries(voice.winQuotes ?? {})) {
    for (const e of [...q.general, ...Object.values(q.vs)]) out.push({ id: e.id, group: 'win-quote', who, text: e.text, audio: e.audio ?? null, take: e.take ?? null });
  }
  return out;
}

/** The quotes a fighter can say: the existing win line first, then the general ones. */
export function generalPool(voice: VoiceCatalog & { winQuotes?: Record<string, FighterQuotes> }, who: string): QuoteEntry[] {
  const old = voice.lines.find((l) => l.id === `fighter.${who}.win`);
  const pool: QuoteEntry[] = old ? [{ id: old.id, text: old.text, audio: old.audio ?? undefined }] : [];
  return [...pool, ...(voice.winQuotes?.[who]?.general ?? [])];
}

const lastPlayed = new Map<string, string>();
/** The quote the results screen is showing (the last pick). */
let current: WinQuote | null = null;
export const currentWinQuote = (): WinQuote | null => current;
/** No quote for the next results screen (a void or no-contest match). */
export function clearWinQuote(): void {
  current = null;
}
/** Forgets which quote each fighter played last (tests). */
export function resetWinQuotes(): void {
  lastPlayed.clear();
  current = null;
}

/**
 * Picks the winner's quote for a beaten field (`losers`: fighter ids). `rand` is 0..1; `only` forces one id (a Tour ending that
 * already played its line). The pick is remembered as that fighter's last.
 */
export function pickWinQuote(voice: VoiceCatalog & { winQuotes?: Record<string, FighterQuotes> }, winner: string, losers: string[], rand: () => number = Math.random, only?: string): WinQuote {
  const prev = lastPlayed.get(winner);
  const rival = losers.map((l) => ({ l, q: voice.winQuotes?.[winner]?.vs[l] })).find((x) => x.q && x.q.id !== prev);
  const pool = generalPool(voice, winner);
  let pick: QuoteEntry | undefined;
  let kind: WinQuote['kind'] = 'general';
  let loser: string | null = losers[0] ?? null;
  if (only) pick = pool.find((e) => e.id === only);
  else if (rival?.q) {
    pick = rival.q;
    kind = 'rival';
    loser = rival.l;
  } else {
    const fresh = pool.filter((e) => e.id !== prev);
    const from = fresh.length ? fresh : pool;
    pick = from[Math.min(from.length - 1, Math.floor(rand() * from.length))];
  }
  const e = pick ?? { id: `fighter.${winner}.win`, text: '' };
  lastPlayed.set(winner, e.id);
  current = { id: e.id, text: e.text, audio: e.audio ?? null, kind, winner, loser };
  return current;
}
