// Headless checks for the simulation: run with `npm test`.
// 1. The same inputs always produce the same state hash, on every stage.
// 2. Restoring a snapshot and replaying (what rollback does) lands on the same hash.
// 3. Bots finish matches on every stage, including teams, giants and odd rules.

import { rngNext } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { BTN, packInput } from '../sim/input.ts';
import { STAGES } from '../sim/stage.ts';
import { cloneState, hashState, newGame, type FighterSetup, type GameOptions, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { Match, type SlotSetup } from '../match.ts';
import { CHAPTERS, SEASONS, isOpen, seasonOpen } from '../campaign/story.ts';

declare const process: { exit(code: number): never };

const BUTTONS = [BTN.ATTACK, BTN.SPECIAL, BTN.JUMP, BTN.SHIELD, BTN.C_LEFT, BTN.C_UP, 0, 0, 0];

function randomInputs(seed: number, frames: number, players: number): number[][] {
  let r = seed;
  const out: number[][] = [];
  const held = new Array(players).fill(0).map(() => [0, 0, 0]);
  for (let i = 0; i < frames; i++) {
    const row: number[] = [];
    for (let p = 0; p < players; p++) {
      let v: number;
      [r, v] = rngNext(r);
      // Change the held input every ~8 frames so moves actually play out.
      if (v % 8 === 0) held[p] = [(v >> 3) % 201 - 100, (v >> 11) % 201 - 100, BUTTONS[(v >> 19) % BUTTONS.length]];
      row.push(packInput(held[p][0], held[p][1], held[p][2]));
    }
    out.push(row);
  }
  return out;
}

function run(state: GameState, inputs: number[][], from = 0): number {
  for (let i = from; i < inputs.length; i++) step(state, inputs[i]);
  return hashState(state);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const four: FighterSetup[] = [{ char: 0 }, { char: 2 }, { char: 8 }, { char: 12 }];

// A stage that uses every dynamic system (events, zones, hazards, platform
// toggles), so they are held to the same determinism and rollback checks.
{
  const base = STAGES[0];
  const top = Math.max(...base.platforms.map((p) => p.y));
  STAGES.push({
    ...base,
    id: 'test-dynamic',
    name: 'Test Dynamic',
    platforms: base.platforms.map((p, i) => (i === base.platforms.length - 1 ? { ...p, offDuring: 'storm' } : p)),
    events: [
      { id: 'storm', every: [2, 4], first: 1, warn: 1, duration: 3 },
      { id: 'cheer', trigger: 'ko', duration: 0 },
      { id: 'tilt', trigger: 'hit', chance: 20, duration: 1 },
    ],
    zones: [
      { kind: 'wind', x1: -2000, x2: 2000, y1: -500, y2: 2000, during: 'storm', force: [90, 0] },
      // Off to the side: under the whole stage, bots float below the floor and never come back.
      { kind: 'water', x1: 900, x2: 2000, y1: -900, y2: -150 },
      { kind: 'damage', x1: -3000, x2: 3000, y1: -900, y2: 3000, damage: 1, tick: 4, knock: 30, angle: 60 },
      { kind: 'gravity', x1: -300, x2: 300, y1: top, y2: top + 600, gravity: 60, during: 'tilt' },
    ],
    hazards: [
      { id: 'hawk', during: 'storm', path: [{ x: -1200, y: 300 }, { x: 0, y: 40 }, { x: 1200, y: 300 }], r: 60, dmg: 12, angle: 45, bkb: 40, kbg: 90 },
      { id: 'saw', period: 3, path: [{ x: -400, y: 60 }, { x: 400, y: 60 }], r: 30, dmg: 4, angle: 80, bkb: 20, kbg: 40 },
    ],
  });
}

STAGES.forEach((stage, si) => {
  const opts: GameOptions = { stocks: 3, seed: 11 + si, stage: si };
  const inputs = randomInputs(opts.seed, 3000, 4);
  const a = run(newGame(four, opts), inputs);
  const b = run(newGame(four, opts), inputs);

  // Simulate a rollback: snapshot at frame 1000, run on with wrong guesses
  // for 8 frames, restore, then replay the real inputs.
  const live = newGame(four, opts);
  run(live, inputs.slice(0, 1000));
  const snap = cloneState(live);
  for (let i = 0; i < 8; i++) step(live, [0, 0, 0, 0].map(() => packInput(0, 0, BTN.JUMP)));
  const restored = cloneState(snap);
  for (let i = 1000; i < inputs.length; i++) step(restored, inputs[i]);
  check(`${stage.name}: deterministic and rollback-safe`, a === b && hashState(restored) === a, a.toString(16));
});

function botMatch(setup: FighterSetup[], opts: GameOptions, level = 6): { state: GameState; secs: number; hits: number } {
  const state = newGame(setup, opts);
  const bots = setup.map((_, i) => new Bot(i, level, 1000 + i));
  let frames = 0;
  let hits = 0;
  while (!state.over && frames < 60 * 60 * 8) {
    hits += step(state, bots.map((b) => b.think(state))).filter((e) => e.type === 'hit').length;
    frames++;
  }
  return { state, secs: Math.round(frames / 60), hits };
}

STAGES.forEach((stage, si) => {
  const { state, secs, hits } = botMatch(four, { stocks: 2, seed: 99, stage: si });
  check(`${stage.name}: four bots finish`, state.over === 1, `${secs}s, ${hits} hits, winner P${state.winner + 1}`);
});

{
  // Two-on-one: allies never damage each other, and a team wins together.
  const { state } = botMatch([{ char: 9, team: 0 }, { char: 1, team: 1 }, { char: 20, team: 1 }], { stocks: 2, seed: 5, stage: 0 });
  const p = state.fighters;
  check('teams finish with a winning team', state.over === 1 && state.winnerTeam >= 0, `team ${state.winnerTeam}`);
  check('teammates never land hits on each other', p[1].damageDealt + p[2].damageDealt <= p[0].percent + 9999 * p[0].falls);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 22, scale: 150 }], { stocks: 2, seed: 8, stage: 1 });
  check('a giant fighter finishes a match', state.over === 1);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 13 }], { stocks: 3, seed: 3, stage: 2, rules: { gravity: 55, damage: 140 } });
  check('low gravity and high damage finish', state.over === 1);
}

