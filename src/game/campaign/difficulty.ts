// Campaign difficulty (docs/story.md "Producer's notes: Easy, Normal, Hard"): chosen on the season map, applied to every
// episode's fight when it starts. Pure maths and the two saved bits (the pick, and the run of losses on one episode).

import type { MatchSetup } from '../match.ts';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
/** One line under the picker: what the producer changes. */
export const DIFFICULTY_NOTE: Record<Difficulty, string> = {
  easy: 'Foes play two levels softer and start the fight at 30%.',
  normal: 'The show as written.',
  hard: 'Foes play a level sharper and you start the fight at 20%.',
};

/** CPU level change per difficulty (clamped to 1-9). */
export const CPU_DELTA: Record<Difficulty, number> = { easy: -2, normal: 0, hard: 1 };
/** Starting damage in tenths of a percent (the sim's unit): Easy hurts the foe, Hard hurts you. */
export const FOE_START: Record<Difficulty, number> = { easy: 300, normal: 0, hard: 0 };
export const PLAYER_START: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 200 };

/** Losses in a row on one episode before the results offer Easy. */
export const OFFER_AFTER = 3;

export const DIFFICULTY_KEY = 'dod-difficulty';
const LOSSES_KEY = 'dod-campaign-losses';
const EASY_KEY = 'dod-campaign-easy';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the choice then lasts only for this visit.
  }
}

let live: Difficulty | null = null;
export function difficulty(): Difficulty {
  if (live) return live;
  const saved = read<string>(DIFFICULTY_KEY, 'normal');
  return (live = DIFFICULTIES.includes(saved as Difficulty) ? (saved as Difficulty) : 'normal');
}
export function setDifficulty(d: Difficulty): void {
  live = d;
  write(DIFFICULTY_KEY, d);
}
/** Playtest setup shortcut: forget the in-memory pick so storage is read again. */
export function reloadDifficulty(): void {
  live = null;
}

/** A foe is a CPU on a team other than the player's. */
function isFoe(s: MatchSetup['slots'][number], player: MatchSetup['slots'][number] | undefined): boolean {
  return s.cpu !== null && s.cpu > 0 && !s.remote && (s.team ?? -1) !== (player?.team ?? -2);
}

/** The foes' CPU levels in a setup, in slot order. */
export function foeLevels(setup: MatchSetup): number[] {
  const player = setup.slots.find((s) => s.cpu === null);
  return setup.slots.filter((s) => isFoe(s, player)).map((s) => s.cpu as number);
}

/** The setup with a difficulty applied: foes' CPU level shifted (1-9), start damage on the foe (Easy) or the player (Hard). */
export function withDifficulty(setup: MatchSetup, d: Difficulty): MatchSetup {
  if (d === 'normal') return setup;
  const player = setup.slots.find((s) => s.cpu === null);
  return {
    ...setup,
    slots: setup.slots.map((s) => {
      if (s === player) return PLAYER_START[d] ? { ...s, startPercent: (s.startPercent ?? 0) + PLAYER_START[d] } : s;
      if (!isFoe(s, player)) return s;
      const cpu = Math.max(1, Math.min(9, (s.cpu as number) + CPU_DELTA[d]));
      return { ...s, cpu, startPercent: (s.startPercent ?? 0) + FOE_START[d] || undefined };
    }),
  };
}

// ------------------------------------------------------------------ the run of losses

/** After a loss: how many in a row on this episode (a loss elsewhere starts the count again). */
export function recordLoss(chapterId: string): number {
  const prev = read<{ id?: string; n?: number }>(LOSSES_KEY, {});
  const n = prev.id === chapterId ? (prev.n ?? 0) + 1 : 1;
  write(LOSSES_KEY, { id: chapterId, n });
  return n;
}
export function clearLosses(): void {
  write(LOSSES_KEY, {});
}
export function lossesOn(chapterId: string): number {
  const prev = read<{ id?: string; n?: number }>(LOSSES_KEY, {});
  return prev.id === chapterId ? (prev.n ?? 0) : 0;
}
/** The results offer Easy: enough losses in a row and not already on Easy. */
export function offerEasy(chapterId: string, d: Difficulty = difficulty()): boolean {
  return d !== 'easy' && lossesOn(chapterId) >= OFFER_AFTER;
}

// ------------------------------------------------------------------ the Easy badge

/** Episodes whose latest clear was on Easy (stars still count; the map marks them). */
export function easyCleared(): Set<string> {
  const saved = read<unknown>(EASY_KEY, []);
  return new Set(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : []);
}
export function markCleared(chapterId: string, d: Difficulty): void {
  const set = easyCleared();
  if (d === 'easy') set.add(chapterId);
  else set.delete(chapterId);
  write(EASY_KEY, [...set]);
}
