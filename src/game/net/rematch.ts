// Rematch (docs/online.md, "Rematch"): after a finished online game the two players stay in the same match room and can
// run it back. Both press Rematch within REMATCH_MS of the result, each picks a fighter (PICK_MS, defaulting to the
// last one), the loser of the last game picks the stage (a draw: the host's random pick from the legal Versus list),
// and the host sends the new match's setup. A "no" (Queue again, Main menu), the room closing or the clock running out
// ends it, and the page shows who left. Every game is its own match id with its own signatures, so ratings stay per game.
//
// Messages (reliable, on the match room): "rm" { a: "want" | "no" }, "rp" { c: fighter id, l: look, s: stage id | "" }
// (a pick, once, when locked in), "rn" (the host's OnlineSetup for the new game).

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { stagesFor } from '../modes.ts';
import { lookCount, separateLooks } from '../looks.ts';
import type { OnlineSetup } from './matchmaker.ts';
import { Emitter, netError, randomId, seconds } from './util.ts';

/** How long after the result both players have to press Rematch. */
export const REMATCH_MS = 15000;
/** How long the fighter pick runs (it locks the default when it ends). */
export const PICK_MS = 12000;
/** After both have locked, the guest waits this long for the host's setup. */
const SETUP_WAIT_MS = 8000;

export type RematchPhase = 'open' | 'waiting' | 'picking' | 'locked' | 'starting' | 'declined' | 'timeout' | 'closed';

/** The part of PairRoom this needs (so a test can stand in for it). */
export interface RematchRoom {
  closed: boolean;
  send(kind: string, data: string, reliable?: boolean): boolean;
  on(type: string, handler: (v: any) => void): () => void;
  close(reason?: string, tell?: boolean): void;
}

export interface RematchPick {
  char: number;
  look: number;
  /** Index into STAGES; only the loser's counts. undefined: random. */
  stage?: number;
}

export interface RematchInit {
  room: RematchRoom;
  slot: number;
  /** The game that just ended. */
  prev: OnlineSetup;
  /** Its winning slot, -1 for a draw. */
  winner: number;
  /** This player's fighter in that game (the pick's default). */
  char: number;
  look: number;
  opponent: string;
  /** For a stand-in clock. */
  clock?: () => number;
}

/** Slot of the player who picks the stage: the loser of the last game, or -1 (a draw: random). */
export function stagePicker(winner: number): number {
  return winner === 0 ? 1 : winner === 1 ? 0 : -1;
}

/**
 * The new game's setup (the host builds it): the picks' fighters and colours, the stage the loser chose when it is in
 * the Versus list, else a random one from it (the seed picks), a new match id, seed and start time.
 */
export function rematchSetup(prev: OnlineSetup, picks: [RematchPick, RematchPick], winner: number, random: () => number = Math.random): OnlineSetup {
  const stages = stagesFor('versus');
  const slots = picks.map((p) => ({ char: p.char, look: p.look }));
  separateLooks(slots);
  const seed = (random() * 0x7fffffff) | 0;
  const chosen = stagePicker(winner) >= 0 ? picks[stagePicker(winner)].stage : undefined;
  const asked = chosen === undefined ? undefined : stages.find((s) => s.index === chosen);
  const entry = asked ?? (stages.length ? stages[Math.abs(seed) % stages.length] : null);
  return {
    ...prev,
    matchId: `${prev.ids[0]}-${prev.ids[1]}-${randomId(6)}`,
    seed,
    stage: entry?.index ?? prev.stage,
    rules: entry?.entry.rules ?? prev.rules,
    chars: slots.map((s) => s.char),
    looks: slots.map((s) => s.look ?? 0),
    at: seconds(),
  };
}

/** The legal stages for the pick (Versus list), with their names. */
export function rematchStages(): { index: number; name: string }[] {
  return stagesFor('versus').map((s) => ({ index: s.index, name: s.entry.name ?? STAGES[s.index].name }));
}

