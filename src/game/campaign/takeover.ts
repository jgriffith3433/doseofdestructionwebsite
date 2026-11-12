// The finale takeover (docs/story.md "The finale hijack"): in each of the ten season finales the Orchestrator seizes the
// broadcast mid-fight. The sim owns when it fires and the rule it rewrites (sim/step.ts `broadcastEvents`); this is the
// render side: which recorded lines he says for the state the sim reports, and the HUD wording of the rule.
// The lines are in content/voice.json as `orchestrator.takeover.*` (recorded in his own voice through Hawkes Gen).

import type { TakeoverRule } from '../sim/state.ts';

/** How many takes each shared pool has (test/takeover.test.ts checks content/voice.json against these). */
export const POOL = { seize: 7, ahead: 5, behind: 5, hot: 3 } as const;

export interface TakeoverLines {
  /** Line ids in the order he says them: an opener (the seize, or the hot call when the player is over 100%), the reaction to the fight, then the rule. */
  ids: string[];
}

/**
 * The lines for a finale. `season` (1 to 10) staggers the shared pools so no two finales open and react the same;
 * `mood` is the sim's playerMood (1 ahead, -1 behind) and `hot` whether the player is over 100%.
 */
export function takeoverLines(season: number, chapterId: string, mood: number, hot: boolean, withRule: boolean): TakeoverLines {
  const n = Math.max(0, season - 1);
  const ids = [
    hot ? `orchestrator.takeover.hot.${n % POOL.hot}` : `orchestrator.takeover.seize.${n % POOL.seize}`,
    mood < 0 ? `orchestrator.takeover.behind.${n % POOL.behind}` : `orchestrator.takeover.ahead.${n % POOL.ahead}`,
  ];
  if (withRule) ids.push(`orchestrator.takeover.rule.${chapterId}`);
  return { ids };
}

/** The rule as the HUD chip reads it (a few words, upper case). */
export function ruleLabel(r: TakeoverRule): string {
  const parts: string[] = [];
  if (r.gravity !== undefined) parts.push(`GRAVITY ${r.gravity}%`);
  if (r.giant) parts.push(r.giant === 'player' ? 'YOU: GIANT' : 'HOST: GIANT');
  if (r.hazard) parts.push('RIG LIGHT: LIVE');
  if (r.startPercent !== undefined) parts.push(`START AT ${Math.round(r.startPercent / 10)}%`);
  return parts.join(' · ');
}