{
  const { state } = botMatch([{ char: 9 }, { char: 26 }], { stocks: 5, seed: 4, stage: 4, rules: { timeLimit: 60 * 20 } });
  check('a time limit ends the match', state.over === 1 && state.frame <= 60 * 20 + 1, `timedOut=${state.timedOut}`);
}

{
  // Every fighter can play a match without the sim falling over.
  let ok = true;
  for (let c = 0; c < CHARACTERS.length; c += 2) {
    const { state } = botMatch([{ char: c }, { char: (c + 1) % CHARACTERS.length }], { stocks: 1, seed: c, stage: c % STAGES.length });
    if (!state.over) ok = false;
  }
  check(`all ${CHARACTERS.length} fighters play`, ok);
}

{
  // The dynamic stage really does its things.
  const si = STAGES.findIndex((st) => st.id === 'test-dynamic');
  const setup: FighterSetup[] = [{ char: 0 }, { char: 2 }];
  const state = newGame(setup, { stocks: 2, seed: 21, stage: si });
  const bots = setup.map((_, i) => new Bot(i, 6, 40 + i));
  const seen = new Set<string>();
  for (let i = 0; i < 60 * 60 && !state.over; i++) {
    for (const e of step(state, bots.map((b) => b.think(state)))) {
      if (e.type === 'stage') seen.add(`${STAGES[si].events![e.event].id}:${e.phase}`);
      if (e.type === 'hurt') seen.add(e.source);
    }
  }
  const want = ['storm:warn', 'storm:start', 'storm:end', 'zone', 'hazard'];
  check('stage events, zones and hazards fire', want.every((w) => seen.has(w)), [...seen].sort().join(' '));
  const quiet = newGame(setup, { stocks: 2, seed: 21, stage: si, rules: { hazards: 0 } });
  let fired = 0;
  for (let i = 0; i < 60 * 30; i++) fired += step(quiet, [0, 0]).filter((e) => e.type === 'stage' || e.type === 'hurt').length;
  check('hazards off keeps the stage quiet', fired === 0);
}

