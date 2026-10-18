// One online fight (docs/online.md, "The fight"): the Match run through the rollback (rollback.ts) with the inputs
// carried over the match room's link (room.ts). Both pages load, say "go", run the Ready… Go! count, then tick at
// 60 Hz. It ends when the sim's game is over on a frame both inputs are known for (so both sides end on the same
// frame), or early: the other player leaves (you win), the link is lost (you win, the match is reported as a
// disconnect), the states differ (desync: the match is void), or the other page never starts.

import { NO_INPUT } from '../sim/input.ts';
import { hashState } from '../sim/state.ts';
import { STAGES } from '../sim/stage.ts';
import { CHARACTERS } from '../sim/characters.ts';
import type { SimEvent } from '../sim/step.ts';
import type { Match, MatchSnapshot } from '../match.ts';
import { Rollback, type HashReport, type InputPacket } from './rollback.ts';
import type { Found } from './matchmaker.ts';
import { netError, now } from './util.ts';
import { emitMatchResult, type EndReason, type MatchResult } from './results.ts';

const START_TIMEOUT_MS = 45000;
const STALL_NOTICE_MS = 1500;
const LINGER_MS = 5000;

export interface FightEnd {
  reason: EndReason;
  /** The winning slot, or -1 (void, or the sim's draw). */
  winner: number;
  result: MatchResult;
}

export class OnlineFight {
  readonly found: Found;
  readonly match: Match;
  readonly rb: Rollback<MatchSnapshot>;
  readonly slot: number;
  readonly startedAt = now();
  phase: 'loading' | 'started' | 'done' = 'loading';
  private loaded = false;
  private theyLoaded = false;
  private fresh: SimEvent[] = [];
  private lastPacketAt = now();
  private stalledSince = 0;
  private playStartedAt = 0;
  private lingerTimer: ReturnType<typeof setInterval> | undefined;
  private unsubs: (() => void)[] = [];
  /** Called once when the fight ends, for any reason. */
  onEnd: ((end: FightEnd) => void) | null = null;
  /** Both pages are ready: run the Ready… Go! count. */
  onStart: (() => void) | null = null;

  constructor(found: Found, match: Match) {
    this.found = found;
    this.match = match;
    this.slot = found.slot;
    const m = match;
    this.rb = new Rollback<MatchSnapshot>(
      {
        save: () => m.snapshot(),
        load: (s) => m.restore(s),
        step: (inputs, fresh) => {
          const s = m.state;
          // Frozen once the game is over and its slowdown has run, so both sides stop on the same frame.
          if (s.over && s.endTimer === 0) return;
          const events = m.tickInputs(inputs);
          if (fresh) this.fresh.push(...events);
        },
        hash: (s) => hashState(s.state),
      },
      { slot: this.slot, noInput: NO_INPUT },
    );
    this.rb.onDesync = (frame, mine, theirs) => {
      netError(`fight ${found.setup.matchId}: desync at frame ${frame} (our hash ${mine.toString(16)}, theirs ${theirs.toString(16)}); the match is void`);
      this.end('desync', -1);
    };
    const room = found.room;
    this.unsubs.push(
      room.on('message', (msg: { kind: string; data: string }) => this.onMessage(msg.kind, msg.data)),
      room.on('closed', (e: { reason: string }) => {
        if (this.phase === 'done') return;
        netError(`fight ${found.setup.matchId}: the link to ${found.opponent.name} closed (${e.reason})`);
        this.end(e.reason === 'left' ? 'forfeit' : 'disconnect', this.slot);
      }),
    );
    setTimeout(() => {
      if (this.phase === 'loading') {
        netError(`fight ${found.setup.matchId}: ${found.opponent.name}'s game didn't start within ${START_TIMEOUT_MS / 1000} s`);
        this.end('no-start', -1);
      }
    }, START_TIMEOUT_MS);
  }

  get opponent(): string {
    return this.found.opponent.name;
  }

  /** Our page has loaded the match (art, sounds): tell the other side; start when both have. */
  markLoaded(): void {
    this.loaded = true;
    this.found.room.send('go', '', true);
    this.maybeStart();
  }

  private maybeStart(): void {
    if (this.phase !== 'loading' || !this.loaded || !this.theyLoaded) return;
    this.phase = 'started';
    this.onStart?.();
  }

  /** The Go! is shown: frames start running. */
  beginPlay(): void {
    this.playStartedAt = now();
    this.lastPacketAt = now();
  }

