// Match commentary: the announcer calls what happens (first blood, comebacks, KOs, big hits…) and, in the
// campaign, Blog Man introduces each episode from the booth. The lines are voice-catalog lines
// (content/voice.json: `announcer.<kind>.<n>`, `blog-man.intro.<chapter id>`), so the Voice tab edits them and a
// line with no take yet shows as a caption and plays silent. Pure logic: main.ts feeds it the sim's events and plays
// what it returns; nothing here touches the sim, so a rollback or a replay is never affected.

import voiceJson from '../../content/voice.json' with { type: 'json' };
import type { VoiceCatalog } from './audio.ts';
import type { SimEvent } from './sim/step.ts';
import type { GameState } from './sim/state.ts';

const VOICE = voiceJson as VoiceCatalog;

export type CallKind =
  | 'first-blood' | 'ko' | 'comeback' | 'last-stock' | 'showdown' | 'self-destruct' | 'big-hit' | 'combo'
  | 'danger' | 'shield-break' | 'hazard' | 'stage-event' | 'time-low' | 'lull';

export const CALL_KINDS: readonly CallKind[] = [
  'first-blood', 'ko', 'comeback', 'last-stock', 'showdown', 'self-destruct', 'big-hit', 'combo',
  'danger', 'shield-break', 'hazard', 'stage-event', 'time-low', 'lull',
];

export interface Call {
  kind: CallKind | 'intro';
  /** The voice-catalog id: play it with audio.line. */
  id: string;
  who: 'announcer' | 'blog-man';
  text: string;
}

const FPS = 60;
/** Frames between two calls; a KO-sized call (priority 2) may cut in. */
const GAP = 3 * FPS;
const BIG_HIT = 130;
const COMBO_HITS = 3;
const COMBO_WINDOW = 2 * FPS;
const DANGER_PERCENT = 1500;
const LULL = 12 * FPS;
const TIME_LOW = 10 * FPS;

const POOLS = new Map<string, { id: string; text: string }[]>();
for (const l of VOICE.lines) {
  const m = /^announcer\.([a-z-]+)\.\d+$/.exec(l.id);
  if (m) {
    const pool = POOLS.get(m[1]) ?? [];
    pool.push({ id: l.id, text: l.text });
    POOLS.set(m[1], pool);
  }
}

/** The line ids of one kind, for tests and devtools. */
export const poolOf = (kind: string): readonly { id: string; text: string }[] => POOLS.get(kind) ?? [];

const PRIORITY: Record<CallKind, number> = {
  'first-blood': 2, ko: 2, comeback: 2, 'self-destruct': 2, showdown: 2, 'last-stock': 1, 'big-hit': 0, combo: 1,
  danger: 0, 'shield-break': 0, hazard: 0, 'stage-event': 1, 'time-low': 1, lull: 0,
};

/** Blog Man's line for an episode (every chapter has one in content/voice.json). */
export function introCall(chapterId: string): Call | null {
  const l = VOICE.lines.find((x) => x.id === `blog-man.intro.${chapterId}`);
  return l ? { kind: 'intro', id: l.id, who: 'blog-man', text: l.text } : null;
}

export class Commentator {
  private lastId = '';
  private lastFrame = -1e9;
  private lastHitFrame = 0;
  private kos = 0;
  private stocksBefore: number[];
  private run = { by: -1, n: 0, frame: 0, said: false };
  private dangerSaid = new Set<number>();
  private timeSaid = false;
  /** Every call made, in order (the playtest reads it). */
  readonly log: Call[] = [];

  private readonly rand: () => number;

  /** True when a line may be said now (the voice director's 5 minute no-repeat rule). */
  private readonly fresh: (id: string) => boolean;

  constructor(s: GameState, rand: () => number = Math.random, fresh: (id: string) => boolean = () => true) {
    this.rand = rand;
    this.fresh = fresh;
    this.stocksBefore = s.fighters.map((f) => f.stocks);
  }

  /** The line for a kind that isn't the one said last, or null if the pool has nothing else. */
  private pick(kind: string): { id: string; text: string } | null {
    const pool = POOLS.get(kind);
    if (!pool?.length) return null;
    // Never the line said last, never one heard in the last 5 minutes: with none left the call is skipped (silence beats a repeat).
    const from = pool.filter((l) => l.id !== this.lastId && this.fresh(l.id));
    return from.length ? from[Math.floor(this.rand() * from.length)] : null;
  }

