// Rollback netcode for a two-player online match (docs/online.md, "The fight"). The sim (src/game/sim) is integer-only
// and its whole state can be saved and restored, so each player runs the match at full speed on their own inputs and a
// guess of the other's (their last one). When the real input arrives and the guess was wrong, the sim goes back to
// that frame and runs forward again with it: a rollback. Nothing here touches the network or the page; online.ts
// carries the packets.
//
// - Input delay: local inputs apply DELAY frames late, which hides most of a round trip without rollbacks.
// - Rollback window: at most MAX_ROLLBACK frames past the last frame both inputs are known for. Further ahead the
//   player waits for the other (a lag spike stalls the match instead of drifting apart).
// - Time sync: each side reports how far ahead it runs; the one further ahead skips a frame now and then.
// - Desync check: every HASH_EVERY frames that both inputs are known for, each side hashes its state and sends it;
//   a different hash is reported (onDesync), never ignored.

export interface Simulation<S> {
  /** A copy of the whole state, to come back to. */
  save(): S;
  load(snapshot: S): void;
  /** Runs one frame. `fresh` is false when frames are run again after a rollback (no sounds, no effects). */
  step(inputs: number[], fresh: boolean): void;
  /** The desync hash of a saved state. */
  hash(snapshot: S): number;
}

/** What one side sends the other every frame (over the unreliable channel; each packet repeats what wasn't acked). */
export interface InputPacket {
  /** The frame of i[0]. */
  f: number;
  /** Local inputs for frames f, f+1, ... */
  i: number[];
  /** The highest frame of the other side's inputs the sender has (all before it too). */
  a: number;
  /** The sender's current frame. */
  n: number;
  /** How many frames the sender runs ahead of the receiver, as the sender sees it. */
  v: number;
}

export interface HashReport {
  f: number;
  h: number;
}

export interface RollbackOptions {
  /** This player's slot: 0 (host) or 1. */
  slot: number;
  delay?: number;
  maxRollback?: number;
  hashEvery?: number;
  noInput: number;
}

export const DELAY = 2;
export const MAX_ROLLBACK = 8;
export const HASH_EVERY = 30;
const MAX_PACKET_INPUTS = 120;

export class Rollback<S> {
  readonly slot: number;
  readonly delay: number;
  readonly maxRollback: number;
  readonly hashEvery: number;
  private readonly noInput: number;
  private readonly sim: Simulation<S>;

  /** The next frame to run. */
  frame = 0;
  /** Local inputs by frame. */
  private readonly local: number[] = [];
  /** The other side's inputs by frame, with no gaps. */
  private readonly remote: number[] = [];
  /** The other side's inputs that arrived ahead of a gap. */
  private readonly early = new Map<number, number>();
  /** The guess used for the other side's input on frames run before it arrived. */
  private readonly guessed = new Map<number, number>();
  /** Saved state before each frame that may still be rolled back to. */
  private readonly snaps = new Map<number, S>();
  /** The earliest frame run on a wrong guess, or -1. */
  private wrongFrom = -1;
  /** The highest of our frames the other side has acknowledged. */
  private acked = -1;
  private remoteFrame = 0;
  private remoteAdvantage = 0;
  private nextHash: number;
  private readonly myHashes = new Map<number, number>();
  private readonly theirHashes = new Map<number, number>();
  private readonly outHashes: HashReport[] = [];
  private ticks = 0;

  // Counters for the HUD's network line and the playtest log.
  rollbacks = 0;
  rolledFrames = 0;
  maxRolled = 0;
  stalls = 0;
  syncSkips = 0;
  hashesMatched = 0;
  desyncAt = -1;
  onDesync: ((frame: number, mine: number, theirs: number) => void) | null = null;

