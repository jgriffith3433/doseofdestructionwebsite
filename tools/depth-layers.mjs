// Real depth layers for the stage backdrops (CPU only; the art is Hawkes Gen's).
//
// Each stage's backdrop (stages/<id>/_takes/backdrop-*.webp, 1568x672) was split by Hawkes Gen `image.layers` (project
// org_eb0d5c82e8da8c2d.doseofdestruction, 5 layers at 1024x432, seed 11; the job ids are in PLANS below). Gen's pictures are
// 1024 px, so they are not shipped as they are: each layer's alpha is the CUT MASK over the full-resolution backdrop,
// and Gen's own inpainted pixels are kept only for the zones a cut reveals (what is behind a tower, behind a street).
// A band cut from one opaque Gen layer (the horizon, the plain, the room's floor) leaves a hole in the layer behind it:
// that hole is filled by diffusion (a push-pull pyramid, no GPU) so a pan never shows an empty gap.
//   layer pixel = visible share * backdrop pixel + (1 - visible share) * Gen's (or the filled) pixel
//   visible share = this layer's alpha * product of (1 - alpha) of every layer in front of it.
// At rest the stack is the backdrop (the check prints the difference); under a camera pan the layers slide at their own z.
//
// usage: node tools/depth-layers.mjs <stage-id|all> [--layers <dir of <stage>/0..4.png; a plan's `dir` names another folder, e.g. a retry>] [--out <dir>] [--write]
//                                       [--holes <dir>] [--repaint <dir>]
//   --out     where the webp files and <stage>.layers.json go (default: stages/<id>/depth; scratch while judging)
//   --write   also update content/stages.json (new layers, `low` on the full backdrop, haze depths)
//   --holes   writes, for each layer that has `holes`, <dir>/<stage>/<layer>.fill.png (the layer with its holes diffusion-filled)
//             and <dir>/<stage>/<layer>.mask.png (white = the hole): the two inputs of Hawkes Gen image.repaint, which paints
//             what the cut really revealed (stars behind the nebula) instead of a smooth blur.
//   --repaint reads <dir>/<stage>/<layer>.png (image.repaint's result for that fill + mask) and uses it in the hole instead of the
//             diffusion fill (only inside the mask: everything outside stays exactly as it was).
// Needs `sharp` (npm i --no-save sharp, or NODE_PATH to a copy).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const require_ = createRequire(import.meta.url);
let sharp;
for (const p of ['sharp', process.env.SHARP_PATH || '/tmp/depth-tools/node_modules/sharp']) {
  try {
    sharp = require_(p);
    break;
  } catch {
    /* next */
  }
}
if (!sharp) {
  console.log('depth-layers: sharp is not installed (npm i --no-save sharp, or SHARP_PATH=<path to sharp>)');
  process.exit(1);
}

const W = 1568;
const H = 672;
const N = W * H;

