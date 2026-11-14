import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, newGame } from '../sim/state.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { step } from '../sim/step.ts';

declare const process: { exit(code: number): never };
import { newLatch, latchShield } from '../input/shieldMode.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };
const sh = (o: number) => (o & BTN.SHIELD) !== 0;

// One press raises it and it stays with nothing held.
let s = newLatch();
ok(sh(latchShield(s, BTN.SHIELD, 0, 0, false)), 'press raises');
let out = 0;
for (let i = 0; i < 120; i++) out = latchShield(s, 0, 0, 0, true);
ok(sh(out) && s.on, 'stays up with nothing held for 2 s');

// A second press drops it at once and the press stays masked until let go.
ok(!sh(latchShield(s, BTN.SHIELD, 0, 0, true)), 'second press drops');
ok(!sh(latchShield(s, BTN.SHIELD, 0, 0, false)), 'held second press stays masked');
ok(!sh(latchShield(s, 0, 0, 0, false)) && !s.on, 'let go: down');

// Roll: the sim still sees shield on the frame the stick goes over, then it ends.
s = newLatch();
latchShield(s, BTN.SHIELD, 0, 0, false);
latchShield(s, 0, 0, 0, true);
ok(sh(latchShield(s, 0, 100, 0, true)), 'roll frame still has shield for the sim');
ok(!sh(latchShield(s, 0, 100, 0, true)) && !s.on, 'then the shield is down');

// Jump and grab (Attack) do the same.
for (const b of [BTN.JUMP, BTN.ATTACK]) {
  s = newLatch();
  latchShield(s, BTN.SHIELD, 0, 0, false);
  latchShield(s, 0, 0, 0, true);
  ok(sh(latchShield(s, b, 0, 0, true)), 'action frame keeps shield');
  ok(!sh(latchShield(s, 0, 0, 0, true)), 'then drops');
}

// Spot-dodge (stick down).
s = newLatch();
latchShield(s, BTN.SHIELD, 0, 0, false);
latchShield(s, 0, 0, 0, true);
latchShield(s, 0, 0, -100, true);
ok(!sh(latchShield(s, 0, 0, -100, true)), 'spot dodge drops');

// A latch the sim never turned into a shield (a hit, a KO, a press in the air) lets go.
s = newLatch();
latchShield(s, BTN.SHIELD, 0, 0, false);
for (let i = 0; i < 20; i++) out = latchShield(s, 0, 0, 0, false);
ok(!sh(out) && !s.on, 'unused latch lets go');

// Through the real sim: a latch drives a fighter's shield with the hands empty, and a roll ends it.
const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const kaelen = CHARACTERS.findIndex((c) => c.id === 'kaelen');
const stage = STAGES.findIndex((x) => x.id === 'city-top');
const g = newGame([{ char: ep, stocks: 9 }, { char: kaelen, stocks: 9 }], { stocks: 9, seed: 5, stage });
const me = g.fighters[0];
s = newLatch();
const run = (buttons: number, sx: number, sy: number) => {
  const o = latchShield(s, buttons, sx, sy, me.action === ACT.SHIELD);
  step(g, [packInput(sx, sy, o), NO_INPUT]);
};
for (let i = 0; i < 90; i++) run(0, 0, 0);
run(BTN.SHIELD, 0, 0);
for (let i = 0; i < 90; i++) run(0, 0, 0);
ok(me.action === ACT.SHIELD, 'the sim holds the shield after one tap');
run(0, 100, 0);
run(0, 100, 0);
ok(me.action === ACT.ROLL, `the roll comes out of the latched shield (${me.action})`);
for (let i = 0; i < 60; i++) run(0, 0, 0);
ok(me.action !== ACT.SHIELD && !s.on, 'and the shield stays down after');

if (fails) process.exit(1);
console.log('shieldMode ok');
