// One match: its setup, the live state, the bots, and a record of how it went
// for the end screen. Stats are gathered from sim events, outside the sim.

import { CHARACTERS } from './sim/characters.ts';
import { NO_INPUT } from './sim/input.ts';
import { ACT, cloneState, newGame, type GameState, type Rules } from './sim/state.ts';
import { step, type SimEvent } from './sim/step.ts';
import { Bot } from './ai/bot.ts';

export type Mode = 'versus' | 'training' | 'campaign' | 'online';

export interface SlotSetup {
  char: number;
  /** null for a person (this player, or the other player online), 0 for a training dummy, 1-9 for a bot. */
  cpu: number | null;
  /** Online: the other player's slot (their inputs come over the network). */
  remote?: boolean;
  team?: number;
  scale?: number;
  startPercent?: number;
  stocks?: number;
}

export interface MatchSetup {
  mode: Mode;
  stage: number;
  stocks: number;
  rules: Partial<Rules>;
  slots: SlotSetup[];
  /** Shown on the VS screen. */
  title?: string;
  subtitle?: string;
  /** 'survive' wins by still standing when time runs out. */
  objective?: 'win' | 'survive';
  /** Online matches: who is in each slot (net/online.ts). */
  online?: OnlineSlots;
}

export interface OnlineSlots {
  matchId: string;
  /** Player names and profile pictures (fighter ids), by slot. */
  names: string[];
  avatars: string[];
  ids: string[];
}

/** Everything a rollback restores: the sim state and the stats gathered from it. */
export interface MatchSnapshot {
  state: GameState;
  stats: FighterStats[];
  combo: { by: number; count: number }[];
  timeline: number;
  kos: number;
}

export interface FighterStats {
  dealt: number;
  taken: number;
  hitsLanded: number;
  hitsShielded: number;
  biggestHit: number;
  longestCombo: number;
  kos: number;
  falls: number;
  selfDestructs: number;
  ledgeGrabs: number;
  /** Frames spent in the air. */
  airtime: number;
}

export interface TimelinePoint {
  frame: number;
  percent: number[];
}

export interface KoMark {
  frame: number;
  victim: number;
  by: number;
  percent: number;
}

const SAMPLE_EVERY = 20;

export class Match {
  readonly setup: MatchSetup;
  readonly state: GameState;
  readonly bots: (Bot | null)[];
  readonly stats: FighterStats[];
  readonly timeline: TimelinePoint[] = [];
  readonly kos: KoMark[] = [];
  private combo: { by: number; count: number }[];

  constructor(setup: MatchSetup, seed: number) {
    this.setup = setup;
    const training = setup.mode === 'training';
    this.state = newGame(
      setup.slots.map((s) => ({
        char: s.char,
        team: s.team,
        scale: s.scale,
        startPercent: s.startPercent,
        stocks: training ? 99 : s.stocks,
      })),
      { stocks: setup.stocks, seed, stage: setup.stage, rules: setup.rules },
    );
    this.bots = setup.slots.map((s, i) => (s.cpu ? new Bot(i, s.cpu, seed + i * 7919) : null));
    this.stats = setup.slots.map(() => ({
      dealt: 0, taken: 0, hitsLanded: 0, hitsShielded: 0, biggestHit: 0, longestCombo: 0,
      kos: 0, falls: 0, selfDestructs: 0, ledgeGrabs: 0, airtime: 0,
    }));
    this.combo = setup.slots.map(() => ({ by: -1, count: 0 }));
    this.sample();
  }

  /** Runs one frame with the local player's input. */
  tick(local: number): SimEvent[] {
    const s = this.state;
    const inputs = s.fighters.map((_, i) => {
      const slot = this.setup.slots[i];
      if (slot.cpu === null) return local;
      return this.bots[i]?.think(s) ?? NO_INPUT;
    });
    const before = s.fighters.map((f) => f.percent);
    const events = step(s, inputs);
    this.record(events, before);
    if (s.frame % SAMPLE_EVERY === 0) this.sample();
    return events;
  }

