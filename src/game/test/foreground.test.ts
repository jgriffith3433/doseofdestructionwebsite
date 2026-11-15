declare const process: { exit(code: number): never };
// Depth on every stage (render/foreground.ts, render/stageArt.ts layersFor, content/stages.json): at least four
// layers at different depths behind the fighters on High (three depths counting the foreground on Low), one foreground
// element at the play area's edge that fades to 30% behind a fighter, a haze tinted to the stage, and the maths of
// the fade: a ray from the camera through the body onto the layer, read against the picture's alpha.

let failed = 0;
const ok = (c: unknown, m: string) => {
  if (!c) {
    failed++;
    console.error(`FAIL: ${m}`);
  }
};
import { STAGES } from '../sim/stage.ts';
import { layersFor } from '../render/stageArt.ts';
import { FADE_TO, behindForeground, bodyPoints, fadeToward, maskFromRGBA, rayToPlane, solidAt } from '../render/foreground.ts';

const depths = (layers: { z: number; image: string; hidden?: boolean }[], pick: (z: number) => boolean) =>
  new Set(layers.filter((l) => l.image && !l.hidden && pick(l.z)).map((l) => l.z)).size;

for (const s of STAGES) {
  const high = layersFor(s, true);
  const low = layersFor(s, false);
  ok(depths(high, (z) => z > 0.5) >= 4, `${s.id}: ${depths(high, (z) => z > 0.5)} depths behind the fighters on High (want 4+)`);
  ok(depths(low, (z) => z > 0.5 || z < 0) >= 3, `${s.id}: ${depths(low, (z) => z > 0.5 || z < 0)} depths on Low (want 3+)`);
  ok(low.every((l) => !l.high), `${s.id}: Low builds a high-only layer`);
  const fg = high.filter((l) => l.foreground);
  ok(fg.length >= 1, `${s.id}: no foreground element`);
  ok(fg.every((l) => l.z < 0 && l.image && !l.high), `${s.id}: a foreground element must be in front, drawn, and on Low too`);
  // At the play area's edge: within reach of the main floor's end.
  const edge = Math.max(...s.platforms.filter((p) => p.solid).map((p) => p.x2));
  ok(fg.some((l) => Math.abs(Math.abs(l.x) - edge) <= 260), `${s.id}: foreground not at the play area's edge (${edge})`);
  ok(!!s.haze && /^#[0-9a-f]{6}$/i.test(s.haze.color) && s.haze.strength > 0 && s.haze.strength <= 0.6 && s.haze.z.length >= 2, `${s.id}: haze`);
  const far = Math.max(...high.filter((l) => l.z > 0.5).map((l) => l.z));
  ok((s.haze?.z ?? []).every((z) => z > 0.5 && z < far), `${s.id}: haze sheets sit between the layers`);
  // The painted decks the layers draw keep to the platforms (tools/deck-align.mjs measures the art).
  ok(s.platforms.every((p) => Number.isFinite(p.y)), `${s.id}: platforms`);
}

// The fade maths: a 4x4 picture, solid in its top-left cell only, on a plane 2 units wide and 2 tall at z -2.
const rgba = new Uint8Array(4 * 4 * 4);
rgba[3] = 255;
const mask = maskFromRGBA(rgba, 4, 4);
ok(mask.w === 4 && mask.h === 4 && mask.a[0] === 255 && mask.a[1] === 0, 'mask grid');
const plane = { x: 0, y: 0, z: -2, w: 2, h: 2 };
ok(solidAt(mask, plane, -0.75, 0.75), 'solid cell is solid (top-left)');
ok(!solidAt(mask, plane, 0.75, 0.75) && !solidAt(mask, plane, -0.75, -0.75), 'clear cells are clear');
ok(!solidAt(mask, plane, -1.5, 0.75), 'outside the picture is clear');
const cam = { x: 0, y: 0, z: -16 };
const hit = rayToPlane(cam, { x: 1, y: 1, z: 0 }, -2)!;
ok(Math.abs(hit.x - 0.875) < 1e-9 && Math.abs(hit.y - 0.875) < 1e-9, `ray to the layer plane: ${hit.x}, ${hit.y}`);
// A fighter at z 0 straight behind the solid cell (seen from the camera) is behind it; one off to the right is not.
const behind = (x: number, y: number) => behindForeground(mask, plane, cam, [{ x, y, z: 0 }]);
ok(behind(-0.75 * (16 / 14), 0.75 * (16 / 14)), 'a fighter lined up behind the solid pixel');
ok(!behind(3, 0.75), 'a fighter off to the side is not behind it');
// The camera moving across the element changes what is behind it: the same fighter, a moved camera.
ok(!behindForeground(mask, plane, { x: 3, y: 0, z: -16 }, [{ x: -0.75 * (16 / 14), y: 0.75 * (16 / 14), z: 0 }]), 'parallax: the camera moved off the line');
// A point nearer the camera than the element is in front of it, never behind.
ok(!behindForeground(mask, plane, cam, [{ x: -0.75, y: 0.75, z: -3 }]), 'in front of the element');
// Fade: toward 30% while behind, back to 100% after, never past either, whatever the frame rate.
let a = 1;
for (let i = 0; i < 40; i++) a = fadeToward(a, true, 1 / 60);
ok(Math.abs(a - FADE_TO) < 0.01, `fades to ${FADE_TO}: ${a}`);
for (let i = 0; i < 60; i++) a = fadeToward(a, false, 1 / 30);
ok(a === 1, `comes back: ${a}`);
ok(fadeToward(1, true, 0) === 1, 'no time, no change');
ok(bodyPoints(0, 0, 1, 0.2).length === 5, 'body points');

if (failed) process.exit(1);
console.log('foreground: ok');
