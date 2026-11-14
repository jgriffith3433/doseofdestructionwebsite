// Auto CPU level: the quick-play (versus) opponent steps up after a clear win and down after a clear loss, within 1 to 9.
// Pure rules plus the saved level, kept beside the profile (`dod.profile.cpu`, a sibling of `dod.profile` and
// `dod.profile.key`: the profile record itself is rewritten whole by net/profile.ts). Campaign and Tours never use it.

export const AUTO_MIN = 1;
export const AUTO_MAX = 9;
/** A new player starts here: a fight they can just about win. */
export const AUTO_START = 3;
const KEY = 'dod.profile.cpu';

export interface AutoResult {
  /** The player won the match. */
  won: boolean;
  /** Stocks each fighter started with. */
  stocks: number;
  /** Stocks the player had left at the end. */
  stocksLeft: number;
  /** Stocks the CPUs lost between them. */
  foeStocksLost: number;
  /** Percent of damage the player dealt. */
  dealt: number;
}

/** A loss that never got going: no stock taken, or barely any damage dealt. */
export const CLEAR_LOSS_DEALT = 60;

/**
 * +1 after a clear win (the player lost at most one stock: 2+ left of 3; with fewer stocks, a flawless win),
 * -1 after a clear loss (no stock taken, or under 60% dealt), else 0.
 */
export function levelStep(r: AutoResult): -1 | 0 | 1 {
  if (r.won) return r.stocksLeft >= Math.min(r.stocks, Math.max(2, r.stocks - 1)) ? 1 : 0;
  return r.foeStocksLost === 0 || r.dealt < CLEAR_LOSS_DEALT ? -1 : 0;
}

export function clampLevel(n: number): number {
  return Math.max(AUTO_MIN, Math.min(AUTO_MAX, Math.round(Number.isFinite(n) ? n : AUTO_START)));
}

export function loadAutoLevel(): number {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved.level === 'number') return clampLevel(saved.level);
  } catch {
    // Unreadable storage: the starting level.
  }
  return AUTO_START;
}

export function saveAutoLevel(level: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ level: clampLevel(level) }));
  } catch {
    // Storage can be blocked; the level then lasts for this visit.
  }
}

/** Applies a finished match to the saved level; returns the move, or null when the level stays (a middling result or an edge). */
export function applyResult(r: AutoResult): { from: number; to: number } | null {
  const from = loadAutoLevel();
  const to = clampLevel(from + levelStep(r));
  if (to === from) return null;
  saveAutoLevel(to);
  return { from, to };
}

/** The one-line Results note. */
export function levelNote(from: number, to: number): string {
  return `Auto: CPU level ${from} → ${to}`;
}
