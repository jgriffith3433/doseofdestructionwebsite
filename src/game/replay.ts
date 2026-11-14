// Full-match replay recording, playback, and bounded profile storage (dod.profile.replay).
//
// Because the sim is deterministic and step() does not advance state.frame during a
// commercial break (freeze > 0), inputs are indexed by sim tick (each call to step),
// never by state.frame. Replaying creates a fresh Match with the same seed and setup
// and feeds the recorded per-tick inputs into Match.tickInputs().

import { CHARACTERS } from './sim/characters.ts';
import { STAGES } from './sim/stage.ts';
import { NO_INPUT } from './sim/input.ts';
import { hashState, type BroadcastDef, type GameState, type Rules } from './sim/state.ts';
import type { SimEvent } from './sim/step.ts';
import { Match, type MatchSetup, type Mode, type OnlineSlots, type SlotSetup } from './match.ts';

export const REPLAY_KEY = 'dod.profile.replay';

/** Cap a single replay at 6 minutes of 60 Hz ticks so memory stays bounded during long matches. */
export const MAX_REPLAY_TICKS = 60 * 60 * 6;

/** Hard byte budget for the serialized replay stored in localStorage alongside the profile. */
export const MAX_REPLAY_BYTES = 64 * 1024;

export interface ReplaySlot {
  id: string;
  cpu: number | null;
  remote?: boolean;
  team?: number;
  scale?: number;
  startPercent?: number;
  stocks?: number;
  look?: number;
  auto?: boolean;
  pilot?: boolean;
}

export interface ReplaySetup {
  mode: Mode;
  stage: string;
  stocks: number;
  rules: Partial<Rules>;
  events?: BroadcastDef[];
  slots: ReplaySlot[];
  title?: string;
  subtitle?: string;
  objective?: MatchSetup['objective'];
  kos?: number;
  quota?: number;
  streak?: number;
  online?: OnlineSlots;
}

export interface ReplayResult {
  frame: number;
  winner: number;
  winnerTeam: number;
  timedOut: boolean;
  stocks: number[];
  percents: number[];
  /** Deterministic hashState(state) after the recorded ticks. */
  hash: number;
}

export interface Replay {
  v: 1;
  seed: number;
  setup: ReplaySetup;
  /** Number of sim ticks recorded in `runs`. */
  ticks: number;
  /**
   * Per-slot run-length encoded inputs: `[count0, input0, count1, input1, ...]`.
   * Across every slot the sum of counts equals `ticks`.
   */
  runs: number[][];
  result: ReplayResult;
  createdAt: number;
}

function snapshotResult(state: GameState): ReplayResult {
  return {
    frame: state.frame,
    winner: state.winner,
    winnerTeam: state.winnerTeam,
    timedOut: state.timedOut !== 0,
    stocks: state.fighters.map((f) => f.stocks),
    percents: state.fighters.map((f) => f.percent),
    hash: hashState(state),
  };
}

export function encodeReplaySetup(setup: MatchSetup): ReplaySetup {
  const stageDef = STAGES[setup.stage] ?? STAGES[0];
  return {
    mode: setup.mode,
    stage: stageDef.id,
    stocks: setup.stocks,
    rules: { ...setup.rules },
    ...(setup.events && setup.events.length
      ? {
          events: setup.events.map((e) => ({
            ...e,
            when: { ...e.when },
            ...(e.rule ? { rule: { ...e.rule } } : {}),
          })),
        }
      : {}),
    slots: setup.slots.map((s) => {
      const charDef = CHARACTERS[s.char] ?? CHARACTERS[0];
      const out: ReplaySlot = { id: charDef.id, cpu: s.cpu };
      if (s.remote) out.remote = true;
      if (s.team !== undefined) out.team = s.team;
      if (s.scale !== undefined && s.scale !== 1) out.scale = s.scale;
      if (s.startPercent) out.startPercent = s.startPercent;
      if (s.stocks !== undefined) out.stocks = s.stocks;
      if (s.look) out.look = s.look;
      if (s.auto) out.auto = true;
      if (s.pilot) out.pilot = true;
      return out;
    }),
    ...(setup.title ? { title: setup.title } : {}),
    ...(setup.subtitle ? { subtitle: setup.subtitle } : {}),
    ...(setup.objective ? { objective: setup.objective } : {}),
    ...(setup.kos !== undefined ? { kos: setup.kos } : {}),
    ...(setup.quota !== undefined ? { quota: setup.quota } : {}),
    ...(setup.streak !== undefined ? { streak: setup.streak } : {}),
    ...(setup.online
      ? {
          online: {
            matchId: setup.online.matchId,
            names: [...setup.online.names],
            avatars: [...setup.online.avatars],
            ids: [...setup.online.ids],
          },
        }
      : {}),
  };
}

