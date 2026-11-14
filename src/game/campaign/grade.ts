// Episode grades (docs/story.md "Grades"): a won episode earns 1 to 3 stars. Pure maths, no DOM, so the sim tests,
// the results screen and the map all read the same rules.
//   1 star:  clear it.
//   2 stars: clear it without losing a stock.
//   3 stars: also beat the episode's par time (`par`, seconds, in content/campaign.json).
// A 'survive' episode runs the whole clock whatever you do, so its third star asks for a clean night instead:
// no stock lost and under PAR_DAMAGE taken. Counting objectives (KOs, quota, streak) end the moment they are met,
// so their par time is a real race against their own clock.

export type Stars = 0 | 1 | 2 | 3;

/** Percent of damage a 'survive' episode may cost for its third star. */
export const PAR_DAMAGE = 100;

export interface GradeInput {
  won: boolean;
  objective?: string;
  /** Stocks the player began with and ended with. */
  stocksStart: number;
  stocksLeft: number;
  /** Sim frames at 60 per second. */
  frames: number;
  /** Damage the player took, in percent. */
  damageTaken: number;
  /** The episode's par time in seconds (content/campaign.json `par`). */
  par: number;
}

export interface Grade {
  stars: Stars;
  /** Each star's test, for the results screen: label, whether this run met it. */
  steps: { label: string; met: boolean }[];
  /** What the third star needs, as a short label. */
  parLabel: string;
}

export function parLabel(objective: string | undefined, par: number): string {
  if (objective === 'survive') return `Under ${PAR_DAMAGE}% damage taken`;
  return `Under ${Math.floor(par / 60)}:${String(Math.round(par % 60)).padStart(2, '0')}`;
}

export function gradeEpisode(g: GradeInput): Grade {
  const clean = g.won && g.stocksLeft >= g.stocksStart;
  const fast = g.objective === 'survive' ? clean && g.damageTaken < PAR_DAMAGE : clean && g.frames / 60 <= g.par;
  const steps = [
    { label: 'Clear it', met: g.won },
    { label: 'No stock lost', met: clean },
    { label: parLabel(g.objective, g.par), met: fast },
  ];
  const stars = (g.won ? (fast ? 3 : clean ? 2 : 1) : 0) as Stars;
  return { stars, steps, parLabel: steps[2].label };
}

/** Best of two grades (a worse replay never lowers it). */
export function bestStars(a: number | undefined, b: number): Stars {
  return Math.max(a ?? 0, b) as Stars;
}

// ------------------------------------------------------------------ score
// A won episode's score, from the pieces the results screen already shows: KOs, damage dealt, damage taken and time.
//   1000 for clearing, +500 per KO, +5 per % dealt, -3 per % taken, +10 per second under twice the par time.
// Never under 0. Whole numbers only, so the same fight always scores the same.

export const SCORE_CLEAR = 1000;
export const SCORE_KO = 500;
export const SCORE_DEALT = 5;
export const SCORE_TAKEN = 3;
export const SCORE_SECOND = 10;

export interface ScoreInput {
  kos: number;
  /** Damage dealt and taken by the player, in percent. */
  dealt: number;
  taken: number;
  /** Sim frames at 60 per second. */
  frames: number;
  par: number;
}

export interface Score {
  total: number;
  /** Each part's points, for the results card. */
  parts: { key: 'clear' | 'kos' | 'dealt' | 'taken' | 'time'; label: string; points: number }[];
}

export function scoreEpisode(s: ScoreInput): Score {
  const secs = s.frames / 60;
  const parts: Score['parts'] = [
    { key: 'clear', label: 'Cleared', points: SCORE_CLEAR },
    { key: 'kos', label: `${s.kos} KO${s.kos === 1 ? '' : 's'}`, points: s.kos * SCORE_KO },
    { key: 'dealt', label: `${Math.round(s.dealt)}% dealt`, points: Math.round(s.dealt) * SCORE_DEALT },
    { key: 'taken', label: `${Math.round(s.taken)}% taken`, points: -Math.round(s.taken) * SCORE_TAKEN },
    { key: 'time', label: 'Time bonus', points: Math.max(0, Math.round(s.par * 2 - secs)) * SCORE_SECOND },
  ];
  return { total: Math.max(0, parts.reduce((n, p) => n + p.points, 0)), parts };
}

/** What an episode's best remembers: its top score and its fastest win (sim frames). */
export interface Best {
  score: number;
  frames: number;
}

/** Folds a run into a best: higher score, lower time, each on its own. `beat` names what this run improved (only when there was a best before). */
export function mergeBest(prev: Best | undefined, run: Best): { best: Best; beat: ('score' | 'time')[] } {
  if (!prev) return { best: { ...run }, beat: [] };
  const beat: ('score' | 'time')[] = [];
  if (run.score > prev.score) beat.push('score');
  if (run.frames < prev.frames) beat.push('time');
  return { best: { score: Math.max(prev.score, run.score), frames: Math.min(prev.frames, run.frames) }, beat };
}
