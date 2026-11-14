// Sim tests for full-match replay recording, playback controls, online rollback recording,
// and bounded profile storage (`dod.profile.replay`). Run with `npm test`.

import { Bot } from '../ai/bot.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { rngNext } from '../sim/fixed.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { hashState } from '../sim/state.ts';
import { Match, type MatchSetup, type MatchSnapshot } from '../match.ts';
import { Rollback } from '../net/rollback.ts';
import {
  MAX_REPLAY_BYTES,
  REPLAY_KEY,
  ReplayPlayer,
  boundReplay,
  loadReplay,
  saveReplay,
} from '../replay.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(ok: boolean, msg: string): void {
  if (!ok) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('ok  :', msg);
  }
}

// Minimal localStorage shim for Node test runs
const store = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    removeItem(k: string) {
      store.delete(k);
    },
    setItem(k: string, v: string) {
      store.set(k, String(v));
    },
  };
}

// 1. Local / CPU match with commercial break freeze frames replays to the identical final state hash
{
  const setup: MatchSetup = {
    mode: 'versus',
    stage: 0,
    stocks: 1,
    rules: { time: 45, hazards: 1, items: 1 },
    events: [{ id: 'spot-1', kind: 'break', when: { time: 2 } }],
    slots: [
      { char: 0, cpu: null },
      { char: 1 % CHARACTERS.length, cpu: 9 },
    ],
  };
  const seed = 424242;
  const m = new Match(setup, seed);
  const p0Bot = new Bot(0, 9, seed + 1337);
  let steps = 0;
  while (!(m.state.over && m.state.endTimer === 0) && steps < 60 * 60) {
    m.tick(p0Bot.think(m.state));
    steps++;
  }
  const finalHash = hashState(m.state);
  const finalWinner = m.state.winner;
  const finalStocks = m.state.fighters.map((f) => f.stocks);
  const finalPercents = m.state.fighters.map((f) => f.percent);

  const replay = m.replay;
  check(replay !== null, 'local/CPU match builds a full replay');
  if (replay) {
    check(replay.ticks === steps, `recorded ticks (${replay.ticks}) match sim steps (${steps}) across freeze frames`);
    check(replay.result.hash === finalHash, 'replay metadata records the exact final state hash');

    const player = new ReplayPlayer(replay);
    const replayedState = player.runToEnd();
    const replayedHash = hashState(replayedState);
    check(replayedHash === finalHash, `replayed match reaches identical final hash (${replayedHash} === ${finalHash})`);
    check(replayedState.winner === finalWinner, `replayed match has same winner (${replayedState.winner} === ${finalWinner})`);
    check(
      replayedState.fighters.every((f, i) => f.stocks === finalStocks[i]),
      `replayed match ends with same stocks (${replayedState.fighters.map((f) => f.stocks).join(',')} === ${finalStocks.join(',')})`,
    );
    check(
      replayedState.fighters.every((f, i) => f.percent === finalPercents[i]),
      'replayed match ends with same fighter percents',
    );

    // Verify pause, 0.5x and 2x playback controls reach the exact same state hash
    player.restart();
    player.togglePause();
    const pausedStep = player.advance(100);
    check(player.paused && pausedStep.ticks === 0 && player.tick === 0, 'paused replay advances 0 ticks');

    player.togglePause();
    player.setSpeed(0.5);
    const halfStep = player.advance(1000 / 30); // 33.33 ms at 0.5x = 16.67 ms = 1 tick
    check(halfStep.ticks === 1, `0.5x speed advances 1 tick over 2 frames of wall time (got ${halfStep.ticks})`);

    player.setSpeed(2);
    const doubleStep = player.advance(1000 / 30); // 33.33 ms at 2x = 66.67 ms = 4 ticks
    check(doubleStep.ticks === 4, `2x speed advances 4 ticks over 2 frames of wall time (got ${doubleStep.ticks})`);

    const cam1 = player.toggleCamera();
    const cam2 = player.toggleCamera();
    check(cam1 === 'free' && cam2 === 'follow', 'camera mode toggles between follow and free');

    const afterControls = player.runToEnd();
    check(
      hashState(afterControls) === finalHash,
      'replay after pause / 0.5x / 2x / camera toggle still finishes at the identical final hash',
    );
  }
}

