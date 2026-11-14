declare const process: { exit(code: number): never };
// Readability maths (readability.ts): luminance and contrast, a fighter's ring against what is behind it, the foreground
// cover share, and a platform edge against the area above it, on synthetic frames.

let failed = 0;
const ok = (c: unknown, m: string) => {
  if (!c) {
    failed++;
    console.error(`FAIL: ${m}`);
  }
};
import { MAX_COVER, MIN_CONTRAST, contrast, coverRead, edgeContrast, fighterMask, lumAt, maskSize, ringContrast, ringWidth, type Frame } from '../readability.ts';

const W = 120;
const H = 100;
const frame = (fill: (x: number, y: number) => [number, number, number]): Frame => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set([...fill(x, y), 255], (y * W + x) * 4);
  return { w: W, h: H, d };
};

ok(Math.abs(contrast(1, 0) - 21) < 1e-9, 'white on black is 21:1');
ok(Math.abs(contrast(0.5, 0.5) - 1) < 1e-9, 'same luminance is 1:1');
ok(lumAt(frame(() => [255, 255, 255]), 0) > 0.999, 'white luminance is 1');
ok(lumAt(frame(() => [0, 0, 0]), 0) === 0, 'black luminance is 0');

// A fighter: a 20x40 body with a 2 px bright rim over a 2 px dark outline, on a mid-grey picture.
const grey = (x: number, y: number): [number, number, number] => [90, 90, 90];
const body = (x: number, y: number) => x >= 50 && x < 70 && y >= 30 && y < 70;
const fighter = frame((x, y) => {
  if (!body(x, y)) return grey(x, y);
  const e = Math.min(x - 50, 69 - x, y - 30, 69 - y);
  return e < 2 ? [255, 220, 90] : e < 4 ? [20, 10, 10] : [200, 60, 60];
});
const bare = frame(grey);
const box = { x1: 40, y1: 20, x2: 80, y2: 80 };
const mask = fighterMask(fighter, bare, box);
ok(maskSize(mask) >= 700 && maskSize(mask) <= 800, `the silhouette is ${maskSize(mask)} px (want ~800)`);
ok(ringWidth(1080) === 5 && ringWidth(390) === 2, `ring width ${ringWidth(1080)} / ${ringWidth(390)}`);
const ring = ringContrast(fighter, bare, box);
ok(ring.best >= MIN_CONTRAST, `a bright rim on grey reads: ${ring.best.toFixed(2)}`);
// The same fighter on its own colour: no ring.
const same = frame((x, y) => (body(x, y) ? [90, 90, 90] : grey(x, y)));
ok(ringContrast(same, bare, box).px < 60, 'a fighter the same as the picture is not measurable');
// A rim the colour of the background fails.
const flat = frame((x, y) => (body(x, y) ? [100, 100, 100] : grey(x, y)));
ok(ringContrast(flat, bare, box).best < MIN_CONTRAST, 'a ring close to the background does not read');

// Foreground cover: a bar across the left half of the fighter, opaque (hides them) or see-through.
const bar = (x: number, y: number) => x >= 40 && x < 60;
const fgStage = frame((x, y) => (bar(x, y) ? [30, 120, 30] : grey(x, y)));
const hidden = frame((x, y) => (bar(x, y) ? [30, 120, 30] : body(x, y) ? [200, 60, 60] : grey(x, y)));
const seen = frame((x, y) => (bar(x, y) ? (body(x, y) ? [150, 100, 60] : [30, 120, 30]) : body(x, y) ? [200, 60, 60] : grey(x, y)));
const onlyF = frame((x, y) => (body(x, y) ? [200, 60, 60] : grey(x, y)));
const c1 = coverRead(onlyF, bare, fgStage, hidden, box);
ok(c1.covered > MAX_COVER && c1.shown < 0.1, `an opaque bar hides half the fighter: ${c1.covered.toFixed(2)} covered, ${c1.shown.toFixed(2)} shown`);
const c2 = coverRead(onlyF, bare, fgStage, seen, box);
ok(c2.covered > MAX_COVER && c2.shown > 0.9, `a see-through bar still shows them: ${c2.shown.toFixed(2)}`);
const c3 = coverRead(onlyF, bare, bare, onlyF, box);
ok(c3.covered === 0, 'no foreground, nothing covered');

// A platform's edge: a bright lip row on a dark picture reads, on a bright picture it needs the dark line.
const lipRows = (bg: number, core: number, line: number) =>
  frame((x, y) => (y === 60 ? [line, line, line] : y === 61 || y === 62 ? [core, core, core] : y === 63 ? [line, line, line] : [bg, bg, bg]));
const e1 = edgeContrast(lipRows(30, 250, 10), 10, 110, 60, 4);
ok(e1 !== null && e1.contrast >= MIN_CONTRAST, `a bright lip on a dark picture: ${e1?.contrast.toFixed(2)}`);
const e2 = edgeContrast(lipRows(240, 250, 10), 10, 110, 60, 4);
ok(e2 !== null && e2.contrast >= MIN_CONTRAST, `a dark line parts a lip from a bright picture: ${e2?.contrast.toFixed(2)}`);
const e3 = edgeContrast(lipRows(120, 125, 118), 10, 110, 60, 4);
ok(e3 !== null && e3.contrast < MIN_CONTRAST, `a lip the colour of the picture does not read: ${e3?.contrast.toFixed(2)}`);
ok(edgeContrast(lipRows(30, 250, 10), 10, 20, 60, 4) === null, 'a platform too narrow on screen is not measured');

if (failed) process.exit(1);
console.log('readability.test.ts ok');
