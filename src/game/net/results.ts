// The match-result event: the hook the leaderboard (part 2 of online play) listens on. Every finished online match
// fires it once on each player's page, with the same matchId on both, so a listener can count it once.
//
//   import { onMatchResult } from './net/results.ts';
//   onMatchResult((r) => ...);
//   // or, outside the bundle: window.addEventListener('dod:match-result', (e) => e.detail)

export type EndReason =
  /** The game ended on stocks. */
  | 'game'
  /** Time ran out (winner by stocks, then percent; null on a draw). */
  | 'time'
  /** A player left the match (Leave match, closed the tab): the other wins. */
  | 'forfeit'
  /** The link was lost mid-match: the player still connected is the winner on their page. */
  | 'disconnect'
  /** The two games' states differed: void, no winner. */
  | 'desync'
  /** The other page never loaded the match: void. */
  | 'no-start';

export interface MatchResult {
  /** Made by the host; the same on both pages. */
  matchId: string;
  /** This page's player id. */
  self: string;
  /** By slot: 0 is the host. `fighter` and `avatar` are fighter ids. */
  players: { id: string; name: string; avatar: string; fighter: string }[];
  /** The winner's player id, or null (void, draw). */
  winner: string | null;
  reason: EndReason;
  /** The stage id (content/stages.json). */
  stage: string;
  /** Sim frames played (60 a second). */
  frames: number;
  /** Wall-clock ms from Go! to the end. */
  durationMs: number;
  /** ISO time on this page's clock. */
  endedAt: string;
  /** Stocks left by slot. */
  stocks: number[];
}

const listeners = new Set<(r: MatchResult) => void>();

export function onMatchResult(fn: (r: MatchResult) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitMatchResult(r: MatchResult): void {
  console.info(`[dod-online] match result ${JSON.stringify(r)}`);
  for (const fn of listeners) fn(r);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dod:match-result', { detail: r }));
}
