// Removes the red / cyan / green fringe from stage layers (CPU only, no Gen).
//
// Cause: a layer cut from a picture (Gen's image.layers, depth-layers.mjs, image.cutout) keeps whatever colour was
// behind the transparent pixels (the inpainted sky, a green or magenta key). Bilinear sampling blends that colour into
// the opaque edge, which shows as a thin red / cyan halo around every building, tower and prop on a posterised cut.
// Fix: every pixel that is nearly transparent (alpha < LOW) takes the colour of the nearest solid pixels (edge colours
// pushed outwards, up to REACH px), so a blend at the edge only ever mixes the object's own colour. The alpha and every
// pixel at alpha >= LOW stay as they are. Glow layers (additive) are skipped: their colour IS their light.
//
// usage: node tools/defringe-layers.mjs [--write] [--stage <id>]       (needs sharp: npm i --no-save sharp, or SHARP_PATH)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const req = createRequire(import.meta.url);
let sharp;
for (const p of ['sharp', process.env.SHARP_PATH || '/tmp/depth-tools/node_modules/sharp']) {
  try {
    sharp = req(p);
    break;
  } catch {
    /* next */
  }
}
if (!sharp) {
  console.log('defringe-layers: sharp is not installed (npm i --no-save sharp, or SHARP_PATH=<path to sharp>)');
  process.exit(2);
}
const LOW = 96;
const REACH = 8;
const write = process.argv.includes('--write');
const only = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : null;
const stages = JSON.parse(fs.readFileSync(root + 'content/stages.json', 'utf8'));

/** Edge colours pushed out into the near-transparent pixels. Returns how many pixels changed. */
export function defringe(px, W, H) {
  const N = W * H;
  const known = new Uint8Array(N);
  let solid = 0;
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] >= LOW) (known[i] = 1), solid++;
  if (!solid) return 0;
  const out = new Uint8Array(N * 3);
  let changed = 0;
  let front = known;
  for (let pass = 0; pass < REACH; pass++) {
    const next = Uint8Array.from(front);
    let grew = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (front[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (!front[j]) continue;
            // the first ring reads the original solid pixels, later rings the colours already pushed out
            const src = known[j] ? px : out;
            const o = known[j] ? j * 4 : j * 3;
            r += src[o];
            g += src[o + 1];
            b += src[o + 2];
            n++;
          }
        if (!n) continue;
        out[i * 3] = Math.round(r / n);
        out[i * 3 + 1] = Math.round(g / n);
        out[i * 3 + 2] = Math.round(b / n);
        next[i] = 1;
        grew++;
      }
    front = next;
    if (!grew) break;
  }
  for (let i = 0; i < N; i++)
    if (!known[i] && front[i]) {
      px[i * 4] = out[i * 3];
      px[i * 4 + 1] = out[i * 3 + 1];
      px[i * 4 + 2] = out[i * 3 + 2];
      changed++;
    }
  return changed;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const seen = new Set();
  let files = 0;
  for (const s of stages) {
    if (only && s.id !== only) continue;
    for (const l of s.layers ?? []) {
      if (l.glow || !/\.webp$/.test(l.image) || seen.has(l.image)) continue;
      seen.add(l.image);
      const file = root + l.image;
      if (!fs.existsSync(file)) continue;
      const img = sharp(file).ensureAlpha();
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
      const px = new Uint8Array(data);
      const changed = defringe(px, info.width, info.height);
      if (!changed) continue;
      files++;
      console.log(`${s.id}/${l.id}: ${changed} edge pixels recoloured (${((changed / (info.width * info.height)) * 100).toFixed(1)}%)`);
      if (write) {
        const buf = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
          .webp({ quality: 92, alphaQuality: 100, exact: true, effort: 5 })
          .toBuffer();
        fs.writeFileSync(file, buf);
      }
    }
  }
  console.log(`${files} layer files ${write ? 'rewritten' : 'would change (use --write)'}`);
}
