// Checks the hit-readability pieces that need no browser: the damage number's colour ramp and shake, the launch trail's
// look by tier and knockback, and where an off-screen marker goes on a phone (inside the safe area, off the touch buttons).

import { damageColor, damageShake, trailFor } from '../hitFeel.ts';
import { markerSize, placeMarker, type Rect } from '../ui/offscreen.ts';

declare const process: { exit(code: number): never };
let bad = 0;
const check = (ok: boolean, what: string): void => {
  if (!ok) {
    bad++;
    console.error(`FAIL ${what}`);
  }
};
const rgb = (c: string): number[] => (/rgb\((\d+), (\d+), (\d+)\)/.exec(c) ?? []).slice(1).map(Number);

// Damage numbers: white at 0%, orange in between, red above 120%, deep red at 160%+.
check(damageColor(0) === 'rgb(255, 255, 255)', 'white at 0%');
const mid = rgb(damageColor(600));
check(mid[0] > 240 && mid[1] > 120 && mid[1] < 180 && mid[2] < 80, `orange at 60% (${mid})`);
for (const t of [1210, 1400, 2500]) {
  const [r, g, b] = rgb(damageColor(t));
  check(r > 150 && g < 70 && b < 70, `red above 120% (${t}: ${r},${g},${b})`);
}
check(rgb(damageColor(2500))[0] < rgb(damageColor(1210))[0], 'deeper red at 250% than 121%');
check(damageShake(200, 900).pop && !damageShake(30, 900).pop, 'only a heavy hit pops the damage number');
check(damageShake(100, 1500).amp > damageShake(100, 0).amp, 'the shake grows with the damage');

// Launch trail: none for a light hit, grey medium, white heavy, a streak when it kills; more and bigger with knockback.
check(trailFor('light', 40, false).kind === 'none', 'light: no trail');
check(trailFor('medium', 40, false).kind === 'grey', 'medium: grey');
check(trailFor('heavy', 40, false).kind === 'white', 'heavy: white');
check(trailFor('heavy', 40, true).kind === 'streak' && trailFor('light', 40, true).kind === 'streak', 'a KO: streak');
check(trailFor('heavy', 100, false).puffs > trailFor('heavy', 10, false).puffs && trailFor('heavy', 100, false).size > trailFor('heavy', 10, false).size, 'more and larger puffs with knockback');

// Markers: bigger nearer the blast line.
check(markerSize(0, false) > markerSize(600, false) && markerSize(0, true) >= 38, 'marker grows near the blast line');

// A phone, 844x390: stick bottom-left, buttons bottom-right, pause top-right, damage cards bottom-centre.
const w = 844;
const h = 390;
const safe: Rect = { l: 8, t: 8, r: w - 8, b: h - 8 };
const blocked: Rect[] = [
  { l: 16, t: 180, r: 144, b: 308 },
  { l: w - 16 - 196, t: 180, r: w - 16, b: 308 },
  { l: w - 76, t: 12, r: w - 12, b: 68 },
  { l: 300, t: 320, r: 544, b: 378 },
];
const targets: [number, number][] = [[-300, 250], [w + 300, 250], [w + 200, -100], [-100, 20], [420, h + 200], [100, h + 100], [w - 100, h + 100], [w + 50, 40]];
for (const [x, y] of targets) {
  const size = markerSize(100, true);
  const p = placeMarker(x, y, w, h, size, safe, blocked);
  const r = { l: p.x - size / 2, t: p.y - size / 2, r: p.x + size / 2, b: p.y + size / 2 };
  check(r.l >= safe.l - 0.5 && r.t >= safe.t - 0.5 && r.r <= safe.r + 0.5 && r.b <= safe.b + 0.5, `marker for (${x},${y}) inside the safe area (${r.l},${r.t},${r.r},${r.b})`);
  check(!blocked.some((b) => r.l < b.r && r.r > b.l && r.t < b.b && r.b > b.t), `marker for (${x},${y}) off the controls (${Math.round(p.x)},${Math.round(p.y)})`);
  check(p.clear, `marker for (${x},${y}) reports clear`);
}
const left = placeMarker(-300, 250, w, h, 44, safe, blocked);
check(Math.abs(left.angle) > 2.5 || left.angle < -2.5 || left.angle > 2.5, 'arrow points left for a fighter off the left edge');

if (bad) process.exit(1);
console.log('feedback.test: ok');