export function setupFromReplay(replay: Replay): MatchSetup {
  const s = replay.setup;
  const stageIdx = Math.max(0, STAGES.findIndex((st) => st.id === s.stage));
  const slots: SlotSetup[] = s.slots.map((slot) => {
    const charIdx = Math.max(0, CHARACTERS.findIndex((c) => c.id === slot.id));
    return {
      char: charIdx,
      cpu: slot.cpu,
      remote: slot.remote,
      team: slot.team,
      scale: slot.scale,
      startPercent: slot.startPercent,
      stocks: slot.stocks,
      look: slot.look,
      auto: slot.auto,
      pilot: slot.pilot,
    };
  });
  return {
    mode: s.mode,
    stage: stageIdx,
    stocks: s.stocks,
    rules: { ...s.rules },
    events: s.events
      ? s.events.map((e) => ({
          ...e,
          when: { ...e.when },
          ...(e.rule ? { rule: { ...e.rule } } : {}),
        }))
      : undefined,
    slots,
    title: s.title,
    subtitle: s.subtitle,
    objective: s.objective,
    kos: s.kos,
    quota: s.quota,
    streak: s.streak,
    online: s.online
      ? {
          matchId: s.online.matchId,
          names: [...s.online.names],
          avatars: [...s.online.avatars],
          ids: [...s.online.ids],
        }
      : undefined,
  };
}

/** Run-length encodes a list of per-tick input arrays `[tick][slot]` into per-slot `[count, input, ...]` runs. */
export function encodeReplayInputs(ticks: number[][], slotCount: number): number[][] {
  const runs: number[][] = Array.from({ length: slotCount }, () => []);
  for (let slot = 0; slot < slotCount; slot++) {
    const out = runs[slot];
    let curInput = 0;
    let count = 0;
    for (let t = 0; t < ticks.length; t++) {
      const inp = ticks[t][slot] ?? NO_INPUT;
      if (count === 0) {
        curInput = inp;
        count = 1;
      } else if (inp === curInput) {
        count++;
      } else {
        out.push(count, curInput);
        curInput = inp;
        count = 1;
      }
    }
    if (count > 0) out.push(count, curInput);
  }
  return runs;
}

/** Expands per-slot `[count, input, ...]` runs back into `[tick][slot]` input words. */
export function decodeReplayInputs(replay: Replay): number[][] {
  const slotCount = replay.setup.slots.length;
  const total = Math.max(0, Math.min(MAX_REPLAY_TICKS, replay.ticks | 0));
  const out: number[][] = Array.from({ length: total }, () => new Array(slotCount).fill(NO_INPUT));
  for (let slot = 0; slot < slotCount; slot++) {
    const run = replay.runs[slot] ?? [];
    let t = 0;
    for (let i = 0; i + 1 < run.length && t < total; i += 2) {
      const count = Math.max(0, run[i] | 0);
      const val = run[i + 1] ?? NO_INPUT;
      const end = Math.min(total, t + count);
      while (t < end) {
        out[t][slot] = val;
        t++;
      }
    }
  }
  return out;
}

/**
 * Records per-tick inputs for a Match. Supports rollback truncation (`truncate`) so online
 * matches record the exact confirmed input sequence that produced the final state.
 */
export class ReplayRecorder {
  private readonly ticks: number[][] = [];
  private cappedResult: ReplayResult | null = null;

  get length(): number {
    return this.ticks.length;
  }

  /** Called right before `step(s, inputs)` on each sim tick. */
  recordTick(inputs: number[]): boolean {
    if (this.ticks.length >= MAX_REPLAY_TICKS) return false;
    this.ticks.push(inputs.slice());
    return true;
  }

  /** Called right after `step(s, inputs)` and `checkObjective()` on the same tick. */
  afterTick(recorded: boolean, state: GameState): void {
    if (recorded && this.ticks.length === MAX_REPLAY_TICKS && !this.cappedResult) {
      this.cappedResult = snapshotResult(state);
    }
  }

  /** Used by `Match.restore(snap)` during online rollback so rolled-back ticks are replaced. */
  truncate(tickCount: number): void {
    const n = Math.max(0, Math.min(this.ticks.length, tickCount | 0));
    this.ticks.length = n;
    if (n < MAX_REPLAY_TICKS) this.cappedResult = null;
  }

  build(setup: MatchSetup, seed: number, state: GameState): Replay | null {
    if (this.ticks.length === 0) return null;
    const result = this.cappedResult ?? snapshotResult(state);
    return {
      v: 1,
      seed,
      setup: encodeReplaySetup(setup),
      ticks: this.ticks.length,
      runs: encodeReplayInputs(this.ticks, setup.slots.length),
      result,
      createdAt: Date.now(),
    };
  }
}

export type ReplaySpeed = 0.5 | 1 | 2;
export type ReplayCameraMode = 'follow' | 'free';

