// Every fighter has a round profile picture of its face: a box in content/heads.json and a square
// characters/head/<id>.webp made from it by tools/heads.mjs. Run with `npm test`.

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

for (const { id } of fighters) {
  const box = heads[id];
  check(!!box && box.size > 0 && box.size <= 1 && box.y > 0 && box.x > 0, `${id}: head box in content/heads.json`);
  const file = join(ROOT, 'characters', 'head', `${id}.webp`);
  if (!existsSync(file)) { check(false, `${id}: characters/head/${id}.webp (run node tools/heads.mjs)`); continue; }
  const [w, h] = webpSize(file);
  check(w === h && w >= 96, `${id}: head picture is square (${w}x${h})`);
}

console.log(failed ? `\n${failed} failed` : '\nall head pictures ok');
process.exit(failed ? 1 : 0);
