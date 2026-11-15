// The episode highlight (docs/story.md "Previously and Next time"): the sim is deterministic, so the last seconds of an
// episode's final KO are stored as a start snapshot plus the inputs of every tick after it (never video), and played
// back through the same sim. The recorder lives on the Match (campaign only); the highlight of the last won episode is
// kept in the save (`dod-highlight`) so the next episode can open on "Previously on...". Pure apart from the storage
// calls, so `npm test` checks it (test/highlight.test.ts).

import { CHARACTERS } from '../sim/characters.ts';
import { NO_INPUT } from '../sim/input.ts';
import { STAGES } from '../sim/stage.ts';
import { cloneState, type GameState } from '../sim/state.ts';
import { step, type SimEvent } from '../sim/step.ts';
import { CHAPTERS } from './story.ts';

/** A snapshot every this many ticks; the recorder keeps KEEP_TICKS of them and of inputs (8 s, more than the 4 s window). */
export const SNAP_EVERY = 30;
export const KEEP_TICKS = 480;
/** The window that is kept: the last 4 s before the final KO. */
export const WINDOW_TICKS = 240;

/** The 3 s replay: lead-in at full speed, the final hit at 25%, then the launch at full speed. In ticks of the sim. */
export const REPLAY = {
  /** Ticks played before the slow part. */
  lead: 24,
  /** The slow part starts this many ticks before the final hit lands. */
  slowBefore: 4,
  /** How many ticks play slowed. */
  slowTicks: 28,
  /** Ticks played after the slow part, at full speed. */
  tail: 44,
  slow: 0.25,
} as const;

/** Real time the replay takes, ms: the full-speed ticks at 60 Hz plus the slow part at a quarter speed (about 2.5 s). */
export const REPLAY_MS = Math.round(((REPLAY.lead + REPLAY.tail - REPLAY.slowTicks) / 60 + REPLAY.slowTicks / 60 / REPLAY.slow) * 1000);

export interface Highlight {
  v: 1;
  /** The episode this KO ended. */
  chapter: string;
  /** Stage and fighters by id (the sim state holds indexes), so a changed roster drops a stale save. */
  stage: string;
  chars: string[];
  looks: number[];
  /** The sim state at tick `from`. */
  start: GameState;
  from: number;
  /** Inputs of every fighter for the ticks from, from + 1, ... */
  inputs: number[][];
  /** Ticks (same numbering as from) of the final hit and of the KO. */
  hit: number;
  ko: number;
  victim: number;
  by: number;
}

const KEY = 'dod-highlight';

export class HighlightRecorder {
  /** Ticks recorded so far (the tick the next record() is). */
  private n = 0;
  private firstTick = 0;
  private inputs: number[][] = [];
  private snaps: { tick: number; state: GameState }[] = [];
  /** Per victim: the tick of the last hit that landed on them. */
  private lastHitOn: number[] = [];
  private lastHit: { tick: number; victim: number; attacker: number } | null = null;
  private lastKo: { tick: number; victim: number; by: number } | null = null;

  /** Call before each step with the state and the inputs that step will use. */
  record(s: GameState, inputs: readonly number[]): void {
    if (this.n % SNAP_EVERY === 0) this.snaps.push({ tick: this.n, state: cloneState(s) });
    this.inputs.push(inputs.slice());
    this.n++;
    while (this.inputs.length > KEEP_TICKS) {
      this.inputs.shift();
      this.firstTick++;
    }
    while (this.snaps.length > 1 && this.snaps[0].tick < this.firstTick) this.snaps.shift();
  }

  /** Call after the step with its events (the step is tick n - 1). */
  events(events: readonly SimEvent[]): void {
    const tick = this.n - 1;
    for (const e of events) {
      if (e.type === 'hit' && !e.shield) {
        this.lastHitOn[e.victim] = tick;
        this.lastHit = { tick, victim: e.victim, attacker: e.attacker };
      } else if (e.type === 'ko') this.lastKo = { tick, victim: e.victim, by: e.by };
    }
  }