{
  // The campaign map's seasons: in order, every chapter in one, and a season opens once the one before is cleared.
  check('chapters run in season order', CHAPTERS.every((c, i) => i === 0 || CHAPTERS[i - 1].season <= c.season));
  check('every chapter is in a season', SEASONS.reduce((n, s) => n + s.chapters.length, 0) === CHAPTERS.length, SEASONS.map((s) => `S${s.number}: ${s.chapters.length}`).join(', '));
  check('season 1 opens with nothing cleared', seasonOpen(1, new Set()) && isOpen(0, new Set()));
  for (const s of SEASONS.slice(1)) {
    const before = CHAPTERS.filter((c) => c.season < s.number).map((c) => c.id);
    const first = CHAPTERS.indexOf(s.chapters[0]);
    const allButOne = new Set(before.slice(0, -1));
    const all = new Set(before);
    check(`season ${s.number} waits on the season before`, !seasonOpen(s.number, allButOne) && !isOpen(first, allButOne) && seasonOpen(s.number, all) && isOpen(first, all));
  }
  // Season 2 (docs/story.md): four walk-ons Season 1 never used, one Ratings fight, one on Rainbow Full Pipe, every line recorded.
  const s2 = CHAPTERS.filter((c) => c.season === 2);
  const s1Chars = new Set(CHAPTERS.filter((c) => c.season === 1).flatMap((c) => c.fight.slots.map((sl) => sl.char)));
  const foes = s2.flatMap((c) => c.fight.slots.filter((sl) => sl.cpu !== null).map((sl) => sl.char));
  check('season 2 has four episodes', s2.length === 4, s2.map((c) => c.id).join(' '));
  check('season 2 walk-ons are new to the card', foes.length === 4 && new Set(foes).size === 4 && foes.every((f) => !s1Chars.has(f)), foes.map((f) => CHARACTERS[f].id).join(' '));
  check('season 2 has a Ratings fight and a Rainbow Full Pipe night', s2.some((c) => c.fight.objective === 'ko') && s2.some((c) => STAGES[c.fight.stage].id === 'rainbow-full-pipe'));
  const unrecorded = s2.flatMap((c) => [...c.intro, ...c.outro]).filter((l) => !l.audio || l.take?.text !== l.text);
  check('season 2 lines are all recorded', unrecorded.length === 0, unrecorded.map((l) => l.text).join(' / '));
  // Season 3, the Orchestrator's return (docs/story.md): the Orchestrator comes back as a fighter, never scenery, and the champion has top billing.
  const finale = CHAPTERS.filter((c) => c.season === 3);
  const fin = finale[0]?.fight;
  const orch = fin?.slots.find((sl) => CHARACTERS[sl.char].id === 'orchestrator');
  const punk = fin?.slots.find((sl) => sl.cpu === null);
  check('season 3 is the one-episode Orchestrator arc', finale.length === 1 && SEASONS.some((s) => s.number === 3 && s.subtitle !== 'The Finale'), finale.map((c) => c.id).join(' '));
  check('season 3: the Orchestrator fights, at normal size, with a stock more', !!orch && orch.cpu !== null && orch.cpu > 0 && (orch.scale ?? 100) === 100 && (orch.stocks ?? 0) > (punk?.stocks ?? 0));
  check('season 3: Exit Punk has top billing (the giant)', !!punk && CHARACTERS[punk.char].id === 'exit-punk' && (punk.scale ?? 100) > 100);
}

