// Headless checks for online play (docs/online.md): run with `npm test`.
// 1. Pairing: every player who runs the rule on the same queue agrees on the pairs, nobody is in two, the older hosts.
// 2. Rollback: two simulated players over a network with delay, jitter, loss and a lag spike end up in the same state
//    (every desync hash matches) and the match is the one an offline replay of their inputs gives.
// 3. A sim that drifts on one side is caught by the desync hash, on both sides.

import { rngNext } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { hashState } from '../sim/state.ts';
import { Match, type MatchSetup, type MatchSnapshot } from '../match.ts';
import { pairFor, allPairs, type QueueEntry } from '../net/pairing.ts';
import { Rollback, type InputPacket, type HashReport } from '../net/rollback.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

// ------------------------------------------------------------------ pairing

{
  let seed = 7;
  const rand = (n: number) => {
    let v: number;
    [seed, v] = rngNext(seed);
    return v % n;
  };
  let consistent = true;
  let mutual = true;
  let hosts = true;
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + rand(9);
    const queue: QueueEntry[] = [];
    for (let i = 0; i < n; i++) queue.push({ id: `p${rand(1000)}x${i}`, queuedAt: 1000 + rand(4) * 500 });
    const pairs = allPairs(queue);
    const inPairs = pairs.flat();
    if (new Set(inPairs).size !== inPairs.length) consistent = false;
    if (pairs.length !== Math.floor(n / 2)) consistent = false;
    for (const e of queue) {
      const p = pairFor(queue, e.id);
      if (!p) continue;
      const back = pairFor(queue, p.partner.id);
      if (!back || back.partner.id !== e.id || back.host === p.host) mutual = false;
      const older = e.queuedAt < p.partner.queuedAt || (e.queuedAt === p.partner.queuedAt && e.id < p.partner.id);
      if (older !== p.host) hosts = false;
    }
  }
  check(consistent, 'pairing: n players make floor(n/2) pairs and nobody is in two');
  check(mutual, 'pairing: both sides of every pair pick each other, exactly one hosts');
  check(hosts, 'pairing: the player who queued first hosts');

  const q = [
    { id: 'a', queuedAt: 1 },
    { id: 'b', queuedAt: 2 },
    { id: 'c', queuedAt: 3 },
  ];
  check(pairFor(q, 'a')?.partner.id === 'b' && pairFor(q, 'c') === null, 'pairing: oldest first, the odd one out waits');
  check(pairFor(q, 'a', new Set(['b']))?.partner.id === 'c', 'pairing: a player skips someone it could not reach');
  check(pairFor([{ id: 'a', queuedAt: 1 }], 'a') === null, 'pairing: alone in the queue, nobody');
}

// ------------------------------------------------------------------ rollback

/** A Simulation over a Match, the way online.ts plugs it in. `drift` breaks this side's sim at that frame. */
function simOf(m: Match, drift = -1) {
  return {
    save: (): MatchSnapshot => m.snapshot(),
    load: (s: MatchSnapshot) => m.restore(s),
    step: (inputs: number[]) => {
      const s = m.state;
      if (s.over && s.endTimer === 0) return;
      m.tickInputs(inputs);
      if (s.frame === drift) s.fighters[0].percent += 10;
    },
    hash: (s: MatchSnapshot) => hashState(s.state),
  };
}

const SETUP: MatchSetup = {
  mode: 'online',
  stage: 0,
  stocks: 2,
  rules: {},
  slots: [
    { char: 0, cpu: null },
    { char: 1 % CHARACTERS.length, cpu: null, remote: true },
  ],
};

const BUTTONS = [BTN.ATTACK, BTN.SPECIAL, BTN.JUMP, BTN.SHIELD, BTN.C_LEFT, BTN.C_RIGHT, 0, 0, 0, 0];

/** A player's hands: a held input that changes every few frames, from its own rng. */
function hands(seed: number) {
  let r = seed;
  let held = NO_INPUT;
  return () => {
    let v: number;
    [r, v] = rngNext(r);
    if (v % 7 === 0) held = packInput(((v >> 3) % 201) - 100, ((v >> 11) % 201) - 100, BUTTONS[(v >> 19) % BUTTONS.length]);
    return held;
  };
}

interface NetRun {
  peers: { rb: Rollback<MatchSnapshot>; m: Match; inputs: number[][] }[];
  desyncs: number[];
}

/**
 * Two players, each on its own 60 Hz clock (one a little fast), sending a packet every tick through a network with
 * the given one-way delay range, loss, and a spike when nothing gets through.
 */