  constructor(sim: Simulation<S>, opts: RollbackOptions) {
    this.sim = sim;
    this.slot = opts.slot;
    this.delay = opts.delay ?? DELAY;
    this.maxRollback = opts.maxRollback ?? MAX_ROLLBACK;
    this.hashEvery = opts.hashEvery ?? HASH_EVERY;
    this.noInput = opts.noInput;
    this.nextHash = this.hashEvery - 1;
    for (let f = 0; f < this.delay; f++) this.local.push(this.noInput);
  }

  /** The last frame both inputs are known for (everything up to it is final). */
  get confirmed(): number {
    return this.remote.length - 1;
  }

  /** How many frames this side runs ahead of the other. */
  get advantage(): number {
    return this.frame - this.remoteFrame;
  }

  /**
   * One tick of the 60 Hz clock with this player's input. Runs a frame ('ran') or waits for the other side
   * ('stalled': too far ahead of their inputs, or skipping a frame to let them catch up).
   */
  tick(input: number): 'ran' | 'stalled' {
    this.ticks++;
    this.resolve();
    if (this.frame - this.confirmed > this.maxRollback) {
      this.stalls++;
      return 'stalled';
    }
    // Both sides see the gap from their own end; half the difference is how far apart the clocks really are.
    const drift = (this.advantage - this.remoteAdvantage) / 2;
    if (drift >= 1.5 && this.ticks % 8 === 0) {
      this.syncSkips++;
      return 'stalled';
    }
    this.local[this.frame + this.delay] = input;
    this.run(this.frame, true);
    this.frame++;
    this.checkHashes();
    this.prune();
    return 'ran';
  }

  /** Re-runs from the first wrong guess, so everything up to `confirmed` is final. */
  private resolve(): void {
    if (this.wrongFrom < 0) return;
    const from = this.wrongFrom;
    this.wrongFrom = -1;
    const snap = this.snaps.get(from);
    if (snap === undefined) throw new Error(`rollback: no saved state for frame ${from} (now ${this.frame})`);
    this.sim.load(snap);
    const count = this.frame - from;
    for (let f = from; f < this.frame; f++) this.run(f, false);
    this.rollbacks++;
    this.rolledFrames += count;
    this.maxRolled = Math.max(this.maxRolled, count);
    this.checkHashes();
  }

  private run(f: number, fresh: boolean): void {
    this.snaps.set(f, this.sim.save());
    let theirs: number;
    if (f < this.remote.length) {
      theirs = this.remote[f];
      this.guessed.delete(f);
    } else {
      theirs = this.remote.length ? this.remote[this.remote.length - 1] : this.noInput;
      this.guessed.set(f, theirs);
    }
    const mine = this.local[f] ?? this.noInput;
    this.sim.step(this.slot === 0 ? [mine, theirs] : [theirs, mine], fresh);
  }

  /** The state after frame f, when it's still around. */
  private stateAfter(f: number): S | undefined {
    if (f + 1 === this.frame) return this.sim.save();
    return this.snaps.get(f + 1);
  }

  private checkHashes(): void {
    while (this.nextHash <= this.confirmed && this.nextHash < this.frame) {
      const snap = this.stateAfter(this.nextHash);
      if (snap === undefined) break;
      const h = this.sim.hash(snap);
      this.myHashes.set(this.nextHash, h);
      this.outHashes.push({ f: this.nextHash, h });
      this.compare(this.nextHash);
      this.nextHash += this.hashEvery;
    }
  }

  private compare(f: number): void {
    const mine = this.myHashes.get(f);
    const theirs = this.theirHashes.get(f);
    if (mine === undefined || theirs === undefined) return;
    this.myHashes.delete(f);
    this.theirHashes.delete(f);
    if (mine === theirs) {
      this.hashesMatched++;
      return;
    }
    if (this.desyncAt < 0) {
      this.desyncAt = f;
      this.onDesync?.(f, mine, theirs);
    }
  }

  private prune(): void {
    // Keep every state that a late input could still send us back to, and the one the next hash needs.
    const keep = Math.min(this.confirmed + 1, this.nextHash + 1);
    for (const f of this.snaps.keys()) if (f < keep) this.snaps.delete(f);
  }

