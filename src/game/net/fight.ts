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
import { Rollback, decodePacket, encodePacket, type HashReport, type InputPacket } from './rollback.ts';
import type { Found } from './matchmaker.ts';
import { netError, now } from './util.ts';
import { emitMatchResult, type EndReason, type MatchResult } from './results.ts';
import { profileKey } from './profile.ts';
import type { NostrKey } from './sign.ts';
import { checkRecord, resultBody, signBody, startBody, verifyBody, type ResultRecord } from './ratings.ts';

const START_TIMEOUT_MS = 45000;
const STALL_NOTICE_MS = 1500;
/** Their inputs stopped this long (their page still answers pings, so the room stays up): the match ends as a lost link. */
const STALL_GIVE_UP_MS = 20000;
const LINGER_MS = 5000;
/** How long the end waits for the other player's signature on the result. */
const SIGN_WAIT_MS = 6000;

export interface FightEnd {
  reason: EndReason;
  /** The winning slot, or -1 (void, or the sim's draw). */
  winner: number;
  result: MatchResult;
  /**
   * The signed result for the leaderboard (docs/online.md, "The leaderboard"), once the other player's signature is
   * in (or the wait ran out): `kind` says whether it counts as it is ("full", "claim") or carries only ours
   * ("partial": the leaderboard can show the expected change but nobody else will count it). null: not rated (void).
   */
  rated: Promise<{ record: ResultRecord; kind: 'full' | 'claim' | 'partial' } | null>;
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
  private readonly key: NostrKey;
  private readonly start: Pick<ResultRecord, 'm' | 'p' | 'f' | 's' | 't'>;
  private readonly startSigs: [string, string] = ['', ''];
  /** The other player's signature on the result, with the frame count they signed (a leaver's own). */
  private theirs: { n: number; sig: string; w: number; r: string } | null = null;
  private onTheirs: (() => void) | null = null;

