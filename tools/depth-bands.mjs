// Stand-in depth bands cut from a stage's own backdrop (CPU only, no Gen), and Cursed Town's foreground tentacle.
//
// The bands (a slice or a soft ellipse of the backdrop at its own depth) were the stand-ins until Hawkes Gen's image.layers
// split every backdrop: tools/depth-layers.mjs now cuts the real layers (with the gaps behind them filled), so BANDS below
// is empty and this tool only keeps the one piece Gen did not make: the left-most tentacle column of Cursed Town's
// distant-tentacles take, standing at the left street edge in front of the fighters (the foreground element that fades).
// Needs `sharp` (npm i --no-save sharp). usage: node tools/depth-bands.mjs [stage-id]
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
let sharp;
try {
  sharp = createRequire(import.meta.url)('sharp');
} catch {
  console.log('depth-bands: sharp is not installed (npm i --no-save sharp)');
  process.exit(1);
}

// Kept for reference of the format: { id: [{ name, z, t, b, ft, fb, note } | { name, z, ellipse: { cx, cy, rx, ry }, note }] }.
const BANDS = {};

const path = root + 'content/stages.json';
const stages = JSON.parse(fs.readFileSync(path, 'utf8'));
const only = process.argv[2];

function read(p) {
  if (fs.existsSync(root + p)) return fs.readFileSync(root + p);
  return execSync(`git -C ${root} show HEAD:${p}`, { maxBuffer: 1 << 28 });
}

for (const [id, bands] of Object.entries(BANDS)) {
  if (only && only !== id) continue;
  const st = stages.find((s) => s.id === id);
  const back = st.layers.find((l) => l.id === 'backdrop');
  const src = read(back.image);
  const meta = await sharp(src).metadata();
  const { width: iw, height: ih } = meta;
  const worldH = back.width * (ih / iw);
  fs.mkdirSync(`${root}stages/${id}/depth`, { recursive: true });
  for (const band of bands) {
    let left = 0;
    let top;
    let w = iw;
    let h;
    let alpha;
    if (band.ellipse) {
      const e = band.ellipse;
      left = Math.max(0, Math.round((e.cx - e.rx) * iw));
      const right = Math.min(iw, Math.round((e.cx + e.rx) * iw));
      top = Math.max(0, Math.round((e.cy - e.ry) * ih));
      const bottom = Math.min(ih, Math.round((e.cy + e.ry) * ih));
      w = right - left;
      h = bottom - top;
      alpha = Buffer.alloc(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - w / 2) / (w / 2);
          const dy = (y + 0.5 - h / 2) / (h / 2);
          const r = Math.sqrt(dx * dx + dy * dy);
          const a = Math.max(0, Math.min(1, (1 - r) / 0.45));
          alpha[y * w + x] = Math.round(255 * a * a * (3 - 2 * a));
        }
    } else {
      top = Math.round(band.t * ih);
      h = Math.round(band.b * ih) - top;
      alpha = Buffer.alloc(w * h);
      for (let y = 0; y < h; y++) {
        const up = band.ft ? Math.min(1, y / (h * band.ft)) : 1;
        const down = band.fb ? Math.min(1, (h - 1 - y) / (h * band.fb)) : 1;
        const a = Math.min(up, down);
        alpha.fill(Math.round(255 * a * a * (3 - 2 * a)), y * w, (y + 1) * w);
      }
    }
    const rgb = await sharp(src).extract({ left, top, width: w, height: h }).removeAlpha().raw().toBuffer();
    const out = `stages/${id}/depth/${band.name}.webp`;
    await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } }).webp({ quality: 82, alphaQuality: 90 }).toFile(root + out);
    // Same place and scale as the backdrop: the slice's centre, the full width (or the ellipse's share of it).
    const widthWorld = back.width * (w / iw);
    const cx = back.x + back.width * ((left + w / 2) / iw - 0.5);
    const cy = back.y + worldH / 2 - ((top + h / 2) / ih) * worldH;
    const layer = {
      id: band.name,
      image: out,
      x: Math.round(cx * 10) / 10,
      y: Math.round(cy * 10) / 10,
      width: Math.round(widthWorld * 10) / 10,
      z: band.z,
      high: true,
      note: band.note + ' High only; a stand-in for Hawkes Gen image.layers + image.repaint of the backdrop.',
      aspect: Math.round((h / w) * 1000) / 1000,
    };
    const at = st.layers.findIndex((l) => l.id === band.name);
    if (at >= 0) st.layers[at] = layer;
    else st.layers.splice(st.layers.findIndex((l) => l.id === 'backdrop') + 1, 0, layer);
    console.log(`${id}/${band.name}: ${w}x${h} -> ${out} (z ${band.z})`);
  }
}

// Cursed Town has no small piece of foreground art: its left-most tentacle column is cut out of the distant tentacles
// (stages/cursed-town/_takes/distant-tentacles-*) and stands at the left street edge in front of the fighters.
if (!only || only === 'cursed-town') {
  const st = stages.find((s) => s.id === 'cursed-town');
  const far = st.layers.find((l) => l.id === 'distant-tentacles');
  const src = read(far.image);
  const { width: iw, height: ih } = await sharp(src).metadata();
  const left = Math.round(0.03 * iw);
  const w = Math.round(0.21 * iw);
  const out = 'stages/cursed-town/depth/front-tentacle.webp';
  await sharp(src).extract({ left, top: 0, width: w, height: ih }).webp({ quality: 85, alphaQuality: 95 }).toFile(root + out);
  const layer = {
    id: 'front-tentacle',
    image: out,
    x: -850,
    y: 175,
    width: 130,
    z: -2,
    foreground: true,
    note: 'Foreground: a tentacle rises at the left street edge in front of the fight; fades to 30% when a fighter stands behind it.',
    aspect: Math.round((ih / w) * 1000) / 1000,
    anim: { kind: 'sway', amount: 3, speed: 3 },
  };
  const at = st.layers.findIndex((l) => l.id === 'front-tentacle');
  if (at >= 0) st.layers[at] = layer;
  else st.layers.splice(st.layers.findIndex((l) => l.id === 'front-fog') + 1, 0, layer);
  console.log(`cursed-town/front-tentacle: ${w}x${ih}`);
}
fs.writeFileSync(path, JSON.stringify(stages, null, 2) + '\n');
