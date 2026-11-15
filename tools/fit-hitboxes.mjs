// Fits each fighter's smash and special hitboxes to the drawn limb or effect.
//
// For every fighter with its own `specials` in content/fighters.json it reads the clip sheets in
// characters/anim/<id>/ (anims.json gives frame size and the feet anchor), takes each fitted move
// (fsmash, usmash, dsmash, nspecial, sspecial, upb, dspecial), works out which sheet frames play during the
// move's active frames (the same mapping as render/anims.ts `clipFrame`), finds the furthest opaque pixels in the
// direction each hitbox points, and writes the offsets into the fighter's `hitboxes` in fighters.json.
// src/game/sim/fighterDefs.ts `applyHitboxFit` lays them over the authored boxes. A projectile's one entry is
// where the shot spawns (the hand). Counters and traps have nothing drawn to hit with and are skipped.
//
// A hitbox "misses" when no opaque pixel of the active frames lies inside its circle. After the fit there must
// be 0 misses; the tool exits 1 otherwise (or with --check, when anything in the file would change).
//
//   node tools/fit-hitboxes.mjs               # every fighter with specials: fit and write fighters.json
//   node tools/fit-hitboxes.mjs --only slice  # one fighter
//   node tools/fit-hitboxes.mjs --check       # write nothing; exit 1 on a miss or a stale fit
//   node tools/fit-hitboxes.mjs --verbose     # the per-move numbers
//
// Needs ffmpeg (with libwebp) on the PATH, like tools/heads.mjs. Sheets that are not in the working tree (a sparse
// checkout) are read from git.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOVE, MOVE_KEYS, fighter } from '../src/game/sim/fighterDefs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'content', 'fighters.json');
const ANIM = join(ROOT, 'characters', 'anim');
/** The art stands this much taller than the hurtbox (render/renderer.ts ART_SCALE). */
const ART_SCALE = 1.18;
const ALPHA = 96;
const FITTED = ['fsmash', 'usmash', 'dsmash', 'nspecial', 'sspecial', 'upb', 'dspecial'];
/** A box overlaps the drawing when this many opaque pixels lie inside its circle. */
const MIN_PIXELS = 12;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const check = args.includes('--check');
const verbose = args.includes('--verbose');

const tmp = mkdtempSync(join(tmpdir(), 'fit-hitboxes-'));

/** The sheet as RGBA, from the working tree or (sparse checkout) from git. */
function readSheet(id, file, width, height) {
  let path = join(ANIM, id, file);
  if (!existsSync(path)) {
    path = join(tmp, `${id}-${file}`);
    writeFileSync(path, execFileSync('git', ['show', `HEAD:characters/anim/${id}/${file}`], { cwd: ROOT, maxBuffer: 1 << 28 }));
  }
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  if (raw.length !== width * height * 4) throw new Error(`${id}/${file}: sheet is ${raw.length / 4} px, anims.json says ${width}x${height}`);
  return raw;
}

/** The sheet frame shown on move frame t (render/anims.ts clipFrame, for an attack). */
function clipFrame(move, clip, exact, t) {
  const n = clip.frames;
  if (exact) {
    const strike = clip.hit;
    const active = move.hits.length ? Math.min(...move.hits.map((w) => w.start)) : 0;
    if (strike != null && strike > 0 && active > 0 && active < move.total) {
      const i = t < active ? (t / active) * strike : strike + ((t - active) / (move.total - active)) * (n - 1 - strike);
      return Math.max(0, Math.min(n - 1, Math.round(i)));
    }
    return Math.min(n - 1, Math.floor((t / move.total) * n));
  }
  const i = Math.floor((t * clip.fps) / 60);
  return clip.loop ? i % n : Math.min(n - 1, i);
}

/** Opaque pixels of one sheet frame as world offsets from the feet: [x forward, y up]. */
function framePixels(sheet, sheetW, clip, frame, unit) {
  const col = frame % clip.cols;
  const row = Math.floor(frame / clip.cols);
  const out = [];
  for (let y = 0; y < clip.fh; y++) {
    let o = ((row * clip.fh + y) * sheetW + col * clip.fw) * 4 + 3;
    for (let x = 0; x < clip.fw; x++, o += 4) {
      if (sheet[o] >= ALPHA) out.push([(x - clip.ax) * unit, (clip.ay - y) * unit]);
    }
  }
  return out;
}

const inside = (pts, cx, cy, r) => {
  let n = 0;
  for (const [x, y] of pts) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) n++;
  return n;
};

/** Furthest opaque pixels along `d` from the body's middle: the mean of the outermost 0.5%. */
function tipAlong(pts, mid, d) {
  const proj = pts.map(([x, y]) => (x - mid[0]) * d[0] + (y - mid[1]) * d[1]);
  const sorted = [...proj].sort((a, b) => a - b);
  const cut = sorted[Math.max(0, Math.floor(sorted.length * 0.995) - 1)];
  let sx = 0;
  let sy = 0;
  let n = 0;
  pts.forEach(([x, y], i) => {
    if (proj[i] >= cut) { sx += x; sy += y; n++; }
  });
  return n ? [sx / n, sy / n] : null;
}

