// Tour endings (docs/story.md "Endings"): per fighter one painted picture, two caption lines and a narration take (the
// second line, Blog Man's voice). Data is content/endings.json, written by tools/endings.mjs. Unlocked by clearing that
// fighter's Tour (`dod-tours`); The Mechanic has no Tour of his own, so his ending is the show's last: every other Tour cleared.

import endingsJson from '../../../content/endings.json' with { type: 'json' };
import { TOURS } from './tour.ts';

export interface Ending {
  fighter: string;
  /** The 1920x1080 illustration. */
  art: string;
  /** Caption one (silent), caption two (voiced). */
  lines: [string, string];
  audio?: string;
}

export const ENDINGS = endingsJson as Ending[];
export const MECHANIC = 'the-mechanic';

export const endingFor = (fighter: string): Ending | undefined => ENDINGS.find((e) => e.fighter === fighter);

/** Whether a fighter's ending is open, given the cleared Tours. */
export function endingUnlocked(fighter: string, cleared: ReadonlySet<string>): boolean {
  if (fighter === MECHANIC) return TOURS.every((t) => cleared.has(t.fighter));
  return cleared.has(fighter);
}

/** The ending's beats in ms: art in, caption one, caption two with the voice, the fighter's sting, the card, the end. */
export const ENDING_BEATS = { caption1: 900, caption2: 4600, sting: 9000, card: 9400, end: 13600 } as const;