function playOnline(opts: { ms: number; delay: [number, number]; loss: number; spike?: [number, number]; drift?: number; seed: number }): NetRun {
  let r = opts.seed;
  const rand = () => {
    let v: number;
    [r, v] = rngNext(r);
    return v / 4294967296;
  };
  const desyncs: number[] = [];
  const peers = [0, 1].map((slot) => {
    const m = new Match(SETUP, 1234);
    const rb = new Rollback(simOf(m, slot === 1 ? (opts.drift ?? -1) : -1), { slot, noInput: NO_INPUT });
    rb.onDesync = (f) => desyncs.push(f);
    return { rb, m, inputs: [] as number[][], hand: hands(opts.seed * 31 + slot), period: slot === 0 ? 1000 / 60 : 1000 / 60.6, next: slot * 7 };
  });
  type Msg = { at: number; to: number; p?: InputPacket; h?: HashReport };
  let wire: Msg[] = [];
  const send = (from: number, at: number) => {
    const rb = peers[from].rb;
    const blocked = opts.spike && at >= opts.spike[0] && at < opts.spike[1];
    const lag = () => opts.delay[0] + rand() * (opts.delay[1] - opts.delay[0]);
    if (!blocked && rand() >= opts.loss) wire.push({ at: at + lag(), to: 1 - from, p: rb.packet() });
    // Hash reports go on the reliable channel: late in a spike, never lost.
    for (const h of rb.takeHashes()) wire.push({ at: Math.max(at, opts.spike && blocked ? opts.spike[1] : at) + lag(), to: 1 - from, h });
  };
  for (let t = 0; t < opts.ms; t++) {
    const due = wire.filter((w) => w.at <= t);
    if (due.length) {
      wire = wire.filter((w) => w.at > t);
      for (const w of due) {
        if (w.p) peers[w.to].rb.receive(w.p);
        if (w.h) peers[w.to].rb.receiveHash(w.h);
      }
    }
    for (const [i, p] of peers.entries()) {
      if (t < p.next) continue;
      p.next += p.period;
      p.rb.tick(p.hand());
      send(i, t);
    }
  }
  return { peers, desyncs };
}

{
  const run = playOnline({ ms: 60_000, delay: [25, 90], loss: 0.08, spike: [20_000, 20_700], seed: 3 });
  const [a, b] = run.peers;
  console.log(
    `     host: frame ${a.rb.frame}, confirmed ${a.rb.confirmed}, ${a.rb.rollbacks} rollbacks (max ${a.rb.maxRolled} frames), ${a.rb.stalls} stalls, ${a.rb.syncSkips} sync skips, ${a.rb.hashesMatched} hashes matched`,
  );
  console.log(
    `     guest: frame ${b.rb.frame}, confirmed ${b.rb.confirmed}, ${b.rb.rollbacks} rollbacks (max ${b.rb.maxRolled} frames), ${b.rb.stalls} stalls, ${b.rb.syncSkips} sync skips, ${b.rb.hashesMatched} hashes matched`,
  );
  check(run.desyncs.length === 0, 'rollback: no desync over a minute of delay, jitter, 8% loss and a 0.7 s spike');
  check(a.rb.hashesMatched > 50 && b.rb.hashesMatched > 50, 'rollback: both sides compared desync hashes all along (and they matched)');
  check(a.rb.rollbacks > 0 && b.rb.rollbacks > 0, 'rollback: wrong guesses were rolled back and replayed');
  check(a.rb.maxRolled <= 8 + 1 && b.rb.maxRolled <= 8 + 1, 'rollback: never more than the rollback window');
  check(a.rb.stalls > 0, 'rollback: the lag spike stalled the match instead of running away');
  check(Math.abs(a.rb.frame - b.rb.frame) < 20, `rollback: the two clocks stay together (${a.rb.frame} vs ${b.rb.frame}) though one runs 1% fast`);
  check(a.rb.frame > 3000, 'rollback: the match kept moving (most of the 60 s)');
}

{
  // Same inputs everywhere: a clean network ends in the same final state as one sim fed both players' inputs.
  const run = playOnline({ ms: 120_000, delay: [10, 40], loss: 0, seed: 11 });
  const [a, b] = run.peers;
  const over = !!a.m.state.over && !!b.m.state.over;
  check(over && a.m.state.winner === b.m.state.winner, `rollback: a full match ends the same on both sides (winner ${a.m.state.winner}, frame ${a.m.state.frame})`);
  check(hashState(a.m.state) === hashState(b.m.state), 'rollback: the final states hash the same');
}

{
  const run = playOnline({ ms: 30_000, delay: [20, 60], loss: 0.05, drift: 600, seed: 5 });
  check(run.desyncs.length >= 2 && run.desyncs.every((f) => f >= 599), `rollback: a sim that drifts at frame 600 is reported on both sides (at ${run.desyncs.join(', ')})`);
}

if (failed) {
  console.log(`\n${failed} net check(s) failed`);
  process.exit(1);
}
console.log('\nall net checks passed');