/**
 * Events: "phase" (RematchPhase), "tick" (seconds left on the running clock), "start" (OnlineSetup: both are in, the new
 * game starts), "end" ({ reason: "declined" | "timeout" | "closed", who }): the rematch is over, show who left.
 */
export class Rematch extends Emitter {
  phase: RematchPhase = 'open';
  /** Whether they have pressed Rematch (and we have). */
  theyWant = false;
  weWant = false;
  readonly picks: [RematchPick | null, RematchPick | null] = [null, null];
  private readonly init: RematchInit;
  private readonly now: () => number;
  private deadline = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubs: (() => void)[] = [];
  private draft: RematchPick;

  constructor(init: RematchInit) {
    super();
    this.init = init;
    this.now = init.clock ?? (() => Date.now());
    this.draft = { char: init.char, look: init.look };
    const room = init.room;
    this.unsubs.push(
      room.on('message', (m: { kind: string; data: string }) => this.onMessage(m.kind, m.data)),
      // Gone for good (they left the page, or the link did not come back).
      room.on('closed', () => this.over('closed')),
    );
    if (room.closed) this.over('closed');
    else this.runClock(REMATCH_MS, () => this.over('timeout'));
  }

  get slot(): number {
    return this.init.slot;
  }
  get opponent(): string {
    return this.init.opponent;
  }
  /** Who picks the stage this time: our slot, theirs, or -1 (random). */
  get picker(): number {
    return stagePicker(this.init.winner);
  }
  get iPickStage(): boolean {
    return this.picker === this.init.slot;
  }
  get active(): boolean {
    return this.phase === 'open' || this.phase === 'waiting' || this.phase === 'picking' || this.phase === 'locked';
  }
  /** The pick as it stands before it is locked. */
  get current(): RematchPick {
    return this.draft;
  }

  private setPhase(p: RematchPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emit('phase', p);
  }

  private runClock(ms: number, onEnd: () => void): void {
    clearInterval(this.ticker);
    this.deadline = this.now() + ms;
    const tick = () => {
      const left = Math.max(0, Math.ceil((this.deadline - this.now()) / 1000));
      this.emit('tick', left);
      if (this.now() >= this.deadline) {
        clearInterval(this.ticker);
        onEnd();
      }
    };
    this.ticker = setInterval(tick, 250);
    this.emit('tick', Math.ceil(ms / 1000));
  }

  secondsLeft(): number {
    return Math.max(0, Math.ceil((this.deadline - this.now()) / 1000));
  }

  /** Rematch pressed. */
  press(): void {
    if (this.phase !== 'open' || this.init.room.closed) return;
    this.weWant = true;
    this.init.room.send('rm', JSON.stringify({ a: 'want' }), true);
    if (this.theyWant) this.beginPick();
    else this.setPhase('waiting');
  }

  /** We leave the rematch (Queue again, Main menu): they are told, the room is let go. */
  decline(): void {
    if (this.phase === 'starting') return;
    if (!this.active) return this.cleanup();
    if (!this.init.room.closed) this.init.room.send('rm', JSON.stringify({ a: 'no' }), true);
    this.cleanup(true);
    this.setPhase('closed');
  }

  /** Changes the fighter before it is locked (the colour follows `look`). */
  choose(char: number, look: number): void {
    if (this.phase !== 'picking') return;
    this.draft = { ...this.draft, char, look: Math.max(0, Math.min(look, lookCount(char) - 1)) };
    this.emit('draft', this.draft);
  }

  chooseStage(stage: number | undefined): void {
    if (this.phase !== 'picking') return;
    this.draft = { ...this.draft, stage };
    this.emit('draft', this.draft);
  }

  private beginPick(): void {
    this.setPhase('picking');
    this.runClock(PICK_MS, () => this.lock());
  }