// ---------------------------------------------------------------------------------------------------- the plans
// Layers far -> near. src: 'B' (the backdrop) or 'gN' (Gen layer N). mask: 'alpha' (the source's own alpha), 'opaque', or a
// band { t, b, ft, fb } (top and bottom as fractions of the height, feather at each edge as a fraction of the slice) or an
// ellipse { cx, cy, rx, ry } or a colour cut { warm: { lo, hi, blur, keep: [ellipses] } } (a painting with no separate objects). erase: boxes [x0, y0, x1, y1]
// (fractions) zeroed in the layer's alpha, for a piece Gen cut into two layers (a wall lamp). holes: ids of nearer layers cut from this same source, filled by diffusion. low: this layer
// is the full backdrop Low keeps (it is not built on High, where the layers below replace it).
const PLANS = {
  'city-top': {
    jobs: 'j_de95dbaf4d12',
    layers: [
      { id: 'sky', z: 20, src: 'g0', mask: 'opaque', note: 'Far sky: the smoky night sky behind the whole skyline.' },
      { id: 'sprawl', z: 16, src: 'g1', mask: 'alpha', note: 'Far set: the amber sprawl of the city grid at the horizon.' },
      { id: 'towers', z: 12, src: 'g2', mask: 'alpha', note: 'Mid set: the downtown towers and the spire, with the fireworks over them.' },
      { id: 'rooftops', z: 9, src: 'g3', mask: 'alpha', note: 'Near set: the lit rooftops and the avenue running to the horizon.' },
    ],
    haze: [14, 7],
    remove: ['skyline'],
  },
  desert: {
    jobs: 'j_c0b792ce201e',
    layers: [
      { id: 'sky', z: 22, src: 'g0', mask: 'opaque', holes: ['horizon'], note: 'Far sky: the blue sky and the blinding sun, clear down to the horizon.' },
      { id: 'horizon', z: 17, src: 'g0', mask: { t: 0.36, b: 1, ft: 0.12, fb: 0 }, note: 'Far set: the low mesas, the dust plume and the salt flat.' },
      { id: 'near-flat', z: 12, src: 'g3', mask: 'alpha', note: 'Near set: the sandstone arch, the boulders and the cracked playa in front of them.' },
    ],
    haze: [16, 7],
    remove: ['far-buttes'],
  },
  'cursed-town': {
    jobs: 'j_baf72867a5f9',
    layers: [
      { id: 'sky', z: 20, src: 'g0', mask: 'opaque', note: 'Far sky: the pale overcast fog, no sun.' },
      { id: 'far-houses', z: 17, src: 'g2', mask: 'alpha', note: 'Far set: the last houses down the street, nearly lost in the fog.' },
      { id: 'tentacles-far', z: 15, src: 'g1', mask: 'alpha', note: 'Far set: two tentacles curling up out of the mist at the end of the street.' },
      { id: 'tentacles-mid', z: 13.5, src: 'g4', mask: 'alpha', note: 'Mid set: a thicket of black tentacles coming up the street.' },
      { id: 'street', z: 11, src: 'g3', mask: 'alpha', note: 'Mid set: the wet cobbles and the steep-roofed houses on both sides.' },
    ],
    haze: [15, 8],
    remove: ['street'],
  },
  'humans-in-the-loop': {
    // The first split (j_6b534b359dea) left the arena in one layer; the retry (j_eea1055faada, 6 layers, seed 23, a prompt naming the
    // road cases, speaker stacks, trusses, seating and beams) came back as an empty arena plate, the lit far stage, the rig with its
    // beams, a faint haze and the near cases: layers 3 (a ghost, 1.5% of the picture) and 4 (haze, no solid pixel) are not used.
    jobs: 'j_eea1055faada',
    dir: 'humans-in-the-loop-2',
    layers: [
      { id: 'arena', z: 20, src: 'g0', mask: 'opaque', note: 'Far sky: the dark arena bowl, its seating tiers, the stage floor running to the back and the far road cases.' },
      // erase: the wall lamps (at 0.22/0.44 and 0.81/0.43) and the barrier hairlines are in Gen's plate too; they stay there only.
      { id: 'far-stage', z: 16, src: 'g1', mask: 'alpha', erase: [[0, 0, 0.25, 1], [0.73, 0.585, 1, 1]], note: 'Far set: the lit far stage at the end of the floor, its row of footlights in smoke.' },
      { id: 'light-rig', z: 12, src: 'g2', mask: 'alpha', erase: [[0.78, 0.38, 0.85, 0.49]], note: 'Mid set: the lighting rig with the gold and blue beams fanning down through the haze.' },
      { id: 'road-cases', z: 5.5, src: 'g5', mask: 'alpha', note: 'Near set: the black road cases stacked at the left and the speaker stacks hung at the top corners.' },
    ],
    haze: [14, 6.5],
  },
  'watercolor-nebula': {
    // Gen's two splits (j_ee4414382a78, j_568d743c1e78) did not separate this painting (the whole painting stays in one layer, the
    // clouds are invented), so it is cut by colour on the CPU: the warm masses (amber, pink) come forward, the cool ones stay behind.
    jobs: 'j_568d743c1e78',
    how: 'cut from the backdrop by colour with tools/depth-layers.mjs (Hawkes Gen image.layers, j_ee4414382a78 and j_568d743c1e78, did not separate the painting)',
    layers: [
      { id: 'cool-wash', z: 20, src: 'B', mask: 'opaque', holes: ['warm-clouds'], note: 'Far sky: the cool teal and navy washes and the heart light.' },
      { id: 'warm-clouds', z: 13, src: 'B', mask: { warm: { lo: 0.06, hi: 0.26, blur: 10, keep: [{ cx: 0.5, cy: 0.42, rx: 0.1, ry: 0.2 }] } }, note: 'Mid set: the warm amber and pink pigment clouds around the heart.' },
    ],
    haze: [14, 7],
  },
  'rainbow-full-pipe': {
    jobs: 'j_7ec99117dab6',
    layers: [
      { id: 'sky', z: 20, src: 'g0', mask: 'opaque', note: 'Far sky: the blue sky and the morning sun.' },
      { id: 'clouds', z: 17, src: 'g1', mask: 'alpha', note: 'Far sky: the big white clouds.' },
      { id: 'park-far', z: 14, src: 'g2', mask: 'alpha', note: 'Far set: the park, the round trees and the lawn.' },
      { id: 'plaza', z: 9, src: 'g3', mask: 'alpha', note: 'Near set: the concrete plaza around the half-pipe.' },
    ],
    haze: [16, 8],
    remove: ['park'],
  },
  'solar-array': {
    jobs: 'j_baf31958c811',
    layers: [
      { id: 'sky', z: 20, src: 'g0', mask: 'opaque', holes: ['plain'], note: 'Far sky: the turquoise sky, the sun and the canyon walls.' },
      { id: 'plain', z: 14, src: 'g0', mask: { t: 0.27, b: 1, ft: 0.2, fb: 0 }, note: 'Far set: the ochre plain with the panel shadows and the rocks.' },
      { id: 'panels-far', z: 12, src: 'g1', mask: 'alpha', note: 'Far set: the far field of solar panels.' },
      { id: 'panels-mid', z: 10.5, src: 'g2', mask: 'alpha', note: 'Mid set: two panels on their pylons.' },
      { id: 'panels-edge', z: 9, src: 'g3', mask: 'alpha', note: 'Mid set: panels at the left and right edges.' },
      { id: 'panels-near', z: 7.5, src: 'g4', mask: 'alpha', note: 'Near set: the cluster of panels on the right.' },
    ],
    haze: [17, 8],
    remove: ['canyon', 'plain'],
  },
  'space-chess': {
    jobs: 'j_81bec11c18e4',
    layers: [
      { id: 'sky', z: 20, src: 'g1', mask: 'opaque', holes: ['nebula', 'galaxy'], note: 'Far sky: the star field.' },
      { id: 'nebula', z: 15, src: 'g1', mask: { ellipse: { cx: 0.55, cy: 0.27, rx: 0.34, ry: 0.28 } }, note: 'Far set: the cobalt nebula band.' },
      { id: 'galaxy', z: 11, src: 'g1', mask: { ellipse: { cx: 0.865, cy: 0.27, rx: 0.1, ry: 0.13 } }, note: 'Mid set: the spiral galaxy.' },
      { id: 'board', z: 8, src: 'g4', mask: 'alpha', note: 'Near set: the far end of the board and its pieces.' },
    ],
    haze: [17, 9.5],
    remove: ['nebula', 'galaxy'],
  },
  'yo-house': {
    jobs: 'j_0613ca74762a',
    layers: [
      { id: 'outside', z: 22, src: 'g0', mask: 'opaque', note: 'Far sky: the garden and the hills seen through the windows.' },
      { id: 'room', z: 17, src: 'g1', mask: 'alpha', holes: ['furniture'], note: 'Far set: the back wall, the kitchen and the windows (they show the outside sliding past).' },
      { id: 'furniture', z: 11, src: 'g1', mask: { t: 0.5, b: 1, ft: 0.3, fb: 0 }, note: 'Near set: the floor, the rug, the coffee table and the sofa.' },
    ],
    haze: [15, 6],
    remove: ['kitchen'],
  },
};

