// Head crops for round profile pictures: characters/head/<id>.webp, cut from characters/large/<id>.webp.
//
// Where each head sits is data, in content/heads.json: { "<id>": { "x", "y", "size" } }, the centre of the
// face and the side of the square crop, as fractions of the large image's height (x too, so a square stays
// square). A fighter missing there gets a guess from the cutout's alpha (top of the figure, centred on the
// solid pixels below it, grown until hair and ears clear the frame), written back so it can be tuned by hand.
// "fills": true marks a head that is the whole picture on purpose (the edge check in heads.test.mjs skips it). Needs ffmpeg (with libwebp) on the PATH.
//
//   node tools/heads.mjs                # every fighter: fill in missing boxes, write the head images
//   node tools/heads.mjs --only slice   # one fighter
//   node tools/heads.mjs --guess        # re-guess every box (overwrites hand tuning)
//   node tools/heads.mjs --sheet out.png  # also a contact sheet of every crop, to check the faces

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LARGE = join(ROOT, 'characters', 'large');
const HEAD = join(ROOT, 'characters', 'head');
const DATA = join(ROOT, 'content', 'heads.json');
const OUT_SIZE = 128;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const guessAll = args.includes('--guess');
const sheet = args.includes('--sheet') ? args[args.indexOf('--sheet') + 1] : null;

const fighters = JSON.parse(readFileSync(join(ROOT, 'content', 'fighters.json'), 'utf8'));
const ids = (Array.isArray(fighters) ? fighters.map((f) => f.id) : Object.keys(fighters))
  .filter((id) => existsSync(join(LARGE, `${id}.webp`)));
const heads = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : {};

function size(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim().split(',').map(Number);
  return { w, h };
}

/**
 * A first guess that keeps the whole head in frame: start at the top of the solid figure, centre on the solid
 * pixels of its top rows, and grow the square until no solid pixel touches its top or side edges in the head rows
 * (so hair, hats and ears are never cut; shoulders below don't count). Capped, and kept inside the image.
 */
function guess(file) {
  const { w, h } = size(file);
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  const solid = (x, y) => x >= 0 && x < w && y >= 0 && y < h && rgba[(y * w + x) * 4 + 3] > 110;
  let top = 0;
  find: for (; top < h; top++) for (let x = 0; x < w; x++) if (solid(x, top)) break find;
  const cap = Math.min(0.34 * h, w);
  let side = Math.min(0.2 * h, w);
  let cx = w / 2;
  for (let i = 0; i < 40; i++) {
    let sx = 0, n = 0;
    for (let y = top; y < Math.min(h, top + side * 0.5); y++) for (let x = 0; x < w; x++) if (solid(x, y)) { sx += x; n++; }
    cx = n ? sx / n : w / 2;
    const left = Math.round(cx - side / 2), right = left + Math.round(side) - 1;
    const rows = Math.round(side * 0.5);
    let cut = false;
    for (let y = top; y < Math.min(h, top + rows) && !cut; y++) if (solid(left, y) || solid(right, y)) cut = true;
    if (!cut || side >= cap) break;
    side = Math.min(cap, side * 1.05);
  }
  cx = Math.min(Math.max(cx, side / 2), w - side / 2);
  const r = (v) => Math.round((v / h) * 1000) / 1000;
  return { x: r(cx), y: r(top + side * 0.46), size: r(side) };
}

function crop(id, box, file) {
  const { w, h } = size(file);
  const s = Math.round(box.size * h);
  const x = Math.round(box.x * h - s / 2);
  const y = Math.round(box.y * h - s / 2);
  // Pad first so a box past the edge still crops (the pad is transparent).
  const pad = s;
  const vf = `pad=${w + 2 * pad}:${h + 2 * pad}:${pad}:${pad}:color=black@0,crop=${s}:${s}:${x + pad}:${y + pad},scale=${OUT_SIZE}:${OUT_SIZE}:flags=lanczos`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', vf, '-c:v', 'libwebp', '-quality', '82', '-pix_fmt', 'yuva420p', join(HEAD, `${id}.webp`)]);
}

mkdirSync(HEAD, { recursive: true });
for (const id of ids) {
  if (only && id !== only) continue;
  const file = join(LARGE, `${id}.webp`);
  if (guessAll || !heads[id]) heads[id] = guess(file);
  crop(id, heads[id], file);
  console.log(`${id}: ${JSON.stringify(heads[id])}`);
}
const sorted = Object.fromEntries(Object.keys(heads).sort().map((k) => [k, heads[k]]));
writeFileSync(DATA, `${JSON.stringify(sorted, null, 2)}\n`);

if (sheet) {
  const list = readdirSync(HEAD).filter((f) => f.endsWith('.webp')).sort();
  const cols = 11;
  const inputs = list.flatMap((f) => ['-i', join(HEAD, f)]);
  const layout = list.map((_, i) => `${(i % cols) * OUT_SIZE}_${Math.floor(i / cols) * OUT_SIZE}`).join('|');
  const filter = `${list.map((_, i) => `[${i}]format=rgba[i${i}];`).join('')}${list.map((_, i) => `[i${i}]`).join('')}xstack=inputs=${list.length}:layout=${layout}:fill=gray`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-frames:v', '1', sheet]);
  console.log(`sheet: ${sheet} (${list.join(', ')})`);
}
