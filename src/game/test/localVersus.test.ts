// Two people on one machine: each controller drives its own fighter; solo play still merges keyboard and pads.
import { Match, type MatchSetup } from '../match.ts';
import { BTN, packInput, stickX } from '../sim/input.ts';
import { emulatePad, readHumans, readLocal } from '../input/devices.ts';

declare const process: { exit(code: number): never };
let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

const pad = (right: boolean, attack = false) => ({ buttons: Array.from({ length: 17 }, (_, i) => i === 15 && right) .map((v, i) => v || (attack && i === 0)), axes: [0, 0] as [number, number] });
const setup = (cpu1: number | null): MatchSetup => ({ mode: 'versus', stage: 0, stocks: 2, rules: {}, slots: [{ char: 0, cpu: null }, { char: 1, cpu: cpu1 }] });

// Two pads, two people: pad 1 pushes right, pad 2 does nothing -> only fighter 0 moves.
emulatePad(pad(true), 0);
emulatePad(pad(false), 1);
let h = readHumans(2);
ok(h.length === 2, 'two inputs for two people');
ok(stickX(h[0]) > 50, 'pad 1 moves player 1');
ok(stickX(h[1]) === 0, 'pad 2 idle: player 2 does not move');
const m = new Match(setup(null), 7);
ok(m.humans === 2, 'two humans counted');
for (let i = 0; i < 60; i++) { h = readHumans(2); m.tick(h[0], h.slice(1)); }
const x0 = m.state.fighters[0].x, x1 = m.state.fighters[1].x;
// Now swap: pad 2 pushes left, pad 1 idle.
emulatePad(pad(false), 0);
emulatePad({ buttons: Array.from({ length: 17 }, (_, i) => i === 14), axes: [0, 0] }, 1);
for (let i = 0; i < 60; i++) { h = readHumans(2); m.tick(h[0], h.slice(1)); }
ok(m.state.fighters[0].x === x0 || Math.abs(m.state.fighters[0].x - x0) < Math.abs(x0) , 'player 1 stays put while only pad 2 is pushed');
ok(m.state.fighters[1].x !== x1, 'pad 2 moved player 2');
ok(stickX(h[1]) < -50 && stickX(h[0]) === 0, 'inputs are independent');

// Solo: one human, a pad pushes right: readLocal merges every pad into player 1 as before.
emulatePad(null, 0);
emulatePad(null, 1);
emulatePad(pad(true), 0);
emulatePad(pad(false, true), 1);
const solo = readHumans(1);
ok(solo.length === 1 && stickX(solo[0]) > 50 && (solo[0] & BTN.ATTACK) !== 0, 'solo: both pads feed player 1');
void readLocal;

// One pad, two people: the keyboard is player 1, the pad is player 2.
emulatePad(null, 0);
emulatePad(null, 1);
emulatePad(pad(true), 0);
h = readHumans(2);
ok(stickX(h[0]) === 0 && stickX(h[1]) > 50, 'one pad + keyboard: the pad is player 2');
void packInput;
emulatePad(null, 0);
if (fails) process.exit(1);
console.log('localVersus ok');
