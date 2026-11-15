// Playstyle profiles for the CPU (docs/story.md "How the CPU fights"). Every fighter has one: derived from its
// own numbers (speed, weight, jumps, hit tuning) and the archetypes of its four specials, unless
// content/fighters.json gives it a `playstyle` of its own. A profile only weights what the bot chooses: how
// far it likes to stand from you, how hard it comes in, how often it grabs, throws projectiles and traps, and
// goes into the air. It never touches the sim, so online and replays are unchanged.

import { CHARACTERS, FIGHTERS, MOVE, type SpecialKind } from '../sim/characters.ts';
import { FX } from '../sim/fixed.ts';

export type PlaystyleId = 'rushdown' | 'zoner' | 'grappler' | 'aerial' | 'bruiser';
export const PLAYSTYLES: PlaystyleId[] = ['rushdown', 'zoner', 'grappler', 'aerial', 'bruiser'];

export interface Playstyle {
  id: PlaystyleId;
  /** The gap it likes to keep, in reach lengths of its own jab: under 1 it walks into your face, over 2 it backs off to keep room. */
  spacing: number;
  /** 0-1.5: how often it commits to a dash, hop-in or walk-in rather than waiting for you. */
  aggression: number;
  /** Multiplies every grab chance (the plain grab, a grab special, grabbing a shield). */
  grab: number;
  /** Multiplies every projectile and trap chance. */
  projectile: number;
  /** Multiplies how often it hops in and swings aerials rather than walking. */
  air: number;
  /** Multiplies the chance to reach for a smash instead of a quick jab or tilt. */
  smash: number;
}

export const PLAYSTYLE: Record<PlaystyleId, Playstyle> = {
  rushdown: { id: 'rushdown', spacing: 0.6, aggression: 1.4, grab: 0.9, projectile: 0.3, air: 1, smash: 0.7 },
  zoner: { id: 'zoner', spacing: 3.4, aggression: 0.3, grab: 0.3, projectile: 2, air: 0.6, smash: 0.7 },
  grappler: { id: 'grappler', spacing: 0.7, aggression: 1.1, grab: 5, projectile: 0.3, air: 0.2, smash: 1 },
  aerial: { id: 'aerial', spacing: 1.4, aggression: 1, grab: 0.2, projectile: 1, air: 3, smash: 0.6 },
  bruiser: { id: 'bruiser', spacing: 0.9, aggression: 0.9, grab: 1.1, projectile: 0.5, air: 0.4, smash: 1.8 },
};

/** The archetype of each of a fighter's neutral, side and down specials (the up special is a recovery for everyone). */
function kinds(char: number): SpecialKind[] {
  const ch = CHARACTERS[char];
  if (!ch.specials) return [];
  return [MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.DSPECIAL].map((m) => ch.moves[m].kind).filter((k): k is SpecialKind => !!k);
}

/** Scores each style from the fighter's numbers and kit; the highest wins (ties go to the order of PLAYSTYLES). */
export function scoreStyles(char: number): Record<PlaystyleId, number> {
  const ch = CHARACTERS[char];
  const k = kinds(char);
  const has = (...a: SpecialKind[]) => k.filter((x) => a.includes(x)).length;
  const walk = ch.walkSpeed / FX;
  const air = ch.airSpeed / FX;
  const heavy = (ch.weight - 100) / 20;
  const hits = (ch.tuning.damage - 1) * 6 + (ch.tuning.knockback - 1) * 6;
  const quick = (1 - ch.tuning.frames) * 6;
  return {
    rushdown: (walk - 7) * 0.8 + quick + has('dash', 'flurry') * 1.2 - heavy * 0.5,
    zoner: has('projectile') * 1.5 + has('trap') * 0.8 + (ch.tuning.reach - 1) * 4 - (walk - 7) * 0.2 - 1.2 - heavy * 0.4,
    grappler: has('grab') * 1.4 + has('counter') * 0.4 + heavy * 0.5 + (ch.tuning.reach < 1 ? 0.5 : 0),
    aerial: (ch.airJumps - 1) * 1.6 + (air - 5.5) * 0.9 - (ch.gravity / FX - 0.7) * 3,
    bruiser: heavy * 1.2 + hits + (walk < 7 ? 0.5 : 0) + has('flurry', 'counter') * 0.3 - has('projectile') * 0.5,
  };
}

/** The style a fighter gets from its numbers alone (no content override). */
export function derivedStyle(char: number): PlaystyleId {
  const s = scoreStyles(char);
  return PLAYSTYLES.reduce((best, id) => (s[id] > s[best] ? id : best), PLAYSTYLES[0]);
}

/** The playstyle id of a fighter: its `playstyle` in content/fighters.json, else the derived one. */
export function styleId(char: number): PlaystyleId {
  const own = (FIGHTERS[char] as { playstyle?: string } | undefined)?.playstyle;
  return own && (PLAYSTYLES as string[]).includes(own) ? (own as PlaystyleId) : derivedStyle(char);
}

export function profileFor(char: number): Playstyle {
  return PLAYSTYLE[styleId(char)];
}
