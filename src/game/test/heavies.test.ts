// Heavies trade speed for power (content/fighters.json): the power index (kb x dmg / frames) rises with weight, no heavy sits
// below the roster median, and at 100% a heavy's forward smash launches a mid-weight farther than a lightweight's does.
// The balance gate (balance.test.ts) separately keeps every win rate inside its band.

import { CHARACTERS } from '../sim/characters.ts';
import { MOVE } from '../sim/fighterDefs.ts';
import { knockback } from '../sim/step.ts';
import fighters from '../../../content/fighters.json' with { type: 'json' };

declare const process: { exit(code: number): never };
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

type F = { id: string; weight: number; frames: number; kb: number; dmg: number };
const list = (fighters as F[]).map((f) => ({ ...f, power: (f.kb * f.dmg) / f.frames }));
const sorted = [...list].sort((a, b) => a.power - b.power);
const median = (sorted[16].power);
const heavies = list.filter((f) => f.weight >= 110);
const lights = list.filter((f) => f.weight <= 86);

// Spearman rank correlation of weight against power index.
const rank = (v: number[]) => v.map((x) => v.filter((y) => y < x).length + (v.filter((y) => y === x).length - 1) / 2);
const rw = rank(list.map((f) => f.weight));
const rp = rank(list.map((f) => f.power));
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const mw = mean(rw), mp = mean(rp);
const rho = rw.reduce((s, x, i) => s + (x - mw) * (rp[i] - mp), 0) / Math.sqrt(rw.reduce((s, x) => s + (x - mw) ** 2, 0) * rp.reduce((s, x) => s + (x - mp) ** 2, 0));
check('power index rises with weight', rho >= 0.7, `rho ${rho.toFixed(2)}`);
check('no heavy below the roster median', heavies.every((f) => f.power >= median), `median ${median.toFixed(2)}, lowest heavy ${Math.min(...heavies.map((f) => f.power)).toFixed(2)}`);
check('the heaviest out-power the lightest', mean(heavies.map((f) => f.power)) > mean(lights.map((f) => f.power)) + 0.1, `${mean(heavies.map((f) => f.power)).toFixed(2)} vs ${mean(lights.map((f) => f.power)).toFixed(2)}`);

/** Launch speed of a character's forward smash on a victim of `weight` at 100%. */
function smashKb(id: string, victimWeight: number): number {
  const c = CHARACTERS.find((x) => x.id === id)!;
  const box = c.moves[MOVE.FSMASH].hits[0].boxes[0];
  return knockback(1000, box.dmg, victimWeight, box.bkb, box.kbg);
}
const mid = 95;
const light = list.filter((f) => f.weight <= 80).map((f) => smashKb(f.id, mid));
const heavy = list.filter((f) => f.weight >= 120).map((f) => smashKb(f.id, mid));
check('a heavy forward smash launches a mid-weight farther than a lightweight\'s', Math.min(...heavy) > Math.max(...light), `heavy ${Math.min(...heavy)}..${Math.max(...heavy)}, light ${Math.min(...light)}..${Math.max(...light)}`);
if (failed) process.exit(1);
