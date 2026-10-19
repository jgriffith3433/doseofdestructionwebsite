// Every fighter has a round profile picture of its face: a box in content/heads.json and a square
// characters/head/<id>.webp made from it by tools/heads.mjs. Run with `npm test`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fighters = JSON.parse(readFileSync(join(ROOT, 'content', 'fighters.json'), 'utf8'));
const heads = JSON.parse(readFileSync(join(ROOT, 'content', 'heads.json'), 'utf8'));

let failed = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

/** Width and height from a WebP header (VP8X, VP8L or VP8). */
function webpSize(file) {
  const b = readFileSync(file);
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}

/** Alpha of a head picture (needs ffmpeg; null when it isn't installed). */
function alphaOf(file, n) {
  try {
    const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 16 << 20 });
    return (x, y) => rgba[(y * n + x) * 4 + 3] > 110;
  } catch { return null; }
}
let noFfmpeg = false;

for (const { id } of fighters) {
  const box = heads[id];
  check(!!box && box.size > 0 && box.size <= 1 && box.y > 0 && box.x > 0, `${id}: head box in content/heads.json`);
  const file = join(ROOT, 'characters', 'head', `${id}.webp`);
  if (!existsSync(file)) { check(false, `${id}: characters/head/${id}.webp (run node tools/heads.mjs)`); continue; }
  const [w, h] = webpSize(file);
  check(w === h && w >= 96, `${id}: head picture is square (${w}x${h})`);
  // ("fills": true in heads.json is for a head that is the whole picture by design: a robot, a wallet, a face under a boulder.)
  // The head must sit inside the frame: the top edge and the side edges (down to the shoulders) stay mostly clear,
  // so hair, hats and ears are not cut off.
  const solid = w === h && !box.fills ? alphaOf(file, w) : null;
  if (w === h && !box.fills && !solid) { noFfmpeg = true; continue; }
  if (solid) {
    const run = (cells) => cells.filter(([x, y]) => solid(x, y)).length / cells.length;
    const span = [...Array(w).keys()];
    const rows = [...Array(Math.round(w * 0.4)).keys()];
    const top = run(span.map((x) => [x, 0]));
    const left = run(rows.map((y) => [0, y]));
    const right = run(rows.map((y) => [w - 1, y]));
    check(top < 0.35 && left < 0.35 && right < 0.35, `${id}: head is not cut off at the edges (top ${top.toFixed(2)}, left ${left.toFixed(2)}, right ${right.toFixed(2)})`);
  }
}

if (noFfmpeg) console.log('(ffmpeg not found: edge check skipped)');
console.log(failed ? `\n${failed} failed` : '\nall head pictures ok');
process.exit(failed ? 1 : 0);