// 2. Online match with rollbacks records confirmed inputs and replays to the identical final hash
{
  const onlineSetup: MatchSetup = {
    mode: 'online',
    stage: 0,
    stocks: 1,
    rules: {},
    slots: [
      { char: 0, cpu: null },
      { char: 1 % CHARACTERS.length, cpu: null, remote: true },
    ],
    online: {
      matchId: 'test-match',
      names: ['Alice', 'Bob'],
      avatars: [CHARACTERS[0].id, CHARACTERS[1 % CHARACTERS.length].id],
      ids: ['p0', 'p1'],
    },
  };
  const seed = 9001;
  const m = new Match(onlineSetup, seed);
  const sim = {
    save: (): MatchSnapshot => m.snapshot(),
    load: (s: MatchSnapshot) => m.restore(s),
    step: (inputs: number[]) => {
      if (m.state.over && m.state.endTimer === 0) return;
      m.tickInputs(inputs);
    },
    hash: (s: MatchSnapshot) => hashState(s.state),
  };

  const rb = new Rollback(sim, {
    slot: 0,
    delay: 2,
    noInput: NO_INPUT,
  });

  const buttons = [BTN.ATTACK, BTN.SPECIAL, BTN.JUMP, BTN.SHIELD, 0];
  let rng = 77;
  const nextInput = () => {
    let v: number;
    [rng, v] = rngNext(rng);
    return packInput(((v >> 3) % 201) - 100, ((v >> 11) % 201) - 100, buttons[(v >> 19) % buttons.length]);
  };

  const p1Inputs: number[] = [NO_INPUT, NO_INPUT];
  const totalFrames = 240;
  for (let f = 0; f < totalFrames; f++) {
    p1Inputs[f + 2] = nextInput();
    // Deliver remote inputs 3 frames late so Rollback predicts and rolls back repeatedly
    if (f >= 3) {
      const targetFrame = f - 1;
      const start = Math.max(0, targetFrame - 2);
      rb.receive({
        f: start,
        i: p1Inputs.slice(start, targetFrame + 1),
        a: targetFrame,
        n: f,
        v: 0,
      });
    }
    rb.tick(nextInput());
  }
  // Flush final delayed remote packets and run one tick so all frames are resolved and confirmed
  const finalStart = Math.max(0, totalFrames - 4);
  rb.receive({
    f: finalStart,
    i: p1Inputs.slice(finalStart, totalFrames + 2),
    a: totalFrames,
    n: totalFrames,
    v: 0,
  });
  rb.tick(NO_INPUT);

  check(rb.rollbacks > 0, `online test triggered rollbacks (${rb.rollbacks})`);
  const onlineHash = hashState(m.state);
  const onlineReplay = m.buildReplay();
  check(onlineReplay !== null, 'online match with rollbacks builds a replay');
  if (onlineReplay) {
    const replayedOnline = new ReplayPlayer(onlineReplay).runToEnd();
    check(
      hashState(replayedOnline) === onlineHash,
      `online rollback replay matches final state hash (${hashState(replayedOnline)} === ${onlineHash})`,
    );
  }
}

// 3. Profile storage (`dod.profile.replay`) round-trip and bounded byte size enforcement
{
  const setup: MatchSetup = {
    mode: 'versus',
    stage: 0,
    stocks: 1,
    rules: {},
    slots: [
      { char: 0, cpu: null },
      { char: 1 % CHARACTERS.length, cpu: null },
    ],
  };
  const m = new Match(setup, 777);
  let r = 12345;
  for (let i = 0; i < 600; i++) {
    let v0: number;
    let v1: number;
    [r, v0] = rngNext(r);
    [r, v1] = rngNext(r);
    m.tickInputs([v0 & 0x1fffff, v1 & 0x1fffff]);
  }
  const full = m.buildReplay()!;
  const saved = saveReplay(full);
  const raw = localStorage.getItem(REPLAY_KEY);
  check(raw !== null && raw.length <= MAX_REPLAY_BYTES, `saved profile replay fits within MAX_REPLAY_BYTES (${raw?.length ?? 0} <= ${MAX_REPLAY_BYTES})`);

  const loaded = loadReplay();
  check(loaded !== null && loaded.result.hash === saved.result.hash, 'loadReplay reads back saved replay from dod.profile.replay');
  if (loaded) {
    const endState = new ReplayPlayer(loaded).runToEnd();
    check(hashState(endState) === loaded.result.hash, 'loaded replay from profile storage replays to its exact hash');
  }

  // Force a tight byte cap (2 KB) on a high-entropy replay and verify boundReplay trims cleanly and updates result.hash
  const tightCap = 2048;
  const { replay: trimmed, json: trimmedJson } = boundReplay(full, tightCap);
  check(trimmedJson.length <= tightCap, `boundReplay enforces tight byte cap (${trimmedJson.length} <= ${tightCap})`);
  check(trimmed.ticks > 0 && trimmed.ticks < full.ticks, `boundReplay trimmed ticks (${trimmed.ticks} < ${full.ticks})`);
  const trimmedEnd = new ReplayPlayer(trimmed).runToEnd();
  check(
    hashState(trimmedEnd) === trimmed.result.hash,
    'trimmed bounded replay still replays to its exact recorded hash',
  );
}

if (failed > 0) process.exit(1);