  private say(kind: CallKind, frame: number, out: Call[], force = false): void {
    if (!force && frame - this.lastFrame < GAP && PRIORITY[kind] < 2) return;
    const l = this.pick(kind);
    if (!l || l.id === this.lastId) return;
    const call: Call = { kind, id: l.id, who: 'announcer', text: l.text };
    this.lastId = l.id;
    this.lastFrame = frame;
    this.log.push(call);
    out.push(call);
  }

  /** Records a line said elsewhere (an episode intro) so the next call doesn't repeat it. */
  note(call: Call, frame: number): void {
    this.lastId = call.id;
    this.lastFrame = frame;
    this.log.push(call);
  }

  /** Feeds one tick's events (state after the tick). Returns the calls to make, usually none. */
  onEvents(s: GameState, events: SimEvent[]): Call[] {
    const out: Call[] = [];
    const frame = s.frame;
    if (s.over) return out;
    for (const e of events) {
      if (e.type === 'hit' && !e.shield) {
        this.lastHitFrame = frame;
        const r = this.run;
        if (r.by === e.attacker && frame - r.frame <= COMBO_WINDOW) {
          r.n++;
        } else {
          r.by = e.attacker;
          r.n = 1;
          r.said = false;
        }
        r.frame = frame;
        // Any hit on the attacker ends a run of someone else's.
        if (r.n >= COMBO_HITS && !r.said) {
          r.said = true;
          this.say('combo', frame, out);
        }
        if (e.dmg >= BIG_HIT) this.say('big-hit', frame, out);
        const v = s.fighters[e.victim];
        if (v.percent >= DANGER_PERCENT && !this.dangerSaid.has(v.id)) {
          this.dangerSaid.add(v.id);
          this.say('danger', frame, out);
        }
      } else if (e.type === 'hit') {
        this.lastHitFrame = frame;
      } else if (e.type === 'shieldbreak') {
        this.say('shield-break', frame, out);
      } else if (e.type === 'hurt' && e.source === 'hazard') {
        this.say('hazard', frame, out);
      } else if (e.type === 'stage' && e.phase === 'warn') {
        this.say('stage-event', frame, out);
      } else if (e.type === 'ko') {
        this.lastHitFrame = frame;
        this.dangerSaid.delete(e.victim);
        if (this.run.by === e.victim) this.run.n = 0;
        out.push(...this.koCalls(s, e, frame));
      }
    }
    if (s.rules.timeLimit > 0 && !this.timeSaid && s.rules.timeLimit - frame <= TIME_LOW && frame > TIME_LOW) {
      this.timeSaid = true;
      this.say('time-low', frame, out);
    }
    if (frame - this.lastHitFrame >= LULL) {
      this.lastHitFrame = frame;
      this.say('lull', frame, out);
    }
    return out;
  }

  private koCalls(s: GameState, e: Extract<SimEvent, { type: 'ko' }>, frame: number): Call[] {
    const out: Call[] = [];
    this.kos++;
    const killer = e.by >= 0 && e.by !== e.victim ? e.by : -1;
    const before = this.stocksBefore;
    const stocks = s.fighters.map((f) => f.stocks);
    // Team -1 is free-for-all: everyone else is a rival.
    const rival = (i: number) => i !== killer && (s.fighters[i].team < 0 || s.fighters[i].team !== s.fighters[killer].team);
    const behind = killer >= 0 && before.some((n, i) => rival(i) && n > before[killer]);
    const level = killer >= 0 && stocks.every((n, i) => !rival(i) || n <= stocks[killer]);
    const left = stocks.filter((n) => n > 0);
    const last = stocks[e.victim] === 1;
    this.stocksBefore = stocks;
    // One call per KO: the most newsworthy.
    if (this.kos === 1) this.say('first-blood', frame, out, true);
    else if (behind && level) this.say('comeback', frame, out, true);
    else if (killer < 0) this.say('self-destruct', frame, out, true);
    else if (last && left.length > 1 && left.every((n) => n === 1)) this.say('showdown', frame, out, true);
    else if (last) this.say('last-stock', frame, out, true);
    else this.say('ko', frame, out, true);
    return out;
  }
}