// ---------------------------------------------------------------------------------------------------- helpers
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

async function loadRGBA(buf) {
  const raw = await sharp(buf).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
  const rgb = new Float32Array(N * 3);
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rgb[i * 3] = raw[i * 4];
    rgb[i * 3 + 1] = raw[i * 4 + 1];
    rgb[i * 3 + 2] = raw[i * 4 + 2];
    a[i] = raw[i * 4 + 3] / 255;
  }
  return { rgb, a };
}

function read(p) {
  if (fs.existsSync(root + p)) return fs.readFileSync(root + p);
  return execSync(`git -C ${root} show HEAD:${p}`, { maxBuffer: 1 << 28 });
}

function bandMask(b) {
  const m = new Float32Array(N);
  const top = b.t * H;
  const bot = b.b * H;
  const h = bot - top;
  for (let y = 0; y < H; y++) {
    if (y < top || y >= bot) continue;
    const up = b.ft ? Math.min(1, (y - top) / (h * b.ft)) : 1;
    const dn = b.fb ? Math.min(1, (bot - 1 - y) / (h * b.fb)) : 1;
    m.fill(smooth(Math.min(up, dn)), y * W, (y + 1) * W);
  }
  return m;
}

/** Zeroes a layer's alpha inside a box [x0, y0, x1, y1] (fractions of the picture), with a soft edge: for a piece of the plate that Gen also cut into this layer (a wall lamp), so a pan never shows it twice. */
function eraseRect(a, [x0, y0, x1, y1]) {
  const f = 0.012;
  for (let y = Math.max(0, Math.floor((y0 - f) * H)); y < Math.min(H, Math.ceil((y1 + f) * H)); y++)
    for (let x = Math.max(0, Math.floor((x0 - f) * W)); x < Math.min(W, Math.ceil((x1 + f) * W)); x++) {
      const dx = Math.max(x0 - x / W, x / W - x1, 0);
      const dy = Math.max(y0 - y / H, y / H - y1, 0);
      a[y * W + x] *= smooth(Math.max(dx, dy) / f);
    }
}

