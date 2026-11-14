// One match: its setup, the live state, the bots, and a record of how it went
// for the end screen. Stats are gathered from sim events, outside the sim.

import { CHARACTERS } from './sim/characters.ts';
import { NO_INPUT, stickX, stickY } from './sim/input.ts';
import { ACT, cloneState, newGame, type BroadcastDef, type GameState, type Rules } from './sim/state.ts';
import { BUFFER_FRAMES, step, type SimEvent } from './sim/step.ts';
import { Bot } from './ai/bot.ts';
import { consumeInputEdge } from './input/devices.ts';
import { HighlightRecorder, type Highlight } from './campaign/highlight.ts';

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
  /** Colour look (looks.ts), 0 is the original art. Cosmetic: the renderer reads it, the sim never does. */
  look?: number;
  /** The pilot's gentle Kaelen (ai/bot.ts pilotFight). */
  pilot?: boolean;
}

export interface MatchSetup {
  mode: Mode;
  stage: number;
  stocks: number;
  rules: Partial<Rules>;
  /** Scripted broadcast events (content/campaign.json `events`). */
  events?: BroadcastDef[];
  slots: SlotSetup[];
  /** Shown on the VS screen. */
  title?: string;
  subtitle?: string;
  /**
   * 'survive' wins by still standing when time runs out. 'ko' wins by scoring `kos` KOs before
   * time runs out (the match ends on the last one), and loses on time or out of stocks.
   * 'quota' wins by dealing `quota` percent of damage to the other side before time runs out
   * (the match ends the moment the sponsor's number is met), and loses the same two ways.
   * 'streak' wins by landing `streak` hits in a row without being hit back (a clean streak) before
   * time runs out (the match ends on the hit that makes it), and loses the same two ways.
   */
  objective?: 'win' | 'survive' | 'ko' | 'quota' | 'streak';
  /** The 'ko' objective's target: how many KOs the player must score. */
  kos?: number;
  /** The 'quota' objective's target: how many percent of damage the player must deal (the HUD and results use whole percent). */
  quota?: number;
  /** The 'streak' objective's target: how many hits in a row the player must land without being hit. */
  streak?: number;
  /** Online matches: who is in each slot (net/online.ts). */
  online?: OnlineSlots;
  /** On-stage teaching prompts (ui/teach.ts): the pilot fight reads cues from Kaelen, How to play runs them on a timer. */
  teach?: 'pilot' | 'training';
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
  /** Clean hits in a row right now: counts up with each hit landed, back to 0 when this fighter is hit. */
  streak: number;
  /** The most clean hits in a row so far. */
  bestStreak: number;
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
  readonly inputLatencies: number[] = [];
  bufferedActions = 0;
  coyoteJumps = 0;
  /** Campaign matches record their last seconds of inputs (campaign/highlight.ts), so the final KO can be replayed. */
  private readonly recorder: HighlightRecorder | null;
  /** The replayable final KO, built the tick the match ends (campaign only). */
  highlight: Highlight | null = null;
  private pendingInput: { frame: number; pollMs: number; kind: 'button' | 'stick' } | null = null;
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
      { stocks: setup.stocks, seed, stage: setup.stage, rules: setup.objective && setup.objective !== 'win' ? { ...setup.rules, suddenDeath: 0 } : setup.rules, broadcast: setup.events },
    );
    this.recorder = setup.mode === 'campaign' ? new HighlightRecorder() : null;
    this.bots = setup.slots.map((s, i) => (s.cpu ? new Bot(i, s.cpu, seed + i * 7919, s.pilot) : null));
    this.stats = setup.slots.map(() => ({
      dealt: 0, taken: 0, hitsLanded: 0, hitsShielded: 0, biggestHit: 0, longestCombo: 0, streak: 0, bestStreak: 0,
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
    const prev = s.fighters.map((f) => ({
      action: f.action,
      frame: f.frame,
      vx: f.vx,
      buffer: f.buffer,
      bufferAge: f.bufferAge,
      coyote: f.coyote,
      prevInput: f.prevInput,
    }));
    const me = s.fighters[this.player];
    const prevMe = me ? prev[me.id] : null;
    const edge = consumeInputEdge();
    if (me && prevMe) {
      const btnEdge = edge ? edge.buttons : (local & ~prevMe.prevInput) & ~0xffff;
      const sx = stickX(local);
      const sy = stickY(local);
      const psx = stickX(prevMe.prevInput);
      const psy = stickY(prevMe.prevInput);
      const stickEdge = edge
        ? edge.stick
        : (Math.abs(sx) > 20 && Math.sign(sx) !== (Math.abs(psx) > 20 ? Math.sign(psx) : 0)) ||
          (Math.abs(sy) > 60 && Math.sign(sy) !== (Math.abs(psy) > 60 ? Math.sign(psy) : 0));
      const pollMs = edge ? Math.min(1000 / 60, Math.max(0, edge.polledAt - edge.at)) : 0;
      if (btnEdge !== 0) {
        this.pendingInput = { frame: s.frame, pollMs, kind: 'button' };
      } else if (stickEdge && !this.pendingInput) {
        this.pendingInput = { frame: s.frame, pollMs, kind: 'stick' };
      }
    }
    const before = s.fighters.map((f) => f.percent);
    this.recorder?.record(s, inputs);
    const events = step(s, inputs);
    this.recorder?.events(events);
    for (const f of s.fighters) {
      const p = prev[f.id];
      const jumped = events.some((e) => e.type === 'jump' && e.id === f.id);
      const acted =
        (f.action !== p.action &&
          (f.action === ACT.JUMPSQUAT ||
            f.action === ACT.ATTACK ||
            f.action === ACT.SHIELD ||
            f.action === ACT.AIRDODGE ||
            f.action === ACT.LEDGE_CLIMB ||
            (p.action === ACT.LEDGE && f.action === ACT.AIR) ||
            (p.action === ACT.RESPAWN && f.action === ACT.AIR))) ||
        (f.action === ACT.ATTACK && f.frame === 0) ||
        jumped;
      if (p.buffer !== 0 && p.bufferAge > 0 && f.buffer === 0 && acted) this.bufferedActions++;
      if (p.coyote > 0 && jumped) this.coyoteJumps++;
      if (f === me && this.pendingInput) {
        const moved =
          f.action === ACT.WALK ||
          f.action === ACT.CROUCH ||
          f.action === ACT.ROLL ||
          f.action === ACT.SPOTDODGE ||
          f.dropThrough > 0 ||
          (f.action === ACT.AIR && f.vx !== p.vx) ||
          (p.action === ACT.RESPAWN && f.action === ACT.AIR);
        const changed = this.pendingInput.kind === 'button' ? acted : acted || moved;
        if (changed) {
          const frames = Math.max(1, s.frame - this.pendingInput.frame);
          const ms = Math.min(100, Math.round(this.pendingInput.pollMs + frames * (1000 / 60)));
          this.inputLatencies.push(ms);
          if (this.inputLatencies.length > 500) this.inputLatencies.shift();
          this.pendingInput = null;
        } else if (
          (this.pendingInput.kind === 'button' && f.buffer === 0) ||
          s.frame - this.pendingInput.frame > BUFFER_FRAMES
        ) {
          this.pendingInput = null;
        }
      }
    }
    this.record(events, before);
    this.checkObjective();
    this.freezeHighlight();
    if (s.frame % SAMPLE_EVERY === 0) this.sample();
    return events;
  }

  /** The tick the match ends, the last seconds are kept as a replay (campaign only). */
  private freezeHighlight(): void {
    if (this.recorder && this.state.over && !this.highlight) this.highlight = this.recorder.build(this.state);
  }

  /** Median and worst input-to-action latency (ms) measured in this match. */
  latencyStats(): { median: number; worst: number; samples: number } {
    if (!this.inputLatencies.length) return { median: 0, worst: 0, samples: 0 };
    const sorted = this.inputLatencies.slice().sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      worst: sorted[sorted.length - 1],
      samples: sorted.length,
    };
  }

  /** Runs one frame with every slot's input given (online: both players' inputs from the rollback). */
  tickInputs(inputs: number[]): SimEvent[] {
    const s = this.state;
    const before = s.fighters.map((f) => f.percent);
    const events = step(s, inputs);
    this.record(events, before);
    this.checkObjective();
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
        // A clean streak: each hit landed adds one, and taking a hit ends the victim's.
        const v = this.stats[e.victim];
        v.streak = 0;
        a.streak++;
        a.bestStreak = Math.max(a.bestStreak, a.streak);
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

  /** The 'ko', 'quota' and 'streak' objectives: the match ends, won by the player, the moment the target is met. */
  private checkObjective(): void {
    const s = this.state;
    const me = s.fighters[this.player];
    if (s.over || !me || !this.objectiveMet()) return;
    s.over = 1;
    s.timedOut = 0;
    s.winner = me.id;
    s.winnerTeam = me.team;
    s.endTimer = 120;
  }

  /** Whether the match's counting objective ('ko', 'quota' or 'streak') has reached its target. */
  private objectiveMet(): boolean {
    if (this.setup.objective === 'ko') return this.koCount() >= this.koTarget;
    if (this.setup.objective === 'quota') return this.quotaDealt() >= this.quotaTarget;
    if (this.setup.objective === 'streak') return this.streakBest() >= this.streakTarget;
    return false;
  }

  /** The 'ko' objective's target (3 when the setup leaves it out). */
  get koTarget(): number {
    return Math.max(1, this.setup.kos ?? 3);
  }

  /** KOs the local player has scored (self-destructs don't count). */
  koCount(): number {
    return this.stats[this.player]?.kos ?? 0;
  }

  /** The 'quota' objective's target in tenths of a percent, the sim's unit (250% when the setup leaves it out). */
  get quotaTarget(): number {
    return Math.max(1, Math.round((this.setup.quota ?? 250) * 10));
  }

  /** Damage the local player has dealt, in tenths of a percent. Shielded hits, hazards and falls don't count. */
  quotaDealt(): number {
    return this.stats[this.player]?.dealt ?? 0;
  }

  /** The 'streak' objective's target (4 hits when the setup leaves it out). */
  get streakTarget(): number {
    return Math.max(2, Math.round(this.setup.streak ?? 4));
  }

  /** The local player's best clean streak so far, in hits. Shielded hits don't count and don't end a streak. */
  streakBest(): number {
    return this.stats[this.player]?.bestStreak ?? 0;
  }

  /** The local player's streak right now (back to 0 when they are hit). */
  streakNow(): number {
    return this.stats[this.player]?.streak ?? 0;
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
    // On time or out of stocks the target wasn't reached; every foe out of stocks first still wins.
    const counting = this.setup.objective === 'ko' || this.setup.objective === 'quota' || this.setup.objective === 'streak';
    if (counting && this.objectiveMet()) return true;
    if (counting && s.timedOut) return false;
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
