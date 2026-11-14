// How to play 2 (ui/teach.ts lesson 'defence', ai/dummy.ts): the moves the lesson ticks off are what the sim reports for the
// real inputs a player gives (Shield + Attack grab, a stick throw, Shield + stick sideways roll, Shield + stick down spot
// dodge), and the swinging dummy walks up and throws a smash no more often than every 2.5 s.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { ACT, newGame } from '../sim/state.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { step, type SimEvent } from '../sim/step.ts';
import { FX } from '../sim/fixed.ts';
import { SwingDummy, SWING_EVERY } from '../ai/dummy.ts';
import { DEFENCE_STEPS, PROMPTS, RECOVERY_STEPS } from '../ui/teach.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const kaelen = CHARACTERS.findIndex((c) => c.id === 'kaelen');
const stage = STAGES.findIndex((s) => s.id === 'city-top');
const fresh = () => newGame([{ char: ep, stocks: 9 }, { char: kaelen, stocks: 9 }], { stocks: 9, seed: 5, stage });

// Every step has a prompt for each device.
for (const st of DEFENCE_STEPS) {
  const p = PROMPTS[st];
  check(`prompt ${st}`, !!p.word && p.glyphs.keyboard.length > 0 && p.glyphs.gamepad.length > 0 && p.glyphs.touch.length > 0);
}

/** Runs frames with the player's inputs and the dummy idle; returns the events seen and the last states. */
function run(s: ReturnType<typeof fresh>, inputs: number[], dummyInput: (i: number) => number = () => NO_INPUT): SimEvent[] {
  const out: SimEvent[] = [];
  inputs.forEach((inp, i) => out.push(...step(s, [inp, dummyInput(i)])));
  return out;
}
let offEdge = false;
const rep = (n: number, v: number) => Array(n).fill(v) as number[];
const SH = BTN.SHIELD;

// Settle, then walk next to the dummy.
function ready(): ReturnType<typeof fresh> {
  const s = fresh();
  run(s, rep(90, NO_INPUT));
  const [a, b] = s.fighters;
  // Stand them 60 units apart facing each other (setup only; the moves below are real inputs).
  a.x = b.x - 60 * FX;
  a.facing = 1;
  b.facing = -1;
  run(s, rep(5, NO_INPUT));
  return s;
}

{
  const s = ready();
  const ev = run(s, [...rep(3, packInput(0, 0, SH | BTN.ATTACK)), ...rep(20, NO_INPUT)]);
  check('Shield + Attack makes a grab event', ev.some((e) => e.type === 'grab' && e.attacker === 0), ev.map((e) => e.type).join(','));
  const ev2 = run(s, [...rep(10, NO_INPUT), ...rep(3, packInput(100, 0, 0)), ...rep(10, NO_INPUT)]);
  check('the stick while holding makes a throw event', ev2.some((e) => e.type === 'throw' && e.attacker === 0), ev2.map((e) => e.type).join(','));
}
for (const dir of [-1, 1]) {
  const s = ready();
  let rolled = 0;
  for (const inp of [...rep(8, packInput(0, 0, SH)), ...rep(4, packInput(dir * 100, 0, SH)), ...rep(10, packInput(0, 0, SH))]) {
    step(s, [inp, NO_INPUT]);
    if (s.fighters[0].action === ACT.ROLL) rolled = Math.sign(s.fighters[0].dir);
  }
  check(`Shield + stick ${dir < 0 ? 'left' : 'right'} is a roll with dir ${dir}`, rolled === dir, `dir ${rolled}`);
}
{
  const s = ready();
  let dodged = false;
  for (const inp of [...rep(8, packInput(0, 0, SH)), ...rep(4, packInput(0, -100, SH)), ...rep(6, packInput(0, 0, SH))]) {
    step(s, [inp, NO_INPUT]);
    if (s.fighters[0].action === ACT.SPOTDODGE) dodged = true;
  }
  check('Shield + stick down is a spot dodge', dodged);
}

// The swinging dummy: walks to the player, swings no more often than every SWING_EVERY frames, and does swing.
{
  const s = fresh();
  const d = new SwingDummy();
  const swings: number[] = [];
  let was = false;
  let closest = Infinity;
  for (let i = 0; i < 3000; i++) {
    step(s, [NO_INPUT, d.think(s, 1)]);
    closest = Math.min(closest, Math.abs(s.fighters[1].x - s.fighters[0].x) / FX);
    const sw = s.fighters[1].action === ACT.ATTACK;
    if (sw && !was) swings.push(i);
    was = sw;
  }
  const gaps = swings.slice(1).map((f, i) => f - swings[i]);
  check('the dummy swings', swings.length >= 2, `${swings.length} swings`);
  check('the dummy swings slowly', gaps.length > 0 && Math.min(...gaps) >= SWING_EVERY, `gaps ${gaps.join(',')}`);
  check('the dummy walked up to the player', closest < 150, `${Math.round(closest)} units at closest`);
}

// Lesson 3: every step has a prompt for each device.
for (const st of RECOVERY_STEPS) {
  const p = PROMPTS[st];
  check(`prompt ${st}`, !!p.word && p.glyphs.keyboard.length > 0 && p.glyphs.gamepad.length > 0 && p.glyphs.touch.length > 0);
}

// Lesson 3: the staged knock-off (Match.stageKnockoff: both at the right edge, the player at 20%, the dummy swinging within a
// second) throws the player off the stage but not out of reach, and a double jump + up special back grabs the ledge.
{
  const s = fresh();
  run(s, rep(90, NO_INPUT));
  const [a, b] = s.fighters;
  const edge = Math.max(...STAGES[stage].platforms.filter((p) => p.solid).map((p) => p.x2));
  a.x = (edge - 60) * FX;
  b.x = (edge - 120) * FX;
  a.facing = -1;
  b.facing = 1;
  a.percent = 200;
  const d = new SwingDummy();
  d.prime(SWING_EVERY - 60);
  let hitAt = -1;
  let ledgeAt = -1;
  let dead = false;
  let jumped = false;
  let upB = false;
  let wait = 0;
  for (let i = 0; i < 600 && ledgeAt < 0 && !dead; i++) {
    let inp = NO_INPUT;
    if (hitAt >= 0) {
      if (!jumped && !a.grounded && a.action !== ACT.HITSTUN) {
        inp = packInput(-100, 0, BTN.JUMP);
        jumped = true;
      } else if (jumped && !upB) {
        wait++;
        inp = packInput(-100, 0, 0);
        if (wait > 15 && a.action === ACT.AIR) {
          inp = packInput(-100, 100, BTN.SPECIAL);
          upB = true;
        }
      } else if (upB) inp = packInput(-100, 0, 0);
    }
    for (const e of step(s, [inp, d.think(s, 1)])) {
      if (e.type === 'hit' && e.victim === 0 && hitAt < 0) hitAt = i;
      if (e.type === 'ledge' && e.id === 0) ledgeAt = i;
      if (e.type === 'ko' && e.victim === 0) dead = true;
    }
    if (hitAt >= 0 && a.x / FX > edge + 5) offEdge = true;
  }
  check('the dummy hits the player within 3 s of the staging', hitAt >= 0 && hitAt < 180, `frame ${hitAt}`);
  check('the knock-off carries the player off the stage', offEdge);
  check('double jump + up special reaches the ledge (a ledge event)', ledgeAt > hitAt && !dead, `ledge at ${ledgeAt}, dead ${dead}`);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('lesson ok');