  constructor(found: Found, match: Match, key: NostrKey = profileKey()) {
    this.found = found;
    this.match = match;
    this.slot = found.slot;
    this.key = key;
    const setup = found.setup;
    this.start = {
      m: setup.matchId,
      p: [setup.pids[0], setup.pids[1]],
      f: [CHARACTERS[setup.chars[0]]?.id ?? '', CHARACTERS[setup.chars[1]]?.id ?? ''],
      s: STAGES[setup.stage]?.id ?? '',
      t: setup.at,
    };
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
    // Loading the stage can freeze a page for seconds; the room must not call it silent meanwhile.
    room.silentMs = START_TIMEOUT_MS;
    this.unsubs.push(
      room.on('message', (msg: { kind: string; data: string }) => this.onMessage(msg.kind, msg.data)),
      // Inputs come as express frames (bytes: encodePacket), the moment the other side sends them.
      room.on('inputs', (b: Uint8Array) => {
        const p = decodePacket(b);
        if (!p || this.phase === 'done') return;
        this.lastPacketAt = now();
        this.rb.receive(p);
      }),
      room.on('closed', (e: { reason: string }) => {
        if (this.phase === 'done') return;
        netError(`fight ${found.setup.matchId}: the link to ${found.opponent.name} closed (${e.reason})`);
        // Before Go nobody has played: the match is void, never a win (no rating from quitting on the VS screen).
        if (!this.playStartedAt) return this.end('no-start', -1);
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
    // Our signature on the match's start goes with it: if we leave, the other player's "left" result needs it.
    try {
      this.startSigs[this.slot] = signBody(this.key.secret, startBody(this.start));
      this.found.room.send('ss', this.startSigs[this.slot], true);
    } catch (e) {
      netError('fight: signing the match start failed (this match will not be rated)', e);
    }
    this.found.room.send('go', '', true);
    this.maybeStart();
  }

  private maybeStart(): void {
    if (this.phase !== 'loading' || !this.loaded || !this.theyLoaded) return;
    this.phase = 'started';
    this.found.room.silentMs = 6000;
    this.found.room.lastHeard = now();
    this.onStart?.();
  }

  /** The Go! is shown: frames start running. */
  beginPlay(): void {
    this.playStartedAt = now();
    this.lastPacketAt = now();
  }

  private onMessage(kind: string, data: string): void {
    if (this.phase === 'done' && kind !== 'in' && kind !== 'rs') return;
    try {
      if (kind === 'ss') {
        const other = 1 - this.slot;
        if (verifyBody(this.start.p[other], startBody(this.start), data)) this.startSigs[other] = data;
        else netError(`fight ${this.start.m}: ${this.opponent}'s start signature doesn't check out`);
        return;
      }
      if (kind === 'rs') {
        const rs = JSON.parse(data) as { n: number; sig: string; w: number; r: string; st?: string };
        const other = 1 - this.slot;
        // Their start signature rides along, in case the one sent at load time was missed.
        if (!this.startSigs[other] && typeof rs.st === 'string' && verifyBody(this.start.p[other], startBody(this.start), rs.st)) this.startSigs[other] = rs.st;
        if (Number.isInteger(rs.n) && typeof rs.sig === 'string') {
          this.theirs = rs;
          this.onTheirs?.();
        }
        return;
      }
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
        this.end(this.playStartedAt ? 'forfeit' : 'no-start', this.playStartedAt ? this.slot : -1);
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
      if (now() - this.lastPacketAt > STALL_GIVE_UP_MS) {
        netError(`fight ${this.found.setup.matchId}: no inputs from ${this.opponent} for ${STALL_GIVE_UP_MS / 1000} s`);
        this.end('disconnect', this.slot);
        return [];
      }
    } else this.stalledSince = 0;
    if (this.final()) this.finishGame();
    return this.fresh;
  }

  private flush(): void {
    const room = this.found.room;
    // Every frame, every input they haven't acknowledged: a lost packet costs nothing (the next carries it too).
    room.sendInputs(encodePacket(this.rb.packet()));
    const hashes = this.rb.takeHashes();
    if (hashes.length) room.send('h', JSON.stringify(hashes), true);
  }

  /** "Waiting for <name>…" when the other side's inputs have stopped for a moment (a lag spike). */
  waiting(): string {
    if (this.phase === 'loading') return `Waiting for ${this.opponent}…`;
    if (this.phase !== 'started' || !this.stalledSince || now() - this.stalledSince < STALL_NOTICE_MS) return '';
    return `Waiting for ${this.opponent}… ${Math.round((now() - this.lastPacketAt) / 1000)} s`;
  }

  /** The round trip, the route and how often frames are rolled back, for the HUD's small network line. */
  netLine(): string {
    const room = this.found.room;
    const rtt = room.rttAvg;
    return `${rtt >= 0 ? `${Math.round(rtt)} ms` : '…'}${room.route ? ` ${room.route}` : ''} · rollback ${this.rb.maxRolled}f`;
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

  /** Leave the match: the other player wins (before Go the match is void instead, and no loss is signed). */
  forfeit(): void {
    if (this.phase === 'done') return;
    if (!this.playStartedAt) {
      this.found.room.send('quit', '', true);
      this.end('no-start', -1);
      return;
    }
    // We sign our own loss before we go, so the result counts in full.
    const sig = this.sign(this.body('left', 1 - this.slot, this.match.state.frame));
    if (sig) this.found.room.send('rs', JSON.stringify({ n: this.match.state.frame, sig, w: 1 - this.slot, r: 'left', st: this.startSigs[this.slot] }), true);
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
      players: setup.ids.map((id, i) => ({ id, pid: setup.pids[i], name: setup.names[i], avatar: setup.avatars[i], fighter: CHARACTERS[setup.chars[i]]?.id ?? '' })),
      winner: winner >= 0 ? setup.ids[winner] : null,
      reason,
      stage: STAGES[setup.stage]?.id ?? '',
      frames: s.frame,
      durationMs: this.playStartedAt ? now() - this.playStartedAt : 0,
      endedAt: new Date().toISOString(),
      stocks: s.fighters.map((f) => Math.max(0, f.stocks)),
    };
    const end: FightEnd = { reason, winner, result, rated: this.rate(reason, winner) };
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

  private body(r: ResultRecord['r'], w: number, n: number): Omit<ResultRecord, 'sig' | 'st'> {
    return { ...this.start, w, n, r };
  }

  private readonly signed = new Map<string, string>();

  /** Our signature on a result body (one per body: Schnorr signatures differ each time, and both copies should match). */
  private sign(body: Omit<ResultRecord, 'sig' | 'st'>): string {
    const text = resultBody(body);
    const old = this.signed.get(text);
    if (old) return old;
    try {
      const sig = signBody(this.key.secret, text);
      this.signed.set(text, sig);
      return sig;
    } catch (e) {
      netError('fight: signing the result failed (this match will not be rated)', e);
      return '';
    }
  }

  /**
   * The leaderboard's signed result: we sign it, send our signature, and wait a moment for theirs. A game or time
   * end needs both; a forfeit or a lost link is a "left" result the winner signs, with the leaver's signature on it
   * (they sign before quitting) or on the start. Void ends aren't rated.
   */
  private rate(reason: EndReason, winner: number): FightEnd['rated'] {
    if (reason === 'desync' || reason === 'no-start' || !this.start.p[0] || !this.start.p[1]) return Promise.resolve(null);
    const left = reason === 'forfeit' || reason === 'disconnect';
    const r: ResultRecord['r'] = left ? 'left' : reason;
    const other = 1 - this.slot;
    const make = (): { record: ResultRecord; kind: 'full' | 'claim' | 'partial' } | null => {
      // A leaver signs the frame they left on; the winner signs the same body.
      const n = left && this.theirs && this.theirs.r === 'left' ? this.theirs.n : this.match.state.frame;
      const body = this.body(r, winner, n);
      const sigs: [string, string] = ['', ''];
      sigs[this.slot] = this.sign(body);
      if (!sigs[this.slot]) return null;
      if (this.theirs && verifyBody(this.start.p[other], resultBody(body), this.theirs.sig)) sigs[other] = this.theirs.sig;
      const record: ResultRecord = { ...body, sig: sigs, st: [this.startSigs[0], this.startSigs[1]] };
      return { record, kind: checkRecord(record) ?? 'partial' };
    };
    const first = make();
    if (!first) return Promise.resolve(null);
    // Ours goes to the other side (a forfeit already sent its own before quitting).
    if (!(reason === 'forfeit' && winner !== this.slot)) {
      this.found.room.send('rs', JSON.stringify({ n: first.record.n, sig: first.record.sig[this.slot], w: winner, r, st: this.startSigs[this.slot] }), true);
    }
    if (first.kind === 'full' || reason === 'disconnect' || (left && winner !== this.slot)) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.onTheirs = null;
        const next = make();
        if (next && next.kind === 'partial' && winner === this.slot) {
          // They never confirmed their loss: it stands as a "left" result on our signature and their start.
          netError(`fight ${this.start.m}: ${this.opponent} didn't sign the result; it counts as them leaving`);
          const body = this.body('left', winner, this.match.state.frame);
          const sigs: [string, string] = ['', ''];
          sigs[this.slot] = this.sign(body);
          const record: ResultRecord = { ...body, sig: sigs, st: [this.startSigs[0], this.startSigs[1]] };
          resolve({ record, kind: checkRecord(record) ?? 'partial' });
          return;
        }
        if (next && next.kind === 'partial' && this.theirs) netError(`fight ${this.start.m}: ${this.opponent}'s result signature doesn't match ours (frames ${this.theirs.n} vs ${next.record.n})`);
        resolve(next);
      };
      const timer = setTimeout(done, SIGN_WAIT_MS);
      this.onTheirs = () => {
        const next = make();
        if (next && next.kind !== 'partial') done();
      };
    });
  }

  dispose(): void {
    if (this.phase !== 'done') this.forfeit();
  }
}
