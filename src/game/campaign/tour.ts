// Tour: pick an open fighter and play their own six-fight run (content/tours.json, written per fighter from their blurb and
// docs/story.md). Fights 2 to 5 use the rule twists the campaign already has (a giant, two on one, low gravity, a timed KO
// race), the CPU rises with every fight, and the sixth is the fighter's rival on the Foundry floor. Between fights the foe
// speaks in the arena (an existing voiced line, played by ui/scene.ts); the last win plays the fighter's own win line over
// the final KO under the closing card "<Fighter> clears the Tour". Cleared Tours live in localStorage `dod-tours`.
// Everything here is pure data and storage; the screens are ui/tour.ts and the flow is main.ts.

import { CHARACTERS, characterIndex } from '../sim/characters.ts';
import { stageIndex } from '../sim/stage.ts';
import type { MatchSetup, SlotSetup } from '../match.ts';
import type { SceneCard, SceneLine } from '../ui/scene.ts';
import toursJson from '../../../content/tours.json' with { type: 'json' };

export type TourTwist = 'plain' | 'giant' | 'two' | 'low' | 'race' | 'rival';

export interface TourFight {
  twist: TourTwist;
  /** Fighter ids across from the player (two for "two on one"). */
  foes: string[];
  stage: string;
  /** The CPU level of every foe. */
  cpu: number;
  /** The player's stocks and each foe's. */
  stocks: number;
  foeStocks: number;
  /** Giant: the foe's size in percent. */
  scale?: number;
  /** Low gravity: percent of normal. */
  gravity?: number;
  /** KO race: the KOs to score, the clock (frames) and the damage the foe starts every life with (tenths of a percent). */
  kos?: number;
  timeLimit?: number;
  foeStart?: number;
  /** The story card: title (the twist's name) and one short line. */
  title: string;
  line: string;
}

export interface Tour {
  fighter: string;
  /** The route's name, shown on the Tour select tile. */
  title: string;
  /** The rival (the last fight's foe). */
  rival: string;
  /** The closing card's line under "<Fighter> clears the Tour". */
  ending: string;
  fights: TourFight[];
}

export const TOURS = toursJson as Tour[];
export const TOUR_LENGTH = 6;

export const tourFor = (fighter: string): Tour | undefined => TOURS.find((t) => t.fighter === fighter);

const nameOf = (id: string): string => CHARACTERS.find((c) => c.id === id)?.name ?? id;

/** What each twist says in one short line (the tile, the card and the VS screen). */
export const TWIST_RULE: Record<TourTwist, string> = {
  plain: 'A straight fight',
  giant: 'A giant across from you',
  two: 'Two on one, one stock each',
  low: 'Low gravity',
  race: '3 KOs before the clock',
  rival: 'Your rival, on the Foundry floor',
};

/** The fight as a campaign-style match: you (team 0) against its foes (team 1), with the twist applied. */
export function tourSetup(tour: Tour, index: number): MatchSetup {
  const f = tour.fights[index];
  const slots: SlotSetup[] = [{ char: characterIndex(tour.fighter), cpu: null, team: 0, stocks: f.stocks }];
  f.foes.forEach((id, i) => {
    const s: SlotSetup = { char: characterIndex(id), cpu: f.cpu, team: 1, stocks: f.foeStocks };
    if (f.scale && i === 0) s.scale = f.scale;
    if (f.foeStart) s.startPercent = f.foeStart;
    slots.push(s);
  });
  const rules: MatchSetup['rules'] = {};
  if (f.gravity) rules.gravity = f.gravity;
  if (f.timeLimit) rules.timeLimit = f.timeLimit;
  return {
    mode: 'campaign',
    stage: stageIndex(f.stage),
    stocks: f.stocks,
    rules,
    ...(f.kos ? { objective: 'ko' as const, kos: f.kos } : {}),
    slots,
    title: `${nameOf(tour.fighter)} · Tour · Fight ${index + 1} of ${tour.fights.length}`,
    subtitle: TWIST_RULE[f.twist],
  };
}

/** The line a fighter speaks before a fight: their taunt where they have one, else their win line (both recorded). */
export function boastIds(id: string): string[] {
  return [`fighter.${id}.taunt`, `fighter.${id}.win`];
}

export interface VoiceLookup {
  (id: string): { text: string; audio?: string | null } | undefined;
}

/** The between-fights scene under the fight's card: each foe says their recorded line in the arena, the fighter answers, and (fights 2 to 5) the rival heckles. */
export function tourIntro(tour: Tour, index: number, voice: VoiceLookup): { lines: SceneLine[]; card: SceneCard } {
  const f = tour.fights[index];
  const lines: SceneLine[] = [];
  for (const id of f.foes) {
    const v = boastIds(id).map(voice).find((x) => x?.audio);
    if (v) lines.push({ who: id, text: v.text, audio: v.audio });
  }
  // The fighter answers with their own recorded taunt where they have one (thirteen of them do).
  const me = voice(`fighter.${tour.fighter}.taunt`);
  if (me?.audio) lines.push({ who: tour.fighter, text: me.text, audio: me.audio });
  // The rival is a thread through the run: in fights 2 to 5 they heckle from off the stage (their head shows by the line).
  if (index >= 1 && index < tour.fights.length - 1) {
    const r = [`fighter.${tour.rival}.win`, `fighter.${tour.rival}.taunt`].map(voice).find((x) => x?.audio);
    if (r) lines.push({ who: tour.rival, text: r.text, audio: r.audio });
  }
  return {
    lines,
    card: {
      kicker: `${nameOf(tour.fighter)} · Tour · Fight ${index + 1} of ${tour.fights.length}`,
      title: f.title,
      line: f.line,
    },
  };
}

/** The ending: the fighter's own recorded win line over the final KO, and the closing card. */
export function tourEnding(tour: Tour, voice: VoiceLookup): { lines: SceneLine[]; card: SceneCard } {
  const v = voice(`fighter.${tour.fighter}.win`);
  return {
    lines: v ? [{ who: tour.fighter, text: v.text, audio: v.audio }] : [],
    card: { kicker: 'Tour cleared', title: `${nameOf(tour.fighter)} clears the Tour`, line: tour.ending },
  };
}

// ------------------------------------------------------------------ storage

export const TOURS_KEY = 'dod-tours';

/** The fighter ids whose Tour is cleared on this device. */
export function loadTours(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(TOURS_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Marks a Tour cleared (kept); returns true the first time. */
export function markTourCleared(fighter: string): boolean {
  const done = loadTours();
  const first = !done.has(fighter);
  done.add(fighter);
  try {
    localStorage.setItem(TOURS_KEY, JSON.stringify([...done]));
  } catch {
    // Storage can be blocked; the mark then lasts only for this visit.
  }
  return first;
}