  /** The other side's packet. */
  receive(p: InputPacket): void {
    for (let k = 0; k < p.i.length; k++) {
      const f = p.f + k;
      if (f < this.remote.length) continue;
      this.early.set(f, p.i[k] | 0);
    }
    while (this.early.has(this.remote.length)) {
      const f = this.remote.length;
      const value = this.early.get(f)!;
      this.early.delete(f);
      this.remote.push(value);
      const guess = this.guessed.get(f);
      if (guess !== undefined) {
        this.guessed.delete(f);
        if (guess !== value && (this.wrongFrom < 0 || f < this.wrongFrom)) this.wrongFrom = f;
      }
    }
    this.acked = Math.max(this.acked, p.a);
    this.remoteFrame = Math.max(this.remoteFrame, p.n);
    this.remoteAdvantage = p.v;
  }

  receiveHash(r: HashReport): void {
    this.theirHashes.set(r.f, r.h);
    this.compare(r.f);
  }

  /** The packet to send now: every local input the other side hasn't acknowledged. */
  packet(): InputPacket {
    // Never skip ahead of what they have: a gap would wait forever. The stall keeps this short (about 20 frames).
    const from = Math.max(0, this.acked + 1);
    return { f: from, i: this.local.slice(from, from + MAX_PACKET_INPUTS), a: this.remote.length - 1, n: this.frame, v: this.advantage };
  }

  /** Hash reports waiting to be sent (taken). */
  takeHashes(): HashReport[] {
    return this.outHashes.splice(0);
  }

  /** Whether the other side has every local input up to frame f. */
  ackedThrough(f: number): boolean {
    return this.acked >= f;
  }
}

// ------------------------------------------------------------------ the packet as bytes (an express frame's payload)
// [1][f: uv][n: uv][a + 1: uv][v: zigzag][runs: uv][per run: count uv, input uv]. Inputs repeat a lot (a held stick,
// a standing fighter), so they go as runs: a packet is a few dozen bytes where its JSON was a few hundred.
const PACKET_V = 1;

function putUv(out: number[], v: number): void {
  v = Math.max(0, Math.floor(v));
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function encodePacket(p: InputPacket): Uint8Array {
  const out: number[] = [PACKET_V];
  putUv(out, p.f);
  putUv(out, p.n);
  putUv(out, p.a + 1);
  putUv(out, p.v >= 0 ? p.v * 2 : -p.v * 2 - 1);
  const runs: [number, number][] = [];
  for (const x of p.i) {
    const v = x >>> 0;
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  putUv(out, runs.length);
  for (const [count, v] of runs) {
    putUv(out, count);
    putUv(out, v);
  }
  return Uint8Array.from(out);
}

/** The packet from its bytes, or null for a malformed one (never throws: it's the network's). */
export function decodePacket(b: Uint8Array): InputPacket | null {
  let i = 0;
  const uv = (): number => {
    let v = 0;
    let m = 1;
    for (let k = 0; k < 8; k++) {
      if (i >= b.length) throw new RangeError('short');
      const c = b[i++];
      v += (c & 127) * m;
      if (c < 128) return v;
      m *= 128;
    }
    throw new RangeError('long');
  };
  try {
    if (b[i++] !== PACKET_V) return null;
    const f = uv();
    const n = uv();
    const a = uv() - 1;
    const z = uv();
    const v = z % 2 ? -(z + 1) / 2 : z / 2;
    const runs = uv();
    if (runs > MAX_PACKET_INPUTS) return null;
    const inputs: number[] = [];
    for (let r = 0; r < runs; r++) {
      const count = uv();
      const x = uv() | 0;
      if (inputs.length + count > MAX_PACKET_INPUTS) return null;
      for (let k = 0; k < count; k++) inputs.push(x);
    }
    return { f, i: inputs, a, n, v };
  } catch {
    return null;
  }
}