/** Separable box blur of a one-channel float image (radius in pixels), to turn a speckled colour test into coherent masses. */
function boxBlur(src, r) {
  const tmp = new Float32Array(N);
  const out = new Float32Array(N);
  const k = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / k;
      acc += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / k;
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

/**
 * A colour cut of a painting that has no separate objects (a watercolor): the warm masses (amber, pink: red over blue)
 * become the nearer layer, the cool ones stay behind. warm = (R - B) / 255, blurred, then a smooth step between lo and hi;
 * `keep` ellipses (fractions of the picture) stay in the far layer (the heart light).
 */
function warmMask(back, m) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = (back[i * 3] - back[i * 3 + 2]) / 255;
  const b = boxBlur(w, m.blur ?? 10);
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = smooth((b[i] - m.lo) / (m.hi - m.lo));
  for (const e of m.keep ?? []) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = (x / W - e.cx) / e.rx;
        const dy = (y / H - e.cy) / e.ry;
        const r = Math.sqrt(dx * dx + dy * dy);
        a[y * W + x] *= smooth((r - 0.8) / 0.4);
      }
  }
  return a;
}

function ellipseMask(e) {
  const m = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x / W - e.cx) / e.rx;
      const dy = (y / H - e.cy) / e.ry;
      const r = Math.sqrt(dx * dx + dy * dy);
      m[y * W + x] = smooth((1 - r) / 0.45);
    }
  return m;
}

