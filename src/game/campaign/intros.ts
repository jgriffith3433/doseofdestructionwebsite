// Pre-fight exchanges (content/intros.json): before a fight between two fighters who are a listed rival pair, the
// two trade a voiced jab (ui/scene.ts playExchange). Every other pair gets one of six generic exchanges by the first
// fighter's type, voiced from the booth. Pure, so `npm test` checks the data (test/intros.test.ts).

import introsJson from '../../../content/intros.json' with { type: 'json' };

export interface ExchangeLine {
  /** A character id, or 'announcer' / 'blog-man' for the booth. */
  who: string;
  text: string;
  audio: string;
}

export interface Exchange {
  id: string;
  lines: ExchangeLine[];
  /** True for a generic exchange (booth voices); false for a rival pair. */
  generic: boolean;
}

interface Pair {
  id: string;
  a: string;
  b: string;
  lines: ExchangeLine[];
}

const DATA = introsJson as unknown as {
  pairs: Pair[];
  types: Record<string, string>;
  generic: Record<string, { id: string; lines: ExchangeLine[] }>;
};

export const PAIRS: readonly Pair[] = DATA.pairs;
/** The longest an exchange may play, ms (the hard cap in ui/scene.ts). */
export const EXCHANGE_MAX_MS = 6000;

/** The listed pair for two fighter ids, in either order. */
export function pairFor(a: string, b: string): Exchange | null {
  const p = DATA.pairs.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  return p ? { id: p.id, lines: p.lines, generic: false } : null;
}

/** The generic exchange for a fighter's role (its type): heavy, fast, air, zone, brawl or allround. */
export function genericFor(role: string): Exchange {
  const type = DATA.types[role] ?? 'allround';
  const g = DATA.generic[type] ?? DATA.generic.allround;
  return { id: g.id, lines: g.lines, generic: true };
}

/** The exchange before a fight between `a` (the first fighter) and `b`: their pair's, else the generic one. */
export function exchangeFor(a: string, b: string, roleOfA: string): Exchange {
  return pairFor(a, b) ?? genericFor(roleOfA);
}

/** Campaign: pairs already played (localStorage), so an episode plays its pair's exchange the first time only. */
const KEY = 'dod-intros-seen';
export function seenExchanges(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
export function markExchangeSeen(id: string): void {
  try {
    const s = seenExchanges();
    s.add(id);
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // Private mode: it plays again, harmlessly.
  }
}
