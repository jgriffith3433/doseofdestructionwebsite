// Future Man talks during the fight (docs/world-bible.md "The first bout"): he has seen how it ends, so what he says
// answers what just happened, not a script. Pure: the match events go in, a line (or nothing) comes out.
// Triggers: he lands a hit, he is hit, the other fighter grabs the ledge. One line at a time, never the same line twice
// in a row, and 6 s between lines (a taunt that talks over every hit stops being a taunt).

export type TauntKind = 'hit' | 'hurt' | 'ledge';

export interface Taunt {
  id: string;
  kind: TauntKind;
  /** At most 10 words (the studio's caption rule). */
  text: string;
}

export const FUTURE_TAUNTS: Taunt[] = [
  { id: 'taunt.future-man.hit.0', kind: 'hit', text: 'Left jab. I counted that one.' },
  { id: 'taunt.future-man.hit.1', kind: 'hit', text: 'You blinked. I did not.' },
  { id: 'taunt.future-man.hit.2', kind: 'hit', text: 'Seen it. It still lands.' },
  { id: 'taunt.future-man.hurt.0', kind: 'hurt', text: 'Yes. I felt that coming.' },
  { id: 'taunt.future-man.hurt.1', kind: 'hurt', text: 'Spoiler: that one hurts.' },
  { id: 'taunt.future-man.hurt.2', kind: 'hurt', text: 'Expected. Still rude.' },
  { id: 'taunt.future-man.ledge.0', kind: 'ledge', text: 'Nice ledge. Hold it. Four seconds.' },
  { id: 'taunt.future-man.ledge.1', kind: 'ledge', text: 'Hanging on? I saw how this ends.' },
  { id: 'taunt.future-man.ledge.2', kind: 'ledge', text: 'Climb or drop. I know which.' },
];

export const TAUNT_GAP_FRAMES = 360;
/** A hit lighter than this (tenths of a percent) is not worth a line. */
export const TAUNT_MIN_DMG = 40;

export interface TauntEvent {
  type: string;
  attacker?: number;
  victim?: number;
  id?: number;
  dmg?: number;
  shield?: boolean;
}

export class FutureTaunts {
  private lastFrame = -TAUNT_GAP_FRAMES;
  private lastId = '';
  private counts: Record<TauntKind, number> = { hit: 0, hurt: 0, ledge: 0 };

  /** `me` is Future Man's fighter index, `frame` the sim frame. Returns the taunt to say, or null. */
  react(e: TauntEvent, me: number, frame: number): Taunt | null {
    if (frame - this.lastFrame < TAUNT_GAP_FRAMES) return null;
    let kind: TauntKind | null = null;
    if (e.type === 'hit' && !e.shield && (e.dmg ?? 0) >= TAUNT_MIN_DMG) {
      if (e.attacker === me && e.victim !== me) kind = 'hit';
      else if (e.victim === me && e.attacker !== me) kind = 'hurt';
    } else if (e.type === 'ledge' && e.id !== undefined && e.id !== me) kind = 'ledge';
    if (!kind) return null;
    const pool = FUTURE_TAUNTS.filter((t) => t.kind === kind);
    let t = pool[this.counts[kind]++ % pool.length];
    if (t.id === this.lastId) t = pool[this.counts[kind]++ % pool.length];
    this.lastFrame = frame;
    this.lastId = t.id;
    return t;
  }
}
