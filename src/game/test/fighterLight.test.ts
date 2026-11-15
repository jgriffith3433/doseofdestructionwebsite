declare const process: { exit(code: number): never };
// Fighter lighting data and shadow maths (render/fighterLight.ts): every stage has a light, the shadow shrinks and
// fades with height and is gone at 300 units, and the platform below is found.

let failed = 0;
const ok = (c: unknown, m: string) => {
  if (!c) {
    failed++;
    console.error(`FAIL: ${m}`);
  }
};
const assert = {
  ok: (c: unknown, m?: string) => ok(c, m ?? 'assert'),
  equal: (a: unknown, b: unknown, m?: string) => ok(a === b, `${m ?? 'equal'}: ${String(a)} !== ${String(b)}`),
  match: (a: string, r: RegExp, m?: string) => ok(r.test(a), m ?? `${a} !~ ${r}`),
};
import { STAGES } from '../sim/stage.ts';
import { FX } from '../sim/fixed.ts';
import { SHADOW_ALPHA, SHADOW_MIN_SCALE, SHADOW_RANGE, floorBelow, hexRgb, shadowAt } from '../render/fighterLight.ts';

const hex = /^#[0-9a-f]{6}$/i;
for (const s of STAGES) {
  const l = s.light!;
  assert.ok(l, `${s.id} has a light`);
  for (const c of [l.key.color, l.rim.color, l.ambient]) assert.match(c, hex, `${s.id} colour ${c}`);
  assert.ok(Math.hypot(...l.key.dir) > 0.1, `${s.id} key direction`);
  assert.ok(l.key.strength > 0 && l.key.strength <= 1 && l.rim.strength > 0 && l.rim.strength <= 1, `${s.id} strengths`);
  // The ambient multiplies the sprite: dark enough to tint, never to bury it.
  assert.ok(Math.min(...hexRgb(l.ambient)) >= 0.55, `${s.id} ambient is too dark`);
}
// Stages differ: no two share the same key colour.
assert.equal(new Set(STAGES.map((s) => s.light!.key.color)).size, STAGES.length);
// City Top is warm (red over blue key), the cold stage cool.
const city = hexRgb(STAGES.find((s) => s.id === 'city-top')!.light!.key.color);
const chess = hexRgb(STAGES.find((s) => s.id === 'space-chess')!.light!.key.color);
assert.ok(city[0] > city[2] + 0.2 && chess[2] > chess[0] + 0.2);

const near = shadowAt(0);
assert.equal(near.on, true);
assert.equal(near.scale, 1);
assert.equal(near.alpha, SHADOW_ALPHA);
let prev = near;
for (const h of [50, 100, 200, 299]) {
  const s = shadowAt(h);
  assert.ok(s.on && s.scale < prev.scale && s.alpha < prev.alpha, `shrinks at ${h}`);
  assert.ok(s.scale >= SHADOW_MIN_SCALE);
  prev = s;
}
assert.equal(shadowAt(SHADOW_RANGE).on, false);
assert.equal(shadowAt(900).on, false);
assert.equal(shadowAt(null).on, false);

// The platform below: on City Top's main floor (y 0), above its middle block (y 280 at x -110..110).
const city0 = STAGES.find((s) => s.id === 'city-top')!;
assert.equal(floorBelow(city0, 0, 0, 100 * FX), 0);
assert.equal(floorBelow(city0, 0, 0, 400 * FX), 280);
assert.equal(floorBelow(city0, 0, -530 * FX, 0), 0);
assert.equal(floorBelow(city0, 0, 5000 * FX, 0), null);
if (failed) process.exit(1);
console.log('fighterLight: ok');