/** Plays a recorded `Replay` back through a real `Match` instance. */
export class ReplayPlayer {
  readonly replay: Replay;
  readonly inputs: number[][];
  match: Match;
  tick = 0;
  paused = false;
  speed: ReplaySpeed = 1;
  camera: ReplayCameraMode = 'follow';
  private acc = 0;

  constructor(replay: Replay) {
    this.replay = replay;
    this.inputs = decodeReplayInputs(replay);
    this.match = new Match(setupFromReplay(replay), replay.seed);
  }

  get state(): GameState {
    return this.match.state;
  }

  get totalTicks(): number {
    return this.inputs.length;
  }

  get done(): boolean {
    return this.tick >= this.inputs.length;
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  toggleCamera(): ReplayCameraMode {
    this.camera = this.camera === 'follow' ? 'free' : 'follow';
    return this.camera;
  }

  restart(): void {
    this.match = new Match(setupFromReplay(this.replay), this.replay.seed);
    this.tick = 0;
    this.acc = 0;
  }

  /** Jumps to `tick` (earlier or later) by rebuilding the match and stepping silently to it: the sim is deterministic. */
  seek(tick: number): void {
    const to = Math.max(0, Math.min(this.inputs.length, tick | 0));
    if (to < this.tick) this.restart();
    while (this.tick < to) this.stepOne();
    this.acc = 0;
  }

  /** Steps one recorded sim tick and returns its `SimEvent[]`. */
  stepOne(): SimEvent[] {
    if (this.tick >= this.inputs.length) return [];
    const inp = this.inputs[this.tick++];
    return this.match.tickInputs(inp);
  }

  /** Advances the replay by `dtMs` wall-clock milliseconds scaled by `this.speed`. */
  advance(dtMs: number): { ticks: number; events: SimEvent[] } {
    if (this.paused || this.done) return { ticks: 0, events: [] };
    const stepMs = 1000 / 60;
    this.acc += Math.min(100, Math.max(0, dtMs)) * this.speed;
    let ticks = 0;
    const events: SimEvent[] = [];
    while (this.acc + 1e-6 >= stepMs && !this.done && ticks < 8) {
      this.acc = Math.max(0, this.acc - stepMs);
      const ev = this.stepOne();
      if (ev.length) events.push(...ev);
      ticks++;
    }
    return { ticks, events };
  }

  /** Runs all remaining ticks to completion and returns the final `GameState`. */
  runToEnd(): GameState {
    while (!this.done) {
      this.stepOne();
    }
    return this.match.state;
  }
}

/** Trims a replay's ticks so its JSON fits within `maxBytes`, keeping `result` consistent with the trimmed ticks. */
export function boundReplay(replay: Replay, maxBytes = MAX_REPLAY_BYTES): { replay: Replay; json: string } {
  let json = JSON.stringify(replay);
  if (json.length <= maxBytes) return { replay, json };

  const allInputs = decodeReplayInputs(replay);
  let hi = allInputs.length;
  let lo = Math.min(60, hi);
  let bestTicks = lo;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidateRuns = encodeReplayInputs(allInputs.slice(0, mid), replay.setup.slots.length);
    const candidate: Replay = { ...replay, ticks: mid, runs: candidateRuns };
    const candidateJson = JSON.stringify(candidate);
    if (candidateJson.length <= maxBytes - 128) {
      bestTicks = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const trimmedInputs = allInputs.slice(0, bestTicks);
  const trimmedRuns = encodeReplayInputs(trimmedInputs, replay.setup.slots.length);
  const tempReplay: Replay = { ...replay, ticks: bestTicks, runs: trimmedRuns };
  const player = new ReplayPlayer(tempReplay);
  const finalState = player.runToEnd();
  const bounded: Replay = {
    ...tempReplay,
    result: snapshotResult(finalState),
  };
  json = JSON.stringify(bounded);
  return { replay: bounded, json };
}

/** Saves the last replay under `dod.profile.replay` with a bounded byte size. */
export function saveReplay(replay: Replay, maxBytes = MAX_REPLAY_BYTES): Replay {
  const { replay: bounded, json } = boundReplay(replay, maxBytes);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REPLAY_KEY, json);
    }
  } catch {
    // Storage full or unavailable
  }
  return bounded;
}

/** Reads the last saved replay from `dod.profile.replay`, or `null` if none / invalid. */
export function loadReplay(): Replay | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(REPLAY_KEY);
    if (!raw || raw.length > MAX_REPLAY_BYTES * 2) return null;
    const parsed = JSON.parse(raw) as Partial<Replay>;
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.seed !== 'number' ||
      typeof parsed.ticks !== 'number' ||
      parsed.ticks <= 0 ||
      !parsed.setup ||
      !Array.isArray(parsed.setup.slots) ||
      parsed.setup.slots.length === 0 ||
      !Array.isArray(parsed.runs) ||
      !parsed.result ||
      typeof parsed.result.hash !== 'number'
    ) {
      return null;
    }
    return parsed as Replay;
  } catch {
    return null;
  }
}
