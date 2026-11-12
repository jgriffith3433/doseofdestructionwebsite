// The special-effect flipbooks' data (render/flipbook.ts, content/flipbooks.json): atlas layout, frame rectangles,
// the per-fighter tint. Pure functions only, no canvas or GPU.

import { FIGHTERS } from '../sim/characters.ts';
import { FLIPBOOK_KINDS, atlasFor, fighterTint, frameUV, holdFor } from '../render/flipbook.ts';
import { SPECIAL_KINDS } from '../sim/fighterDefs.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} flipbook: ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

check('one flipbook per special archetype', FLIPBOOK_KINDS.length === 7 && SPECIAL_KINDS.every((k) => FLIPBOOK_KINDS.includes(k)));
const hi = atlasFor('projectile', 'high');
const lo = atlasFor('projectile', 'low');
check('High: 16 frames of 256 px cells', hi.frames === 16 && hi.cell === 256 && hi.cols * hi.rows === 16);
check('Low: half-size 8 frames of 128 px cells', lo.frames === 8 && lo.cell === 128 && lo.cols * lo.rows === 8);
check('both sheets last the same time (32 sim frames)', hi.frames * holdFor('high') === lo.frames * holdFor('low'));
const first = frameUV(hi, 0);
const last = frameUV(hi, 15);
check('frame 0 is the top-left cell, frame 15 the bottom-right', first.u0 === 0 && first.v1 === 1 && last.u1 === 1 && last.v0 === 0);
check('frames stay inside the atlas', Array.from({ length: 20 }, (_, i) => frameUV(lo, i)).every((r) => r.u0 >= 0 && r.u1 <= 1 && r.v0 >= 0 && r.v1 <= 1));
const tints = FIGHTERS.map((f) => fighterTint(f.looks, f.id));
check('every fighter has a tint, bright enough to read additive', tints.every((c) => Math.max(c.r, c.g, c.b) > 0.5));
const key = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map((v) => Math.round(v * 20)).join(',');
check('fighters do not all share one tint', new Set(tints.map(key)).size >= 12, `${new Set(tints.map(key)).size} distinct of ${tints.length}`);
if (failed) process.exit(1);