/** Push-pull diffusion: fills pixels with known < 1 from the known ones around them (rgb: 3 floats a pixel). */
function fillHoles(rgb, known) {
  const levels = [{ w: W, h: H, c: Float32Array.from(rgb), k: Float32Array.from(known) }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const p = levels[levels.length - 1];
    const w = Math.max(1, p.w >> 1);
    const h = Math.max(1, p.h >> 1);
    const c = new Float32Array(w * h * 3);
    const k = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sw = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const px = Math.min(p.w - 1, x * 2 + dx);
            const py = Math.min(p.h - 1, y * 2 + dy);
            const i = py * p.w + px;
            const kw = p.k[i];
            sw += kw;
            r += p.c[i * 3] * kw;
            g += p.c[i * 3 + 1] * kw;
            b += p.c[i * 3 + 2] * kw;
          }
        const o = y * w + x;
        if (sw > 1e-6) {
          c[o * 3] = r / sw;
          c[o * 3 + 1] = g / sw;
          c[o * 3 + 2] = b / sw;
        }
        k[o] = Math.min(1, sw / 4);
      }
    levels.push({ w, h, c, k });
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const f = levels[li];
    const co = levels[li + 1];
    for (let y = 0; y < f.h; y++) {
      // Bilinear read of the coarser level (its pixel centres sit between ours).
      const gy = Math.max(0, Math.min(co.h - 1, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(gy);
      const y1 = Math.min(co.h - 1, y0 + 1);
      const fy = gy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const kw = f.k[i];
        if (kw >= 1) continue;
        const gx = Math.max(0, Math.min(co.w - 1, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(gx);
        const x1 = Math.min(co.w - 1, x0 + 1);
        const fx = gx - x0;
        for (let ch = 0; ch < 3; ch++) {
          const a = co.c[(y0 * co.w + x0) * 3 + ch] * (1 - fx) + co.c[(y0 * co.w + x1) * 3 + ch] * fx;
          const b = co.c[(y1 * co.w + x0) * 3 + ch] * (1 - fx) + co.c[(y1 * co.w + x1) * 3 + ch] * fx;
          f.c[i * 3 + ch] = f.c[i * 3 + ch] * kw + (a * (1 - fy) + b * fy) * (1 - kw);
        }
        f.k[i] = 1;
      }
    }
  }
  return levels[0].c;
}

/** The hole a cut leaves, as image.repaint's mask: the cut's soft body (> 0.3) grown by a few pixels, feathered. 0..1. */
function holeMask(cut) {
  const hard = Float32Array.from(cut, (v) => (v > 0.3 ? 1 : 0));
  const grown = boxBlur(hard, 4);
  return Float32Array.from(grown, (v) => smooth(v / 0.35));
}

async function savePng(file, rgb, mono) {
  const px = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++)
    for (let ch = 0; ch < 3; ch++) {
      const v = mono ? mono[i] * 255 : rgb[i * 3 + ch];
      px[i * 3 + ch] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(file);
}

// ---------------------------------------------------------------------------------------------------- one stage
async function build(id, plan, opts) {
  const back = (await loadRGBA(read(opts.backdropPath(id)))).rgb;
  const gens = {};
  const gen = async (n) => {
    if (!gens[n]) gens[n] = await loadRGBA(fs.readFileSync(path.join(opts.layersDir, plan.dir ?? id, `${n}.png`)));
    return gens[n];
  };
  const L = [];
  for (const spec of plan.layers) {
    let src;
    let a;
    if (spec.src === 'B') src = { rgb: back, a: null };
    else src = await gen(Number(spec.src.slice(1)));
    if (spec.mask === 'alpha') {
      const [lo, hi] = spec.edge ?? [0.04, 0.96];
      a = Float32Array.from(src.a, (v) => smooth((v - lo) / (hi - lo)));
    } else if (spec.mask === 'opaque') {
      a = new Float32Array(N).fill(1);
      // Where Gen left no pixels (a cut it made at the bottom), the backdrop's own show.
      if (src.a) {
        const rgb = Float32Array.from(src.rgb);
        for (let i = 0; i < N; i++) {
          const k = smooth(src.a[i] / 0.9);
          for (let ch = 0; ch < 3; ch++) rgb[i * 3 + ch] = src.rgb[i * 3 + ch] * k + back[i * 3 + ch] * (1 - k);
        }
        src = { rgb, a: null };
      }
    } else if (spec.mask.warm) a = warmMask(back, spec.mask.warm);
    else if (spec.mask.ellipse) a = ellipseMask(spec.mask.ellipse);
    else a = bandMask(spec.mask);
    if (spec.erase) for (const r of spec.erase) eraseRect(a, r);
    L.push({ spec, src, a, rgb: src.rgb });
  }
  // Holes: the zones a nearer cut from the same source leaves empty are filled by diffusion.
  for (const l of L) {
    if (!l.spec.holes?.length) continue;
    const cut = new Float32Array(N);
    for (const id2 of l.spec.holes) {
      const o = L.find((x) => x.spec.id === id2);
      for (let i = 0; i < N; i++) cut[i] = Math.max(cut[i], o.a[i]);
    }
    const known = Float32Array.from(cut, (v) => 1 - smooth((v - 0.05) / 0.5));
    l.rgb = fillHoles(l.src.rgb, known);
    l.cut = cut;
    // image.repaint's fill, where there is one: the mask it was given is `holeMask` (cut > 0.3, grown a little), so inside it the
    // painted pixels replace the diffusion fill, with the mask's own soft edge.
    const rp = opts.repaintDir && path.join(opts.repaintDir, id, `${l.spec.id}.png`);
    if (rp && fs.existsSync(rp)) {
      const painted = (await loadRGBA(fs.readFileSync(rp))).rgb;
      const w = holeMask(cut);
      const rgb = Float32Array.from(l.rgb);
      for (let i = 0; i < N; i++)
        for (let ch = 0; ch < 3; ch++) rgb[i * 3 + ch] = l.rgb[i * 3 + ch] * (1 - w[i]) + painted[i * 3 + ch] * w[i];
      l.rgb = rgb;
      console.log(`${id}/${l.spec.id}: hole filled from the repaint ${rp.replace(root, '')}`);
    }
  }
  if (opts.holesDir) {
    for (const l of L) {
      if (!l.cut) continue;
      await savePng(path.join(opts.holesDir, id, `${l.spec.id}.fill.png`), l.rgb);
      await savePng(path.join(opts.holesDir, id, `${l.spec.id}.mask.png`), null, holeMask(l.cut));
      console.log(`${id}/${l.spec.id}: hole share ${((Float32Array.from(l.cut, (v) => (v > 0.3 ? 1 : 0)).reduce((a, b) => a + b, 0) / N) * 100).toFixed(1)}% -> ${opts.holesDir}/${id}/`);
    }
  }
  // Visible share, near to far; the pixel is the backdrop where the layer is what you see, Gen's / the filled one where it is hidden.
  const P = new Float32Array(N).fill(1);
  const out = [];
  for (let li = L.length - 1; li >= 0; li--) {
    const l = L[li];
    const px = new Uint8Array(N * 4);
    let minX = W;
    let maxX = -1;
    let minY = H;
    let maxY = -1;
    for (let i = 0; i < N; i++) {
      const v = l.a[i] * P[i];
      const a8 = Math.round(l.a[i] * 255);
      for (let ch = 0; ch < 3; ch++) {
        const c = back[i * 3 + ch] * v + l.rgb[i * 3 + ch] * (1 - v);
        px[i * 4 + ch] = c < 0 ? 0 : c > 255 ? 255 : Math.round(c);
      }
      px[i * 4 + 3] = a8;
      if (a8 > 2) {
        const x = i % W;
        const y = (i / W) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      P[i] *= 1 - l.a[i];
    }
    out.push({ l, px, box: maxX < 0 ? null : { x0: Math.max(0, minX - 3), y0: Math.max(0, minY - 3), x1: Math.min(W - 1, maxX + 3), y1: Math.min(H - 1, maxY + 3) } });
  }
  return { out: out.reverse(), back };
}

// ---------------------------------------------------------------------------------------------------- main
const args = process.argv.slice(2);
const which = args[0] ?? 'all';
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const layersDir = flag('--layers') ?? root + '.hawkes/layers';
const outDir = flag('--out');
const holesDir = flag('--holes');
const repaintDir = flag('--repaint');
const write = args.includes('--write');
const stagesPath = root + 'content/stages.json';
const stages = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));