  /** The highlight of the match that has just ended, or null when nothing was hit. The chapter id is filled in by the caller. */
  build(s: GameState, chapter = ''): Highlight | null {
    const now = this.n - 1;
    // The final KO; a win that ended on a quota or a streak (no KO near the end) anchors on the winning hit instead.
    const ko = this.lastKo && now - this.lastKo.tick <= WINDOW_TICKS ? this.lastKo : null;
    let hit: number;
    let koTick: number;
    let victim: number;
    let by: number;
    if (ko) {
      const h = this.lastHitOn[ko.victim];
      koTick = ko.tick;
      hit = h !== undefined && ko.tick - h <= 150 ? h : ko.tick - 10;
      victim = ko.victim;
      by = ko.by;
    } else if (this.lastHit) {
      hit = koTick = this.lastHit.tick;
      victim = this.lastHit.victim;
      by = this.lastHit.attacker;
    } else return null;
    const want = Math.min(koTick - WINDOW_TICKS, hit - REPLAY.lead);
    let snap = this.snaps[0];
    for (const sn of this.snaps) if (sn.tick <= want) snap = sn;
    if (!snap) return null;
    const last = Math.min(this.n - 1, Math.max(hit + REPLAY.tail, koTick) + 10);
    const inputs = this.inputs.slice(Math.max(0, snap.tick - this.firstTick), Math.max(0, last - this.firstTick + 1));
    return {
      v: 1,
      chapter,
      stage: STAGES[s.stage]?.id ?? STAGES[0].id,
      chars: s.fighters.map((f) => CHARACTERS[f.char].id),
      looks: [],
      start: cloneState(snap.state),
      from: snap.tick,
      inputs,
      hit,
      ko: koTick,
      victim,
      by,
    };
  }
}

/** Plays a highlight back through the sim, tick by tick, slowing the final hit. Holds its own state. */
export class HighlightPlayer {
  readonly state: GameState;
  private tick: number;
  private acc = 0;
  private readonly endTick: number;
  private readonly slowFrom: number;

  private readonly h: Highlight;

  constructor(h: Highlight) {
    this.h = h;
    this.state = cloneState(h.start);
    this.tick = h.from;
    this.slowFrom = h.hit - REPLAY.slowBefore;
    const first = Math.max(h.from, h.hit - REPLAY.lead);
    this.endTick = Math.min(h.from + h.inputs.length, Math.max(first + 1, h.hit + REPLAY.tail));
    // Fast-forward (unseen) to the lead-in: the 4 s are stored, 3 s of them are shown.
    while (this.tick < first) this.stepOnce();
  }

  private inputsAt(t: number): number[] {
    return this.h.inputs[t - this.h.from] ?? this.state.fighters.map(() => NO_INPUT);
  }

  private stepOnce(): SimEvent[] {
    const ev = step(this.state, this.inputsAt(this.tick));
    this.tick++;
    return ev;
  }

  /** The speed now: the slow part plays at 25%. */
  speed(): number {
    return this.tick >= this.slowFrom && this.tick < this.slowFrom + REPLAY.slowTicks ? REPLAY.slow : 1;
  }

  /** True while the final hit's slow-motion part is playing. */
  slowed(): boolean {
    return this.speed() < 1;
  }

  done(): boolean {
    return this.tick >= this.endTick;
  }

  /** The tick of the final hit has been played. */
  get hitPlayed(): boolean {
    return this.tick > this.h.hit;
  }

  /** Advances by `dtMs` of real time; returns the sim events of the ticks it ran. */
  advance(dtMs: number): SimEvent[] {
    const out: SimEvent[] = [];
    this.acc += Math.min(100, dtMs) / (1000 / 60);
    while (this.acc >= 1 / this.speed() && !this.done()) {
      this.acc -= 1 / this.speed();
      out.push(...this.stepOnce());
    }
    return out;
  }
}

// ------------------------------------------------------------------ the save

export function saveHighlight(h: Highlight): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    // Storage full or blocked: the recap is skipped next time, nothing else changes.
  }
}

/** The saved highlight, or null when there is none or it no longer fits the roster and stages. */
export function loadHighlight(): Highlight | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Highlight;
    if (h?.v !== 1 || !h.start || !Array.isArray(h.inputs) || !Array.isArray(h.chars) || h.start.fighters?.length !== h.chars.length) return null;
    if (STAGES[h.start.stage]?.id !== h.stage) return null;
    if (h.start.fighters.some((f, i) => CHARACTERS[f.char]?.id !== h.chars[i])) return null;
    return h;
  } catch {
    return null;
  }
}

export function clearHighlight(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

// ------------------------------------------------------------------ the lines

/** The episode that comes after `id` in the show (null after the last). */
export function nextChapterId(id: string): string | null {
  const i = CHAPTERS.findIndex((c) => c.id === id);
  return i >= 0 && i + 1 < CHAPTERS.length ? CHAPTERS[i + 1].id : null;
}

/** Blog Man's "Next time" line after an episode (content/voice.json), about the episode that follows it. */
export const teaseId = (chapter: string): string => `blog-man.tease.${chapter}`;
/** Blog Man's "Previously" line for an episode, said as the next episode opens. */
export const recapId = (chapter: string): string => `blog-man.recap.${chapter}`;

/**
 * Whether starting `chapter` opens with a recap of the saved highlight: it is the episode that follows the highlight's
 * episode (a run that starts over after the finale recaps the finale).
 */
export function recapApplies(h: Highlight | null, chapter: string): h is Highlight {
  if (!h || !h.chapter) return false;
  const next = nextChapterId(h.chapter) ?? CHAPTERS[0]?.id;
  return next === chapter;
}