const all = JSON.parse(readFileSync(DATA, 'utf8'));
const report = [];
let misses = 0;
let moved = 0;
const fits = new Map();

for (const entry of all) {
  if (!entry.specials || (only && entry.id !== only)) continue;
  const animPath = join(ANIM, entry.id, 'anims.json');
  if (!existsSync(animPath)) {
    console.error(`${entry.id}: no anims.json, skipped`);
    continue;
  }
  const anims = JSON.parse(readFileSync(animPath, 'utf8'));
  const { hitboxes: _old, ...spec } = entry;
  const ch = fighter(entry.id, entry.name, entry.role, entry.blurb, spec);
  const unit = (entry.h * ART_SCALE) / anims.refHeight;
  const mid = [0, entry.h / 2];
  const sheets = new Map();
  const fit = {};

  for (const key of FITTED) {
    const mi = MOVE_KEYS.indexOf(key);
    const move = ch.moves[mi];
    if (move.kind === 'counter' || move.kind === 'trap') continue;
    const exact = !!anims.clips[key];
    const clipKey = exact ? key : (move.clips ?? []).find((k) => anims.clips[k]);
    const clip = clipKey && anims.clips[clipKey];
    if (!clip) {
      console.error(`${entry.id} ${key}: no clip (${(move.clips ?? []).join(', ')}) to fit`);
      misses++;
      continue;
    }
    // The boxes to place, and the move frames they are live on.
    const boxes = move.hits.flatMap((w) => w.boxes.map((b) => ({ box: b, from: w.start, to: w.end })));
    if (move.shot && !boxes.length) boxes.push({ box: { x: move.shot.x, y: move.shot.y, r: move.shot.r }, from: move.shot.frame, to: move.shot.frame });
    if (!boxes.length) continue;
    if (!sheets.has(clipKey)) sheets.set(clipKey, readSheet(entry.id, clip.file, clip.cols * clip.fw, clip.rows * clip.fh));
    const sheet = sheets.get(clipKey);
    const cache = new Map();
    const pixels = (frame) => {
      if (!cache.has(frame)) cache.set(frame, framePixels(sheet, clip.cols * clip.fw, clip, frame, unit));
      return cache.get(frame);
    };

    const placed = boxes.map(({ box, from, to }) => {
      const frames = new Set();
      for (let t = from; t <= to; t++) frames.add(clipFrame(move, clip, exact, t));
      const pts = [...frames].flatMap(pixels);
      const dx = box.x - mid[0];
      const dy = box.y - mid[1];
      const len = Math.hypot(dx, dy) || 1;
      const d = [dx / len, dy / len];
      const before = inside(pts, box.x, box.y, box.r);
      let x = box.x;
      let y = box.y;
      if (before < MIN_PIXELS * 4) {
        // Not on the drawing yet: sit the circle on the furthest part of it, its edge a little past the tip.
        const tip = tipAlong(pts, mid, d);
        if (tip) {
          x = tip[0] - d[0] * box.r * 0.4;
          y = Math.max(0, tip[1] - d[1] * box.r * 0.4);
        }
      }
      x = Math.round(x);
      y = Math.round(y);
      const after = inside(pts, x, y, box.r);
      const miss = after < MIN_PIXELS;
      if (miss) misses++;
      if (x !== box.x || y !== box.y) moved++;
      if (verbose || miss) console.log(`${entry.id} ${key} (clip ${clipKey}${exact ? '' : ', stand-in'}): box (${box.x},${box.y}) r${box.r} -> (${x},${y}), ${before} -> ${after} px${miss ? '  MISS' : ''}`);
      return { x, y };
    });
    fit[key] = placed;
    report.push(`${entry.id} ${key}`);
  }
  fits.set(entry.id, fit);
}

// Writes the file the way it is kept: every key on its own line, each specials / hitboxes entry on one line.
function serialize(list) {
  const flat = (v) =>
    Array.isArray(v) ? `[${v.map(flat).join(', ')}]`
    : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`).join(', ')} }`
    : JSON.stringify(v);
  const blocks = list.map((f) => {
    const lines = Object.entries(f).map(([k, v]) => {
      if (k === 'specials' || k === 'hitboxes') {
        const inner = Object.entries(v).map(([n, o]) => `      ${JSON.stringify(n)}: ${flat(o)}`);
        return `    ${JSON.stringify(k)}: {\n${inner.join(',\n')}\n    }`;
      }
      return `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
    });
    return `  {\n${lines.join(',\n')}\n  }`;
  });
  return `[\n${blocks.join(',\n')}\n]\n`;
}

const next = all.map((f) => {
  const fit = fits.get(f.id);
  if (!fit) return f;
  const { hitboxes: _h, ...rest } = f;
  return Object.keys(fit).length ? { ...rest, hitboxes: fit } : rest;
});
const text = serialize(next);
const stale = text !== readFileSync(DATA, 'utf8');

console.log(`fit-hitboxes: ${fits.size} fighters, ${report.length} moves fitted, ${moved} hitboxes moved, ${misses} misses`);
if (check) {
  if (stale) console.log('fighters.json is out of date: run node tools/fit-hitboxes.mjs');
  process.exit(misses || stale ? 1 : 0);
}
if (stale) writeFileSync(DATA, text);
process.exit(misses ? 1 : 0);