for (const [id, plan] of Object.entries(PLANS)) {
  if (which !== 'all' && which !== id) continue;
  const st = stages.find((s) => s.id === id);
  const backLayer = st.layers.find((l) => l.id === 'backdrop');
  const { out, back } = await build(id, plan, { layersDir, holesDir, repaintDir, backdropPath: () => backLayer.image });
  const dir = outDir ? path.join(outDir, id) : `${root}stages/${id}/depth`;
  fs.mkdirSync(dir, { recursive: true });
  const worldH = backLayer.width * (H / W);
  const entries = [];
  let diff = 0;
  for (const { l, px, box } of out) {
    if (!box) {
      console.log(`${id}/${l.spec.id}: empty, skipped`);
      continue;
    }
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) Buffer.from(px.buffer, ((box.y0 + y) * W + box.x0) * 4, w * 4).copy(buf, y * w * 4);
    const file = `${dir}/${l.spec.id}.webp`;
    const opaque = l.spec.mask === 'opaque';
    await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
      .webp({ quality: opaque ? 78 : 84, alphaQuality: 92, effort: 5 })
      .toFile(file);
    const rel = `stages/${id}/depth/${l.spec.id}.webp`;
    const cx = backLayer.x + backLayer.width * ((box.x0 + w / 2) / W - 0.5);
    const cy = backLayer.y + worldH / 2 - ((box.y0 + h / 2) / H) * worldH;
    entries.push({
      id: l.spec.id,
      image: rel,
      x: Math.round(cx * 10) / 10,
      y: Math.round(cy * 10) / 10,
      width: Math.round(backLayer.width * (w / W) * 10) / 10,
      z: l.spec.z,
      high: true,
      note: `${l.spec.note} High only; ${plan.how ?? `cut from the backdrop by tools/depth-layers.mjs with Hawkes Gen image.layers (${plan.jobs})`}.`,
      aspect: Math.round((h / w) * 1000) / 1000,
    });
    console.log(`${id}/${l.spec.id}: ${w}x${h} z${l.spec.z} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
  // Rest check: the stack drawn over itself against the backdrop.
  {
    const acc = new Float32Array(N * 3);
    for (const { px } of out) {
      for (let i = 0; i < N; i++) {
        const a = px[i * 4 + 3] / 255;
        for (let ch = 0; ch < 3; ch++) acc[i * 3 + ch] = acc[i * 3 + ch] * (1 - a) + px[i * 4 + ch] * a;
      }
    }
    let se = 0;
    for (let i = 0; i < N * 3; i++) se += (acc[i] - back[i]) ** 2;
    diff = Math.sqrt(se / (N * 3));
    console.log(`${id}: the stack at rest differs from the backdrop by an RMS of ${diff.toFixed(2)} (0-255)`);
  }
  if (outDir) fs.writeFileSync(`${dir}/${id}.layers.json`, JSON.stringify({ entries, plan: { haze: plan.haze, remove: plan.remove ?? [] } }, null, 1)); // scratch: the preview reads it
  if (write) {
    for (const r of plan.remove ?? []) {
      const at = st.layers.findIndex((l) => l.id === r);
      if (at >= 0) st.layers.splice(at, 1);
    }
    // Far to near, right after the backdrop (the draw order is by z; the list order only breaks ties).
    let next = st.layers.findIndex((l) => l.id === 'backdrop') + 1;
    for (const e of entries) {
      const at = st.layers.findIndex((l) => l.id === e.id);
      if (at >= 0) st.layers[at] = e;
      else st.layers.splice(next++, 0, e);
    }
    backLayer.low = true;
    if (plan.haze) st.haze.z = plan.haze;
  }
}
if (write) fs.writeFileSync(stagesPath, JSON.stringify(stages, null, 2) + '\n');
