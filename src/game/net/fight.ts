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
import { agreedDelay, barsFor } from './quality.ts';
import { TEST_FIXED_DELAY } from './room.ts';
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

/** The fight in progress on this page (the playtest's way to cut its connection). */
let current: OnlineFight | null = null;

/** Playtest setup shortcut: cut this page's match connection for `ms`, then join again as the same player. */
export async function cutLink(ms: number): Promise<boolean> {
  const f = current;
  if (!f || f.phase !== 'started') return false;
  await f.found.room.cutFor(ms);
  return true;
}

/** Playtest: the running fight's delay, ping and rollback counts, or null between fights. */
export function fightStats(): ReturnType<OnlineFight['stats']> | null {
  return current && current.phase === 'started' ? current.stats() : null;
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
  /** Input delay in frames, agreed before Go: the host picks it from the worse of the two measured pings and sends it ("dl"). 0 until known. */
  delay = 0;
  /** The pings the delay came from (ms, -1 unknown): ours, theirs. */
  delayFrom: [number, number] = [-1, -1];
  /** The guest's ping, as it sent it with its "go". */
  private guestRtt = -1;
  /** The other player's own reading of the link (they send it every 2 s), -1 until the first. */
  theirRtt = -1;
  /** Ticks that stalled in the last ~3 s (a ring of seconds), for the bars. */
  private stallSecs: number[] = [0, 0, 0];
  private stallSecAt = 0;
  private ticksSent = 0;
  /** Playtest counters: stalled ticks over the match, ticks that ran. */
  stallTicks = 0;
  ranTicks = 0;
  /** The rejoin window while a player is away (the sim does not run), else null. */
  reconnect: { who: string; cause: string; until: number; drops: number; since: number } | null = null;
  /** How many times play went on after a drop. */
  resumes = 0;
  private playStartedAt = 0;
  private lingerTimer: ReturnType<typeof setInterval> | undefined;
  private unsubs: (() => void)[] = [];
  /** Set by the page while it ends the fight: after a finished game (not a quit or a lost link) the room is left open for a rematch, whose session closes it. */
  holdRoom = false;
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
    current = this;
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
        // Said goodbye, or dropped for the third time: a quit, rated. Didn't come back in time: a disconnect, not rated.
        // (Ours the same way round: if it was our connection that didn't come back, the win is theirs.)
        const ours = e.reason === 'self-dropped' || e.reason === 'self-repeat';
        const quit = e.reason === 'left' || e.reason === 'repeat' || e.reason === 'self-repeat';
        this.end(quit ? 'forfeit' : 'disconnect', ours ? 1 - this.slot : this.slot);
      }),
      // A drop opens the room's rejoin window: the sim waits on both sides until the player is back or it runs out.
      room.on('away', (e: { who: string; cause: string; until: number; drops: number }) => {
        if (this.phase === 'done' || !this.playStartedAt) return;
        this.reconnect = { ...e, since: now() };
        netError(`fight ${found.setup.matchId}: ${e.who === 'self' ? 'our' : `${found.opponent.name}'s`} connection dropped (${e.cause}); waiting up to ${Math.round((e.until - now()) / 1000)} s`);
        this.note('away', e.who, e.cause, e.drops);
      }),
      room.on('back', (e: { who: string; ms: number }) => {
        if (!this.reconnect) return;
        this.reconnect = null;
        // Both sides pick up from the last confirmed frame: whatever was guessed past it is re-run when their inputs
        // (resent from the last one acknowledged) arrive, so stocks and percents are exactly where they were.
        this.lastPacketAt = now();
        this.stalledSince = 0;
        this.resumes++;
        this.note('back', e.who, '', Math.round(e.ms));
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
    this.found.room.send('go', String(Math.round(this.found.room.rttAvg)), true);
    this.maybeStart();
  }

  private maybeStart(): void {
    if (this.phase !== 'loading' || !this.loaded || !this.theyLoaded) return;
    this.phase = 'started';
    if (this.slot === 0) this.pickDelay();
    this.found.room.silentMs = 6000;
    this.found.room.lastHeard = now();
    this.onStart?.();
  }

  /** Host: the delay from both pings, sent to the guest, applied here. */
  private pickDelay(): void {
    const mine = this.found.room.rttAvg;
    const d = TEST_FIXED_DELAY || agreedDelay(mine, this.guestRtt);
    this.delayFrom = [mine, this.guestRtt];
    this.setDelay(d);
    this.found.room.send('dl', JSON.stringify({ d, h: Math.round(mine), g: Math.round(this.guestRtt) }), true);
  }

  private setDelay(d: number): void {
    this.delay = d;
    this.rb.setDelay(d);
    try {
      window.dispatchEvent(new CustomEvent('dod:net-delay', { detail: { delay: d, hostRtt: this.delayFrom[0], guestRtt: this.delayFrom[1], slot: this.slot } }));
    } catch {
      /* (no window: a test) */
    }
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
      } else if (kind === 'dl') {
        // The host's choice: the same number on both sides, or the sims would drift apart.
        const o = JSON.parse(data) as { d: number; h: number; g: number };
        if (this.slot === 1 && !this.delay && Number.isInteger(o.d) && o.d >= 1 && o.d <= 4) {
          this.delayFrom = [o.h, o.g];
          this.setDelay(o.d);
        }
      } else if (kind === 'pg') {
        const v = Number(data);
        if (Number.isFinite(v)) this.theirRtt = v;
      } else if (kind === 'go') {
        // Their page also says "go" again on a reconnect; only the first counts.
        if (this.slot === 0 && !this.theyLoaded) this.guestRtt = Number(data) || -1;
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
    // The guest waits for the host's delay (it comes within a ping of the start, well before Go finishes).
    if (!this.delay) return [];
    if (this.reconnect) {
      // Paused on both sides: the sim stands still on its last frame, and we keep sending what they haven't got.
      this.flush();
      return [];
    }
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
    this.countTick(result);
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

  private countTick(result: 'ran' | 'stalled'): void {
    const t = now();
    if (!this.stallSecAt || t - this.stallSecAt >= 1000) {
      this.stallSecAt = t;
      this.stallSecs.shift();
      this.stallSecs.push(0);
    }
    if (result === 'stalled') {
      this.stallTicks++;
      this.stallSecs[this.stallSecs.length - 1]++;
    } else this.ranTicks++;
    // Our own reading of the link goes to them every ~2 s, for the bar by our name on their screen.
    if (++this.ticksSent % 120 === 0) this.found.room.send('pg', String(Math.round(this.found.room.rttAvg)), true);
  }

  /** 0 (no reading yet) to 4 bars for a slot's connection, from the room's heartbeat ping. A stall in the last 3 s costs one. */
  barsOf(slot: number): number {
    const rtt = slot === this.slot ? this.found.room.rttAvg : this.theirRtt >= 0 ? this.theirRtt : this.found.room.rttAvg;
    const stalling = this.stallSecs.reduce((a, b) => a + b, 0) >= 6;
    return barsFor(rtt, stalling);
  }

  /** Numbers for the playtest: delay, ping and rollback counts. */
  stats(): { delay: number; ping: number; rollbacks: number; rolledFrames: number; maxRolled: number; stalls: number; stallTicks: number; ranTicks: number } {
    return { delay: this.delay, ping: Math.round(this.found.room.rttAvg), rollbacks: this.rb.rollbacks, rolledFrames: this.rb.rolledFrames, maxRolled: this.rb.maxRolled, stalls: this.rb.stalls, stallTicks: this.stallTicks, ranTicks: this.ranTicks };
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
    if (this.reconnect) return `Reconnecting… ${this.found.room.secondsLeft()} s`;
    if (this.phase !== 'started' || !this.stalledSince || now() - this.stalledSince < STALL_NOTICE_MS) return '';
    return `Waiting for ${this.opponent}… ${Math.round((now() - this.lastPacketAt) / 1000)} s`;
  }

  /** The text and feel of a drop for the playtest and the page: `dod:reconnect`. */
  private note(phase: 'away' | 'back', who: string, cause: string, n: number): void {
    try {
      const s = this.match.state;
      window.dispatchEvent(new CustomEvent('dod:reconnect', { detail: { phase, who, cause, n, frame: s.frame, stocks: s.fighters.map((f) => f.stocks), percents: s.fighters.map((f) => f.percent) } }));
    } catch {
      /* (no window: a test) */
    }
  }

  /** The round trip, the route and how often frames are rolled back, for the HUD's small network line. */
  netLine(): string {
    const room = this.found.room;
    const rtt = room.rttAvg;
    return `${rtt >= 0 ? `${Math.round(rtt)} ms` : '…'}${room.route ? ` ${room.route}` : ''} · delay ${this.delay}f · rollback ${this.rb.maxRolled}f`;
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
    this.reconnect = null;
    if (current === this) current = null;
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
        if (this.holdRoom && (reason === 'game' || reason === 'time')) return;
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
    // A disconnect (a drop that outlasted the rejoin window) is recorded as one but never rated: only a quit is.
    if (reason === 'desync' || reason === 'no-start' || reason === 'disconnect' || !this.start.p[0] || !this.start.p[1]) return Promise.resolve(null);
    const left = reason === 'forfeit';
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
    if (first.kind === 'full' || (left && winner !== this.slot)) return Promise.resolve(first);
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
