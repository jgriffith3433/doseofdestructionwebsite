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
  /** The season it airs in (content/campaign.json `season`, 1 when left out). */
  season: number;
  title: string;
  /** One line on the chapter map. */
  tagline: string;
  /** What the fight asks of the player, shown before it starts. */
  hint: string;
  /** The fighter id this chapter unlocks for Versus and online when it is cleared (docs/story.md, "Unlocks"). */
  unlock?: string;
  intro: Line[];
  outro: Line[];
  fight: MatchSetup;
}

/** A chapter as written in content/campaign.json, with fighters and stages by id. */
export interface ChapterEntry extends Omit<Chapter, 'fight' | 'season'> {
  season?: number;
  fight: Omit<MatchSetup, 'mode' | 'stage' | 'slots'> & {
    stage: string;
    slots: (Omit<SlotSetup, 'char'> & { char: string })[];
  };
}

// The campaign is authored in content/campaign.json (the Voice tab in
// devtools.html edits its lines).
export const CHAPTER_ENTRIES = campaignJson as ChapterEntry[];

// In season order (a stable sort, so chapters keep their file order within a
// season): the map, the unlocks and the playtest all walk this list.
export const CHAPTERS: Chapter[] = CHAPTER_ENTRIES.map((c): Chapter => ({
  ...c,
  season: c.season ?? 1,
  fight: {
    ...c.fight,
    mode: 'campaign',
    stage: stageIndex(c.fight.stage),
    slots: c.fight.slots.map((s) => ({ ...s, char: characterIndex(s.char) })),
  },
})).sort((a, b) => a.season - b.season);

export interface Season {
  number: number;
  /** Under the "Season N" heading on the map. */
  subtitle: string;
  /** Shown under the season once every chapter in it is cleared. */
  end: string;
  chapters: Chapter[];
}

/** The map's words for each season (docs/story.md). A season with no entry here still shows, with defaults. */
const SEASON_TEXT: Record<number, { subtitle: string; end: string }> = {
  1: { subtitle: 'Open Mic to Encore', end: 'Season 1 cleared. The card is yours now.' },
  2: { subtitle: 'The card is yours', end: 'Four walk-ons. Four defenses. The card is still his.' },
  3: { subtitle: 'The Orchestrator Returns', end: 'He signed the sheet. He took the baton. The show goes on.' },
  4: { subtitle: 'The Rival Broadcast', end: 'Two networks. One card. The show is still his.' },
};

/** The seasons that have chapters, in order. */
export const SEASONS: Season[] = [...new Set(CHAPTERS.map((c) => c.season))].map((n) => ({
  number: n,
  subtitle: SEASON_TEXT[n]?.subtitle ?? '',
  end: SEASON_TEXT[n]?.end ?? `Season ${n} cleared.`,
  chapters: CHAPTERS.filter((c) => c.season === n),
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

/**
 * A chapter is open once every chapter before it is done: the ones before it in
 * its season, and every chapter of the seasons before (CHAPTERS is in season order).
 */
export function isOpen(index: number, done: Set<string>): boolean {
  return CHAPTERS.slice(0, index).every((c) => done.has(c.id));
}

/** A season is open once every season before it is cleared. */
export function seasonOpen(season: number, done: Set<string>): boolean {
  return CHAPTERS.every((c) => c.season >= season || done.has(c.id));
}

/** Every chapter of the season is cleared. */
export function seasonCleared(season: number, done: Set<string>): boolean {
  return CHAPTERS.every((c) => c.season !== season || done.has(c.id));
}

// ------------------------------------------------------------------ unlocks
// Heroes join the card as the campaign clears them. A fighter named by some chapter's `unlock` is locked in Versus
// and online until that chapter is cleared; every other fighter is open from the start. Campaign walk-ons, training
// and the CPU's own picks are not gated, and Exit Punk is the campaign player whatever is unlocked.

const UNLOCK_KEY = 'dod-unlocks';

/** Fighter ids some chapter unlocks: locked on a fresh save. */
export const LOCKABLE: ReadonlySet<string> = new Set(CHAPTERS.flatMap((c) => (c.unlock ? [c.unlock] : [])));

/** The fighters unlocked: the saved store (dod-unlocks) plus those of every chapter already cleared (older saves). */
export function loadUnlocks(done: Set<string> = loadProgress()): Set<string> {
  const out = new Set<string>();
  try {
    const saved = JSON.parse(localStorage.getItem(UNLOCK_KEY) ?? '[]');
    if (Array.isArray(saved)) for (const s of saved) if (typeof s === 'string') out.add(s);
  } catch {
    // Unreadable storage: only what the cleared chapters give.
  }
  for (const c of CHAPTERS) if (c.unlock && done.has(c.id)) out.add(c.unlock);
  return out;
}

export function saveUnlocks(unlocked: Set<string>): void {
  try {
    localStorage.setItem(UNLOCK_KEY, JSON.stringify([...unlocked]));
  } catch {
    // Storage can be blocked; unlocks then last only for this visit (the cleared chapters give them back).
  }
}

/** The one rule for who may be picked in Versus and online (select, the profile picture and the online setup). */
export function fighterOpen(id: string, unlocked: ReadonlySet<string>): boolean {
  return !LOCKABLE.has(id) || unlocked.has(id);
}

/** The live set, shared by the screens (loaded on first use). */
let live: Set<string> | null = null;
export function unlocks(): Set<string> {
  return (live ??= loadUnlocks());
}
export function isUnlocked(id: string): boolean {
  return fighterOpen(id, unlocks());
}

/** Clearing a chapter: unlocks its fighter (kept) and returns the fighter id when it is new, else null. */
export function unlockFor(chapter: Chapter, unlocked: Set<string> = unlocks()): string | null {
  if (!chapter.unlock || unlocked.has(chapter.unlock)) return null;
  unlocked.add(chapter.unlock);
  saveUnlocks(unlocked);
  return chapter.unlock;
}
