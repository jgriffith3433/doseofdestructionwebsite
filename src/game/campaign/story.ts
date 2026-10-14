// The campaign: a walk-on fighter works their way through a nightly broadcast
// run by the Orchestrator. Each chapter is a scene, a fight with its own
// rules, and a scene after.

import { characterIndex } from '../sim/characters.ts';
import { stageIndex } from '../sim/stage.ts';
import type { MatchSetup, SlotSetup } from '../match.ts';
import campaignJson from '../../../content/campaign.json' with { type: 'json' };

export interface Line {
  /** A character id, or 'narrator'. */
  who: string;
  text: string;
  /** A recorded take of the line, under /audio/voice/. */
  audio?: string;
  /** What the take was recorded from, so devtools can tell when it is out of date. */
  take?: { text: string; voice: string };
}

export interface Chapter {
  id: string;
  title: string;
  /** One line on the chapter map. */
  tagline: string;
  /** What the fight asks of the player, shown before it starts. */
  hint: string;
  intro: Line[];
  outro: Line[];
  fight: MatchSetup;
}

/** A chapter as written in content/campaign.json, with fighters and stages by id. */
export interface ChapterEntry extends Omit<Chapter, 'fight'> {
  fight: Omit<MatchSetup, 'mode' | 'stage' | 'slots'> & {
    stage: string;
    slots: (Omit<SlotSetup, 'char'> & { char: string })[];
  };
}

// The campaign is authored in content/campaign.json (the Voice tab in
// devtools.html edits its lines).
export const CHAPTER_ENTRIES = campaignJson as ChapterEntry[];

export const CHAPTERS: Chapter[] = CHAPTER_ENTRIES.map((c) => ({
  ...c,
  fight: {
    ...c.fight,
    mode: 'campaign',
    stage: stageIndex(c.fight.stage),
    slots: c.fight.slots.map((s) => ({ ...s, char: characterIndex(s.char) })),
  },
}));

const KEY = 'dod-campaign';

export function loadProgress(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveProgress(done: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    // Storage can be blocked; progress then lasts only for this visit.
  }
}

/** A chapter is open once every chapter before it is done. */
export function isOpen(index: number, done: Set<string>): boolean {
  return CHAPTERS.slice(0, index).every((c) => done.has(c.id));
}