{
  // The 'ko' objective: N KOs before the clock wins (the match ends on the last one); the clock running out loses.
  const char = (id: string) => CHARACTERS.findIndex((c) => c.id === id);
  const koMatch = (foe: SlotSetup, timeLimit: number, seed: number) => {
    const m = new Match({ mode: 'campaign', stage: STAGES.findIndex((st) => st.id === 'yo-house'), stocks: 9, rules: { timeLimit }, objective: 'ko', kos: 3, slots: [{ char: char('exit-punk'), cpu: null, team: 0 }, { team: 1, stocks: 9, ...foe }] }, seed);
    const me = new Bot(0, 9, seed + 1);
    for (let i = 0; i < 60 * 60 * 5 && !m.state.over; i++) m.tick(me.think(m.state));
    return m;
  };
  // Kaelen starts every life at 120%, so three KOs come well inside the 2 minutes.
  const win = koMatch({ char: char('kaelen'), cpu: 1, startPercent: 1200 }, 60 * 120, 11);
  const foeLeft = win.state.fighters[1].stocks;
  check('ko objective: 3 KOs before the clock wins', win.state.over === 1 && !win.state.timedOut && win.playerWon() && win.koCount() === 3, `${Math.round(win.state.frame / 60)}s, ${win.koCount()} KOs`);
  check('ko objective: the match ends on the third KO, foe still in', foeLeft > 0 && win.state.winner === 0 && win.state.frame < 60 * 120, `foe has ${foeLeft} stocks`);
  const late = koMatch({ char: char('break'), cpu: 9, scale: 135 }, 60 * 15, 12);
  check('ko objective: time running out first loses', late.state.over === 1 && late.state.timedOut === 1 && !late.playerWon() && late.koCount() < 3, `${late.koCount()} KOs in 15s`);
  // Two KOs scored when the clock runs out is still a loss.
  const short = new Match({ mode: 'campaign', stage: 0, stocks: 9, rules: { timeLimit: 60 }, objective: 'ko', kos: 3, slots: [{ char: char('exit-punk'), cpu: null }, { char: char('kaelen'), cpu: 0, stocks: 9 }] }, 3);
  short.stats[0].kos = 2;
  while (!short.state.over) short.tick(0);
  check('ko objective: 2 of 3 KOs at the bell is a loss', short.state.timedOut === 1 && !short.playerWon());
}