  /** Runs one frame with every slot's input given (online: both players' inputs from the rollback). */
  tickInputs(inputs: number[]): SimEvent[] {
    const s = this.state;
    const before = s.fighters.map((f) => f.percent);
    const events = step(s, inputs);
    this.record(events, before);
    if (s.frame % SAMPLE_EVERY === 0) this.sample();
    return events;
  }

  snapshot(): MatchSnapshot {
    return {
      state: cloneState(this.state),
      stats: this.stats.map((x) => ({ ...x })),
      combo: this.combo.map((c) => ({ ...c })),
      timeline: this.timeline.length,
      kos: this.kos.length,
    };
  }

  /** Puts a snapshot back in place (the same state object, so the renderer and HUD keep their reference). */
  restore(snap: MatchSnapshot): void {
    const copy = cloneState(snap.state);
    Object.assign(this.state, copy);
    snap.stats.forEach((x, i) => Object.assign(this.stats[i], x));
    snap.combo.forEach((c, i) => Object.assign(this.combo[i], c));
    this.timeline.length = snap.timeline;
    this.kos.length = snap.kos;
  }

  private sample(): void {
    this.timeline.push({ frame: this.state.frame, percent: this.state.fighters.map((f) => f.percent) });
  }

  private record(events: SimEvent[], before: number[]): void {
    const s = this.state;
    for (const e of events) {
      if (e.type === 'hit') {
        const a = this.stats[e.attacker];
        if (e.shield) {
          this.stats[e.victim].hitsShielded++;
          continue;
        }
        a.dealt += e.dmg;
        a.hitsLanded++;
        a.biggestHit = Math.max(a.biggestHit, e.dmg);
        this.stats[e.victim].taken += e.dmg;
        const c = this.combo[e.victim];
        // A hit on someone still reeling from the same attacker extends the combo.
        const reeling = c.by === e.attacker && c.count > 0;
        c.by = e.attacker;
        c.count = reeling ? c.count + 1 : 1;
        a.longestCombo = Math.max(a.longestCombo, c.count);
      } else if (e.type === 'ko') {
        const v = this.stats[e.victim];
        v.falls++;
        if (e.by < 0 || e.by === e.victim) v.selfDestructs++;
        else this.stats[e.by].kos++;
        this.kos.push({ frame: s.frame, victim: e.victim, by: e.by, percent: before[e.victim] });
        this.sample();
      } else if (e.type === 'ledge') {
        this.stats[e.id].ledgeGrabs++;
      }
    }
    s.fighters.forEach((f, i) => {
      // A combo ends once the victim is free to act again.
      if (f.action !== ACT.HITSTUN && f.hitlag === 0) this.combo[i].count = 0;
      if (!f.grounded && f.action !== ACT.DEAD) this.stats[i].airtime++;
    });
  }

  /** The local player's slot, or -1 if every fighter is a CPU. */
  get player(): number {
    return this.setup.slots.findIndex((s) => s.cpu === null && !s.remote);
  }

  /** Whether the local player's side won. */
  playerWon(): boolean {
    const s = this.state;
    const me = s.fighters[this.player];
    if (!me) return false;
    if (this.setup.objective === 'survive') {
      if (s.timedOut) return me.stocks > 0;
    }
    if (s.winnerTeam >= 0) return me.team === s.winnerTeam;
    return s.winner === me.id;
  }

  /** Display name for a slot. */
  label(i: number): string {
    const slot = this.setup.slots[i];
    const name = CHARACTERS[slot.char].name;
    const online = this.setup.online;
    if (online) return `${online.names[i] || 'Player'} · ${name}`;
    if (slot.cpu === null) return `You · ${name}`;
    if (slot.cpu === 0) return `Dummy · ${name}`;
    return `CPU ${slot.cpu} · ${name}`;
  }
}