  private onMessage(kind: string, data: string): void {
    if (this.phase === 'done' && kind !== 'in') return;
    try {
      if (kind === 'in') {
        this.lastPacketAt = now();
        this.rb.receive(JSON.parse(data) as InputPacket);
      } else if (kind === 'h') {
        for (const r of JSON.parse(data) as HashReport[]) this.rb.receiveHash(r);
      } else if (kind === 'go') {
        // Their page also says "go" again on a reconnect; only the first counts.
        this.theyLoaded = true;
        this.maybeStart();
      } else if (kind === 'quit') {
        this.end('forfeit', this.slot);
      }
    } catch (e) {
      netError(`fight: a bad "${kind}" message from ${this.opponent}`, e);
    }
  }

  /** One tick of the 60 Hz clock with our input. Returns the sim events of frames run for the first time. */
  tick(input: number): SimEvent[] {
    if (this.phase !== 'started') return [];
    this.fresh = [];
    let result: 'ran' | 'stalled';
    try {
      result = this.rb.tick(input);
    } catch (e) {
      netError('fight: the rollback failed', e);
      this.end('desync', -1);
      return [];
    }
    this.flush();
    if (result === 'stalled') {
      if (!this.stalledSince) this.stalledSince = now();
    } else this.stalledSince = 0;
    if (this.final()) this.finishGame();
    return this.fresh;
  }

  private flush(): void {
    const room = this.found.room;
    room.send('in', JSON.stringify(this.rb.packet()), false);
    const hashes = this.rb.takeHashes();
    if (hashes.length) room.send('h', JSON.stringify(hashes), true);
  }

  /** "Waiting for <name>…" when the other side's inputs have stopped for a moment (a lag spike). */
  waiting(): string {
    if (this.phase === 'loading') return `Waiting for ${this.opponent}…`;
    if (this.phase !== 'started' || !this.stalledSince || now() - this.stalledSince < STALL_NOTICE_MS) return '';
    return `Waiting for ${this.opponent}… ${Math.round((now() - this.lastPacketAt) / 1000)} s`;
  }

  /** The round trip and how often frames are rolled back, for the HUD's small network line. */
  netLine(): string {
    const rtt = this.found.room.rttAvg;
    return `${rtt >= 0 ? `${Math.round(rtt)} ms` : '…'} · rollback ${this.rb.maxRolled}f`;
  }

  /** The game is over on a frame both sides' inputs are known for. */
  private final(): boolean {
    const s = this.match.state;
    return !!s.over && s.endTimer === 0 && this.rb.confirmed >= this.rb.frame - 1;
  }

  private finishGame(): void {
    const s = this.match.state;
    const winner = s.winner >= 0 ? s.winner : -1;
    this.end(s.timedOut ? 'time' : 'game', winner);
  }

  /** Leave the match: the other player wins. */
  forfeit(): void {
    if (this.phase === 'done') return;
    this.found.room.send('quit', '', true);
    this.end('forfeit', 1 - this.slot);
  }

  private end(reason: EndReason, winner: number): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    const setup = this.found.setup;
    const s = this.match.state;
    const result: MatchResult = {
      matchId: setup.matchId,
      self: setup.ids[this.slot],
      players: setup.ids.map((id, i) => ({ id, name: setup.names[i], avatar: setup.avatars[i], fighter: CHARACTERS[setup.chars[i]]?.id ?? '' })),
      winner: winner >= 0 ? setup.ids[winner] : null,
      reason,
      stage: STAGES[setup.stage]?.id ?? '',
      frames: s.frame,
      durationMs: this.playStartedAt ? now() - this.playStartedAt : 0,
      endedAt: new Date().toISOString(),
      stocks: s.fighters.map((f) => Math.max(0, f.stocks)),
    };
    const end: FightEnd = { reason, winner, result };
    try {
      emitMatchResult(result);
    } catch (e) {
      netError('fight: a match-result listener failed', e);
    }
    // Keep sending our last inputs for a moment, so the other side can confirm the same last frame, then hang up.
    let left = Math.ceil(LINGER_MS / 100);
    const room = this.found.room;
    this.lingerTimer = setInterval(() => {
      if (--left <= 0 || reason === 'forfeit' || reason === 'disconnect') {
        clearInterval(this.lingerTimer);
        for (const u of this.unsubs) u();
        room.close(reason === 'game' || reason === 'time' ? 'over' : reason);
        return;
      }
      this.flush();
    }, 100);
    this.onEnd?.(end);
  }

  dispose(): void {
    if (this.phase !== 'done') this.forfeit();
  }
}