{
  // The 'quota' objective: deal N% damage before the clock wins (the match ends the moment it is met); the clock or the stocks running out loses.
  const char = (id: string) => CHARACTERS.findIndex((c) => c.id === id);
  const quotaSetup = (foe: SlotSetup, timeLimit: number, quota: number) => ({
    mode: 'campaign' as const, stage: STAGES.findIndex((st) => st.id === 'yo-house'), stocks: 9, rules: { timeLimit, damage: 130 }, objective: 'quota' as const, quota,
    slots: [{ char: char('exit-punk'), cpu: null, team: 0 }, { team: 1, stocks: 9, ...foe }] as SlotSetup[],
  });
  const play = (m: Match, seed: number, frames = 60 * 60 * 5) => {
    const me = new Bot(0, 9, seed + 1);
    const inputs: number[] = [];
    for (let i = 0; i < frames && !m.state.over; i++) {
      const v = me.think(m.state);
      inputs.push(v);
      m.tick(v);
    }
    return inputs;
  };
  const foe: SlotSetup = { char: char('kaelen'), cpu: 1, startPercent: 1200 };

  const win = new Match(quotaSetup(foe, 60 * 120, 150), 21);
  play(win, 21);
  check('quota objective: dealing 150% before the clock wins', win.state.over === 1 && !win.state.timedOut && win.playerWon() && win.quotaDealt() >= win.quotaTarget, `${Math.round(win.state.frame / 60)}s, ${win.quotaDealt() / 10}%`);
  check('quota objective: it ends the moment the number is met, foe still in', win.state.winner === 0 && win.state.fighters[1].stocks > 0 && win.state.frame < 60 * 120);
  check('quota objective: the dealt count is the player\'s own damage', win.quotaDealt() === win.stats[0].dealt && win.quotaDealt() < win.quotaTarget + 400);

  const late = new Match(quotaSetup({ char: char('break'), cpu: 9, scale: 135 }, 60 * 10, 400), 22);
  play(late, 22);
  check('quota objective: the clock running out first loses', late.state.over === 1 && late.state.timedOut === 1 && !late.playerWon() && late.quotaDealt() < late.quotaTarget, `${late.quotaDealt() / 10}% in 10s`);

  // Just short at the bell is still a loss, even when the player has more stocks left.
  const short = new Match(quotaSetup({ char: char('kaelen'), cpu: 0, stocks: 9 }, 60, 300), 3);
  short.stats[0].dealt = 2990;
  while (!short.state.over) short.tick(0);
  check('quota objective: 299 of 300% at the bell is a loss', short.state.timedOut === 1 && !short.playerWon() && short.quotaDealt() < short.quotaTarget);
  const exact = new Match(quotaSetup({ char: char('kaelen'), cpu: 0, stocks: 9 }, 600, 300), 3);
  exact.stats[0].dealt = 3000;
  exact.tick(0);
  check('quota objective: exactly the number ends the match won', exact.state.over === 1 && exact.playerWon() && !exact.state.timedOut);

  // Out of stocks before the quota: the player was eliminated, so it is lost and not a timeout.
  const out = new Match({ ...quotaSetup({ char: char('break'), cpu: 9, scale: 135, startPercent: 0 }, 0, 9999), stocks: 1, slots: [{ char: char('exit-punk'), cpu: null, team: 0, stocks: 1 }, { char: char('break'), cpu: 9, team: 1, stocks: 9, scale: 135 }] }, 5);
  play(out, 5, 60 * 60 * 10);
  check('quota objective: out of stocks first is a loss', out.state.over === 1 && !out.state.timedOut && !out.playerWon(), `${out.quotaDealt() / 10}%`);

  // Determinism: the same seed and inputs give the same match; snapshot + restore + replay (rollback) lands on the same hash, damage and result.
  const a = new Match(quotaSetup(foe, 60 * 120, 150), 21);
  play(a, 21);
  check('quota objective: the same seed and inputs repeat exactly', hashState(a.state) === hashState(win.state) && a.quotaDealt() === win.quotaDealt() && a.state.frame === win.state.frame);
  // Rollback: record both players' inputs from a live run, then replay them through tickInputs, as the netcode does.
  const botInputs: number[] = [];
  {
    const bot0 = new Bot(0, 9, 22);
    const bot1 = new Bot(1, 1, 21 + 7919);
    const rec = new Match(quotaSetup({ ...foe, cpu: null }, 60 * 120, 150), 21);
    for (let i = 0; i < 60 * 60 * 5 && !rec.state.over; i++) {
      const x = bot0.think(rec.state);
      const y = bot1.think(rec.state);
      botInputs.push(x, y);
      rec.tickInputs([x, y]);
    }
    const run = (m: Match, from: number, to: number) => { for (let i = from; i < to && !m.state.over; i++) m.tickInputs([botInputs[i * 2], botInputs[i * 2 + 1]]); };
    const frames = botInputs.length / 2;
    const half = Math.floor(frames / 2);
    const ref = new Match(quotaSetup({ ...foe, cpu: null }, 60 * 120, 150), 21);
    run(ref, 0, frames);
    const mid = new Match(quotaSetup({ ...foe, cpu: null }, 60 * 120, 150), 21);
    run(mid, 0, half);
    const snapshot = mid.snapshot();
    run(mid, half, frames);
    const hashEnd = hashState(mid.state);
    // Roll back to the snapshot (what a late remote input does) and replay the same inputs.
    mid.restore(snapshot);
    check('quota objective: restoring a snapshot brings the damage count back', mid.quotaDealt() === snapshot.stats[0].dealt && !mid.state.over);
    run(mid, half, frames);
    check('quota objective: rollback and replay land on the same hash, damage and result', hashState(mid.state) === hashEnd && mid.quotaDealt() === ref.quotaDealt() && mid.state.over === ref.state.over && mid.playerWon() === ref.playerWon() && hashEnd === hashState(ref.state) && ref.state.over === 1, `${frames} frames, ${ref.quotaDealt() / 10}%`);
  }

  // The chapter: Season 5's Product Placement, a quota night with a clock.
  const pp = CHAPTERS.find((ch) => ch.id === 'product-placement');
  check('season 5: Product Placement is a quota fight with a clock', pp?.fight.objective === 'quota' && (pp.fight.quota ?? 0) >= 100 && (pp.fight.rules.timeLimit ?? 0) > 0);
  check('season 5: the quota chapter keeps the sponsor\'s damage rule and its unlock', pp?.fight.rules.damage === 130 && pp.unlock === 'yo-bot');
}

