// Bakes each stage's colour grade (content/stages.json `grade`: lift, gamma, gain, saturation, tint) into a 3D LUT
// strip, stages/<id>/lut.png (256x16: 16 slices of 16x16), the file the match renderer's post chain samples.
// The grade maths is src/game/render/grade.ts (the same function the test checks).
//   node tools/make-luts.mjs            write every stage
//   node tools/make-luts.mjs --check    fail if a stage has no grade or its LUT file is stale
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LUT_SIZE, lutPixels } from '../src/game/render/grade.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stages = JSON.parse(readFileSync(join(root, 'content/stages.json'), 'utf8'));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const png = (w, h, rgba) => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

const check = process.argv.includes('--check');
let bad = 0;
for (const s of stages) {
  if (!s.grade) {
    console.error(`${s.id}: no grade in content/stages.json`);
    bad++;
    continue;
  }
  const file = join(root, 'stages', s.id, 'lut.png');
  const data = png(LUT_SIZE * LUT_SIZE, LUT_SIZE, lutPixels(s.grade));
  if (check) {
    if (!existsSync(file) || !readFileSync(file).equals(data)) {
      console.error(`${s.id}: stages/${s.id}/lut.png is missing or stale (run node tools/make-luts.mjs)`);
      bad++;
    }
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`${s.id}: ${file.replace(root + '/', '')} (${data.length} bytes)`);
}
if (bad) process.exit(1);
