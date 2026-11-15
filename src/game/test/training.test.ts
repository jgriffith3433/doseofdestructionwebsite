// Training: the combo readout counts only hits landed while the dummy is still in hitstun, shows the combo and last-hit
// damage, the dummy's percent can be set and reset, and each dummy behaviour plays its input.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { ACT } from '../sim/state.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { FX } from '../sim/fixed.ts';
import { Match } from '../match.ts';
import { DUMMY_MODES } from '../ai/trainingDummy.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const stage = STAGES.findIndex((s) => s.id === 'city-top') >= 0 ? STAGES.findIndex((s) => s.id === 'city-top') : 0;
const fresh = (seed = 3) => new Match({ mode: 'training', stage, stocks: 1, rules: {}, slots: [{ char: punk, cpu: null }, { char: (punk + 1) % CHARACTERS.length, cpu: 0 }] }, seed);

function settle(m: Match, n = 90): void {
  for (let i = 0; i < n; i++) m.tick(NO_INPUT);
}
function nextTo(m: Match): void {
  const [a, b] = m.state.fighters;
  a.x = b.x - 60 * FX;
  a.facing = 1;
  b.facing = -1;
}

// Setting and resetting the dummy's percent.
{
  const m = fresh();
  settle(m);
  m.setDummyPercent(100);
  check('percent set to 100', m.state.fighters[1].percent === 1000, String(m.state.fighters[1].percent));
  check('player percent untouched', m.state.fighters[0].percent === 0);
  m.setDummyPercent(0);
  check('percent reset to 0', m.state.fighters[1].percent === 0);
}

// A down tilt string at 0% against Break: the readout counts hits while the dummy is in hitstun, and sums the damage.
{
  const brk = CHARACTERS.findIndex((c) => c.id === 'break');
  const m = new Match({ mode: 'training', stage: 0, stocks: 1, rules: {}, slots: [{ char: punk, cpu: null }, { char: brk, cpu: 0 }] }, 3);
  settle(m, 60);
  nextTo(m);
  const [a, b] = m.state.fighters;
  a.x = b.x - 50 * FX;
  let sum = 0;
  let best = 0;
  let bestDmg = 0;
  for (let f = 0; f < 6 * 19; f++) {
    const ev = m.tick(f % 19 < 3 ? packInput(0, -100, BTN.ATTACK) : NO_INPUT);
    for (const e of ev) if (e.type === 'hit' && !e.shield && e.attacker === 0) sum += e.dmg;
    if (m.readout.count >= best) { best = m.readout.count; bestDmg = m.readout.dmg; }
  }
  check('a down tilt string reaches a 3+ hit true combo', best >= 3, `best ${best}`);
  check('combo damage is the sum of its hits and no more than the total', bestDmg > 0 && bestDmg <= sum, `${bestDmg} of ${sum}`);
  check('last hit damage is one hit, less than the combo', m.readout.lastHit > 0 && m.readout.lastHit < bestDmg);
}

// Hits with a gap are not one combo: a jab, then a wait until the dummy is free, then a jab again starts at 1.
{
  const m = fresh();
  settle(m);
  nextTo(m);
  let counts: number[] = [];
  for (let round = 0; round < 2; round++) {
    for (let f = 0; f < 120; f++) {
      m.tick(f < 2 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT);
      if (f === 100) counts.push(m.readout.count);
    }
    nextTo(m);
  }
  check('a second hit after the dummy was free starts a new combo', counts.length === 2 && counts[1] <= 1, counts.join(','));
}

// A combo ends when the dummy is free again, and its numbers stay up; the next hit starts at 1.
{
  const m = fresh();
  settle(m);
  nextTo(m);
  for (let f = 0; f < 6; f++) m.tick(f < 2 ? packInput(0, 0, BTN.ATTACK) : NO_INPUT);
  for (let f = 0; f < 60 && m.readout.active; f++) m.tick(NO_INPUT);
  check('combo ends after hitstun', m.readout.count > 0 && !m.readout.active, JSON.stringify(m.readout));
  const kept = m.readout.dmg;
  settle(m, 30);
  check('numbers stay after the combo ends', m.readout.dmg === kept && m.readout.count > 0);
  m.clearReadout();
  check('clearReadout empties it', m.readout.count === 0 && m.readout.dmg === 0);
}

// Dummy behaviours.
{
  const states: Record<string, { crouch: boolean; shield: boolean; jumped: boolean; moved: number }> = {};
  for (const { id } of DUMMY_MODES) {
    const m = fresh();
    m.setDummyMode(id);
    m.setDummyLevel(5);
    const s = { crouch: false, shield: false, jumped: false, moved: 0 };
    const x0 = m.state.fighters[1].x;
    for (let f = 0; f < 400; f++) {
      m.tick(NO_INPUT);
      const d = m.state.fighters[1];
      if (d.action === ACT.CROUCH) s.crouch = true;
      if (d.action === ACT.SHIELD) s.shield = true;
      if (!d.grounded) s.jumped = true;
      s.moved = Math.max(s.moved, Math.abs(d.x - x0) / FX);
    }
    states[id] = s;
  }
  check('stand stays put', states.stand.moved < 1 && !states.stand.crouch && !states.stand.shield && !states.stand.jumped);
  check('crouch crouches', states.crouch.crouch);
  check('jump jumps', states.jump.jumped);
  check('shield shields', states.shield.shield);
  check('walk walks', states.walk.moved > 40, String(Math.round(states.walk.moved)));
  const m = fresh();
  m.setDummyMode('cpu');
  m.setDummyLevel(9);
  check('level clamps to 1-9', (m.setDummyLevel(40), m.dummy.level === 9));
  let acted = false;
  for (let f = 0; f < 600 && !acted; f++) {
    m.tick(NO_INPUT);
    const d = m.state.fighters[1];
    if (d.action !== ACT.IDLE) acted = true;
  }
  check('CPU dummy does something', acted);
  check('mode kept on the setup (Restart keeps it)', m.setup.dummy?.mode === 'cpu' && m.setup.dummy.level === 9);
}

process.exit(failed ? 1 : 0);