{
  // The 'streak' objective: land N hits in a row without being hit back; the match ends on the hit that makes it. The clock or the stocks running out loses.
  const char = (id: string) => CHARACTERS.findIndex((c) => c.id === id);
  const streakSetup = (foe: SlotSetup, timeLimit: number, streak: number) => ({
    mode: 'campaign' as const, stage: STAGES.findIndex((st) => st.id === 'city-top'), stocks: 9, rules: { timeLimit, damage: 120 }, objective: 'streak' as const, streak,
    slots: [{ char: char('exit-punk'), cpu: null, team: 0 }, { team: 1, stocks: 9, ...foe }] as SlotSetup[],
  });
  const play = (m: Match, seed: number, frames = 60 * 60 * 5) => {
    const me = new Bot(0, 9, seed + 1);
    for (let i = 0; i < frames && !m.state.over; i++) m.tick(me.think(m.state));
  };
  const foe: SlotSetup = { char: char('kaelen'), cpu: 1, startPercent: 1200 };

  const win = new Match(streakSetup(foe, 60 * 120, 3), 21);
  play(win, 21);
  check('streak objective: 3 clean hits in a row before the clock wins', win.state.over === 1 && !win.state.timedOut && win.playerWon() && win.streakBest() >= win.streakTarget, `${Math.round(win.state.frame / 60)}s`);
  check('streak objective: it ends on the hit that makes it, foe still in', win.state.winner === 0 && win.state.fighters[1].stocks > 0 && win.state.frame < 60 * 120 && win.streakBest() === 3);

  // Taking a hit starts the count over; a hit on a shield counts for neither side.
  const m = new Match(streakSetup({ char: char('kaelen'), cpu: 0 }, 60 * 60, 5), 3);
  m.stats[0].streak = 2; m.stats[0].bestStreak = 2;
  const ev = (attacker: number, victim: number, shield = 0) => ({ type: 'hit', attacker, victim, dmg: 50, shield }) as never;
  (m as unknown as { record(e: unknown[], b: number[]): void }).record([ev(1, 0)], [0, 0]);
  check('streak objective: being hit starts the streak over, the best stays', m.streakNow() === 0 && m.streakBest() === 2);
  (m as unknown as { record(e: unknown[], b: number[]): void }).record([ev(0, 1), ev(0, 1)], [0, 0]);
  (m as unknown as { record(e: unknown[], b: number[]): void }).record([ev(1, 0, 1)], [0, 0]);
  check('streak objective: hits landed count up, a shielded hit changes nothing', m.streakNow() === 2 && m.streakBest() === 2 && !m.state.over);

  const late = new Match(streakSetup({ char: char('break'), cpu: 9, scale: 135 }, 60 * 10, 40), 22);
  play(late, 22);
  check('streak objective: the clock running out first loses', late.state.over === 1 && late.state.timedOut === 1 && !late.playerWon() && late.streakBest() < late.streakTarget, `best ${late.streakBest()}`);

  const exact = new Match(streakSetup({ char: char('kaelen'), cpu: 0, stocks: 9 }, 600, 5), 3);
  exact.stats[0].bestStreak = 4;
  while (!exact.state.over) exact.tick(0);
  check('streak objective: 4 of 5 at the bell is a loss', exact.state.timedOut === 1 && !exact.playerWon());
  exact.stats[0].bestStreak = 5;
  check('streak objective: 5 of 5 counts as met', exact.playerWon());

  const out = new Match({ ...streakSetup({ char: char('break'), cpu: 9, scale: 135 }, 0, 40), stocks: 1, slots: [{ char: char('exit-punk'), cpu: null, team: 0, stocks: 1 }, { char: char('break'), cpu: 9, team: 1, stocks: 9, scale: 135 }] }, 5);
  play(out, 5, 60 * 60 * 10);
  check('streak objective: out of stocks first is a loss', out.state.over === 1 && !out.state.timedOut && !out.playerWon());

  // Determinism: the same seed and inputs repeat exactly; snapshot + restore + replay (rollback) lands on the same hash, streaks and result.
  const a = new Match(streakSetup(foe, 60 * 120, 3), 21);
  play(a, 21);
  check('streak objective: the same seed and inputs repeat exactly', hashState(a.state) === hashState(win.state) && a.streakBest() === win.streakBest() && a.state.frame === win.state.frame);
  const botInputs: number[] = [];
  const bot0 = new Bot(0, 9, 22);
  const bot1 = new Bot(1, 1, 21 + 7919);
  const mk = () => new Match(streakSetup({ ...foe, cpu: null }, 60 * 120, 3), 21);
  const rec = mk();
  for (let i = 0; i < 60 * 60 * 5 && !rec.state.over; i++) {
    const x = bot0.think(rec.state);
    const y = bot1.think(rec.state);
    botInputs.push(x, y);
    rec.tickInputs([x, y]);
  }
  const frames = botInputs.length / 2;
  const half = Math.floor(frames / 2);
  const run = (mm: Match, from: number, to: number) => { for (let i = from; i < to && !mm.state.over; i++) mm.tickInputs([botInputs[i * 2], botInputs[i * 2 + 1]]); };
  const ref = mk();
  run(ref, 0, frames);
  const mid = mk();
  run(mid, 0, half);
  const snapshot = mid.snapshot();
  run(mid, half, frames);
  const hashEnd = hashState(mid.state);
  mid.restore(snapshot);
  check('streak objective: restoring a snapshot brings the streak back', mid.streakNow() === snapshot.stats[0].streak && mid.streakBest() === snapshot.stats[0].bestStreak && !mid.state.over);
  run(mid, half, frames);
  check('streak objective: rollback and replay land on the same hash, streak and result', hashState(mid.state) === hashEnd && hashEnd === hashState(ref.state) && mid.streakBest() === ref.streakBest() && mid.playerWon() === ref.playerWon() && ref.state.over === 1, `${frames} frames, best ${ref.streakBest()}`);

  // The chapter: Season 7's Series Finale, a clean-streak night with a clock.
  const sf = CHAPTERS.find((ch) => ch.id === 'series-finale');
  check('season 7: Series Finale is a streak fight with a clock', sf?.fight.objective === 'streak' && (sf.fight.streak ?? 0) >= 2 && (sf.fight.rules.timeLimit ?? 0) > 0);
  check('season 7: the streak chapter keeps the damage rule and its unlock', sf?.fight.rules.damage === 120 && sf.unlock === 'future-man');
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
