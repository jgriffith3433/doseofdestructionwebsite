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