  /** Locks the pick in (also what the pick's clock does with the default). */
  lock(): void {
    if (this.phase !== 'picking') return;
    const pick = this.draft;
    this.picks[this.init.slot] = pick;
    const stage = this.iPickStage && pick.stage !== undefined ? STAGES[pick.stage]?.id ?? '' : '';
    this.init.room.send('rp', JSON.stringify({ c: CHARACTERS[pick.char].id, l: pick.look, s: stage }), true);
    this.setPhase('locked');
    // The other pick has this long (their clock plus the network) before the rematch is called off.
    this.runClock(PICK_MS + 4000, () => this.over('timeout'));
    this.maybeSetup();
  }

  private onMessage(kind: string, data: string): void {
    if (!this.active && this.phase !== 'starting') return;
    try {
      if (kind === 'rm') {
        const a = (JSON.parse(data) as { a?: string }).a;
        if (a === 'no') return this.over('declined');
        if (a === 'want' && !this.theyWant) {
          this.theyWant = true;
          if (this.weWant && this.phase === 'waiting') this.beginPick();
        }
      } else if (kind === 'rp') {
        const m = JSON.parse(data) as { c?: string; l?: number; s?: string };
        const char = CHARACTERS.findIndex((c) => c.id === m.c);
        if (char < 0 || !this.theyWant) return;
        const l = Number.isInteger(m.l) ? (m.l as number) : 0;
        const stage = m.s ? STAGES.findIndex((s) => s.id === m.s) : -1;
        this.picks[1 - this.init.slot] = { char, look: Math.max(0, Math.min(l, lookCount(char) - 1)), stage: stage >= 0 ? stage : undefined };
        this.maybeSetup();
      } else if (kind === 'rn') {
        if (this.init.slot === 0) return; // (only the host decides)
        const setup = JSON.parse(data) as OnlineSetup;
        const mine = this.picks[this.init.slot];
        const theirs = this.picks[1 - this.init.slot];
        if (!mine || !theirs || !this.sane(setup, mine)) return netError('rematch: the host sent a setup that does not fit our picks');
        this.go(setup);
      }
    } catch (e) {
      netError(`rematch: a bad "${kind}" message from ${this.init.opponent}`, e);
    }
  }

  /** A guest checks the host's setup before playing it: same players, our own fighter as picked, a stage that exists. */
  private sane(s: OnlineSetup, mine: RematchPick): boolean {
    const p = this.init.prev;
    return (
      Array.isArray(s.chars) && s.chars[this.init.slot] === mine.char &&
      s.ids?.[0] === p.ids[0] && s.ids?.[1] === p.ids[1] && s.pids?.[0] === p.pids[0] && s.pids?.[1] === p.pids[1] &&
      typeof s.matchId === 'string' && s.matchId !== p.matchId && !!STAGES[s.stage] && Number.isFinite(s.seed)
    );
  }

  private maybeSetup(): void {
    if (this.phase !== 'locked') return;
    const [a, b] = this.picks;
    if (!a || !b) return;
    if (this.init.slot === 0) {
      const setup = rematchSetup(this.init.prev, [a, b], this.init.winner);
      this.init.room.send('rn', JSON.stringify(setup), true);
      this.go(setup);
    } else {
      // The host's setup follows; if it never does the rematch is off.
      clearInterval(this.ticker);
      clearTimeout(this.setupTimer);
      this.setupTimer = setTimeout(() => this.over('timeout'), SETUP_WAIT_MS);
    }
  }

  private go(setup: OnlineSetup): void {
    if (this.phase !== 'locked') return;
    this.cleanup();
    this.setPhase('starting');
    this.emit('start', setup);
  }

  /** The rematch is off (the room is let go). */
  private over(reason: 'declined' | 'timeout' | 'closed'): void {
    if (!this.active) return;
    this.cleanup(true);
    this.setPhase(reason);
    this.emit('end', { reason, weWant: this.weWant, theyWant: this.theyWant });
  }

  private cleanup(closeRoom = false): void {
    clearInterval(this.ticker);
    clearTimeout(this.setupTimer);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (closeRoom) this.init.room.close('over', false);
  }
}
