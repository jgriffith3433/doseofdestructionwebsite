// Fits each fighter's feet to the floor, frame by frame.
//
// For every frame of every clip of every fighter in content/fighters.json it reads the sheet in
// characters/anim/<id>/ (anims.json has the frame size and the feet anchor), finds the lowest opaque row
// (alpha >= 20%: shadows, glow and dust below that are ignored, and a row needs MIN_ROW_PIXELS opaque pixels so
// one stray speck is not a sole), and writes into the clip's manifest entry:
//
//   feet   per frame: how far below the anchor row the sole is, in sheet pixels (positive: the frame sinks, the
//          renderer lifts it; negative: it floats, the renderer lowers it). render/anims.ts `feetLift` applies it
//          to grounded clips so soles meet the platform surface.
//
// Walk and run clips also get the measured stride, so the renderer plays them by ground covered and the planted
// foot does not slide:
//
//   stride    sheet pixels the planted foot travels backward over one cycle (the sum of its travel while it is
//             the foot on the ground, from tracking each contact between frames).
//   travel    per frame, the sheet pixels the planted foot moves backward in that frame; the renderer plays the cycle
//             by cumulative ground over it (a stance's foot is faster at the start than the end).
//   slip      the worst a foot on the floor drifts in one frame when the clip plays by `travel`, in sheet pixels (the check for "less than 3 px per step").
//
// `walkStride` in render/anims.ts turns the stride into ground covered in sim units with the fighter's art scale,
// so the playback rate comes from the ground speed in fighters.json. A walk with no clean contact keeps the old
// formula (its walk speed at the clip's frame rate) and is listed as "stride: kept".
//
//   node tools/fit-feet.mjs               # every fighter: measure and write the clip manifests
//   node tools/fit-feet.mjs --only break  # one fighter
//   node tools/fit-feet.mjs --check       # write nothing; exit 1 when a manifest is stale or an idle sits off the floor
//   node tools/fit-feet.mjs --verbose     # the per-clip numbers
//
// Needs ffmpeg (with libwebp) on the PATH. Sheets that are not in the working tree (a sparse checkout) are read
// from git (HEAD:characters/anim/..., lesson m_cd7520fb5b38).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'content', 'fighters.json');
const ANIM = join(ROOT, 'characters', 'anim');
/** Below 20% alpha is shadow or effect, not a sole. */
const ALPHA = 51;
const MIN_ROW_PIXELS = 3;
/** Contacts: columns whose lowest opaque pixel is within this many rows of the frame's lowest. */
const CONTACT_ROWS = 3;
/** Walk-like clips (the ones played by ground covered). */
const STRIDE_CLIPS = ['walk', 'run'];
/** The fighter's walk speed over the clip's measured contact speed is the playback rate; outside this it is not trusted. */
/** Accept measured contact speed when full-walk sheet speed / contact speed is in this band (ball-person sits near 11). */
const RATE = [0.4, 12];

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const check = args.includes('--check');
const verbose = args.includes('--verbose');
const tmp = mkdtempSync(join(tmpdir(), 'fit-feet-'));

/** The sheet's alpha plane, from the working tree or (sparse checkout) from git. */
function readAlpha(id, file, width, height) {
  let path = join(ANIM, id, file);
  if (!existsSync(path)) {
    path = join(tmp, `${id}-${file}`);
    writeFileSync(path, execFileSync('git', ['show', `HEAD:characters/anim/${id}/${file}`], { cwd: ROOT, maxBuffer: 1 << 28 }));
  }
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  if (raw.length !== width * height * 4) return null;
  const a = new Uint8Array(width * height);
  for (let i = 0; i < a.length; i++) a[i] = raw[i * 4 + 3];
  return a;
}

/** One frame's feet: the lowest solid row and the contact segments (x centres) on it. */
function frameFeet(alpha, sheetW, clip, frame) {
  const col = frame % clip.cols;
  const row = Math.floor(frame / clip.cols);
  const x0 = col * clip.fw;
  const y0 = row * clip.fh;
  // Lowest opaque pixel of each column, and the count per row.
  const lowest = new Array(clip.fw).fill(-1);
  const perRow = new Array(clip.fh).fill(0);
  for (let y = 0; y < clip.fh; y++) {
    let o = (y0 + y) * sheetW + x0;
    for (let x = 0; x < clip.fw; x++, o++) {
      if (alpha[o] >= ALPHA) {
        lowest[x] = y;
        perRow[y]++;
      }
    }
  }
  let low = -1;
  for (let y = clip.fh - 1; y >= 0; y--) if (perRow[y] >= MIN_ROW_PIXELS) { low = y; break; }
  if (low < 0) return { low: -1, contacts: [] };
  const contacts = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x <= clip.fw; x++) {
    const on = x < clip.fw && lowest[x] >= low - CONTACT_ROWS;
    if (on) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0 && ++gap > 3) {
      const end = x - gap;
      if (end - start >= 2) contacts.push((start + end) / 2);
      start = -1;
      gap = 0;
    }
  }
  return { low, contacts };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * The planted foot's travel per frame: each contact in a frame is matched to the nearest contact in the next
 * (cycling round); a contact that stays on the ground moves backward at the body's speed. Returns the per-frame
 * backward speeds of the matched contacts, in sheet pixels.
 */
function contactSpeeds(frames, clip) {
  const out = [];
  const max = clip.fw * 0.3;
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i].contacts;
    const b = frames[(i + 1) % frames.length].contacts;
    for (const x of a) {
      let best = null;
      for (const y of b) if (best == null || Math.abs(y - x) < Math.abs(best - x)) best = y;
      if (best != null && Math.abs(best - x) <= max) out.push({ frame: i, back: x - best });
    }
  }
  return out;
}

/**
 * Puts each clip's feet, stride and slip into the manifest text, replacing the ones already there, and leaves
 * everything else (key order, 1.0, the one-space indent) exactly as it was.
 */
function inject(raw, anims) {
  let text = raw.replace(/,\n\s*"(feet|stride|slip|travel)": (\[[^\]]*\]|[-\d.]+)(?=,?\n)/g, '');
  for (const [key, clip] of Object.entries(anims.clips)) {
    const head = text.indexOf(`\n  "${key}": {`);
    if (head < 0) throw new Error(`clip ${key} not found in manifest text`);
    const close = text.indexOf('\n  }', head);
    if (!clip.feet) continue;
    let add = `,\n   "feet": [${clip.feet.join(', ')}]`;
    if (clip.stride != null) add += `,\n   "stride": ${clip.stride},\n   "slip": ${clip.slip},\n   "travel": [${clip.travel.join(', ')}]`;
    text = text.slice(0, close) + add + text.slice(close);
  }
  JSON.parse(text);
  return text;
}

const all = JSON.parse(readFileSync(DATA, 'utf8'));
let stale = 0;
let idleOff = 0;
const lines = [];

for (const entry of all) {
  if (only && entry.id !== only) continue;
  const animPath = join(ANIM, entry.id, 'anims.json');
  if (!existsSync(animPath)) {
    console.error(`${entry.id}: no anims.json, skipped`);
    continue;
  }
  const raw = readFileSync(animPath, 'utf8');
  const anims = JSON.parse(raw);
  const unit = (entry.h * 1.18) / anims.refHeight; // world units per sheet pixel (render/renderer.ts ART_SCALE)
  const worst = { clip: '', gap: 0 };
  const notes = [];

  for (const [key, clip] of Object.entries(anims.clips)) {
    const sheetW = clip.cols * clip.fw;
    const alpha = readAlpha(entry.id, clip.file, sheetW, clip.rows * clip.fh);
    if (!alpha) {
      // The manifest and the sheet disagree on size: no foot data for this clip (the renderer takes 0).
      delete clip.feet; delete clip.stride; delete clip.travel; delete clip.slip;
      notes.push(`${key}: sheet size differs from anims.json, skipped`);
      continue;
    }
    const frames = [];
    const dbg = process.env.DBG === key;
    for (let i = 0; i < clip.frames; i++) frames.push(frameFeet(alpha, sheetW, clip, i));
    if (dbg) frames.forEach((f, i) => console.log(i, f.low, f.contacts.map((c) => c.toFixed(0)).join(" ")));
    clip.feet = frames.map((f) => (f.low < 0 ? 0 : f.low - clip.ay));
    if (key === 'idle') {
      const g = Math.max(...clip.feet.map(Math.abs));
      if (g > worst.gap) { worst.gap = g; worst.clip = key; }
    }

    delete clip.stride;
    delete clip.travel;
    delete clip.slip;
    if (STRIDE_CLIPS.includes(key)) {
      const speeds = contactSpeeds(frames, clip);
      const v = median(speeds.map((s) => s.back));
      const nominal = (entry.walk / unit) * (60 / clip.fps); // sheet px per frame the fighter covers at full walk
      if (v > 0 && nominal / v >= RATE[0] && nominal / v <= RATE[1] && speeds.length >= clip.frames * 0.4) {
        // The ground each frame covers: the planted foot's backward travel in that frame (the fastest contact
        // in it, the planted foot; the slower ones are a heel or toe turning over; frames with none take their neighbours', and no frame stalls or races). The renderer plays the
        // cycle by cumulative ground, so a foot that moves fast early in its stance is shown moving fast.
        const byFrame = Array.from({ length: clip.frames }, () => []);
        for (const sp of speeds) byFrame[sp.frame].push(sp.back);
        let travel = byFrame.map((l) => (l.length ? Math.max(...l) : null));
        travel = travel.map((t, i) => {
          if (t != null) return t;
          let l = i, r = i;
          while (travel[(l + clip.frames - 1) % clip.frames] == null && l > i - clip.frames) l--;
          while (travel[(r + 1) % clip.frames] == null && r < i + clip.frames) r++;
          const a = travel[(l + clip.frames - 1) % clip.frames] ?? v;
          const b = travel[(r + 1) % clip.frames] ?? v;
          return (a + b) / 2;
        });
        travel = travel.map((t) => Math.min(v * 2.5, Math.max(v * 0.3, t)));
        // Drift: how far a contact wanders from the floor over one stance when the cycle plays by that ground.
        let slip = 0;
        for (const sp of speeds) if (sp.back >= travel[sp.frame] * 0.5) slip = Math.max(slip, Math.abs(sp.back - travel[sp.frame]));
        clip.travel = travel.map((t) => Math.round(t * 100) / 100);
        clip.stride = Math.round(travel.reduce((x, y) => x + y, 0) * 100) / 100;
        clip.slip = Math.round(slip * 100) / 100;
        notes.push(`${key} stride ${clip.stride}px, plays x${(nominal * clip.frames / clip.stride).toFixed(2)} at full walk, slip ${clip.slip}px`);
      } else {
        notes.push(`${key} stride: kept (measured ${v.toFixed(2)} px/frame, nominal ${nominal.toFixed(2)}, ${speeds.length} contacts)`);
      }
    }
    if (verbose) lines.push(`  ${entry.id} ${key}: feet ${Math.min(...clip.feet)}..${Math.max(...clip.feet)}`);
  }

  const out = inject(raw, anims);
  if (out !== raw) {
    stale++;
    if (!check) writeFileSync(animPath, out);
  }
  if (worst.gap > 2) idleOff++;
  lines.push(`${entry.id}: idle worst gap ${worst.gap}px${notes.length ? '; ' + notes.join('; ') : ''}`);
}
console.log(lines.join('\n'));
if (check && stale) {
  console.error(`${stale} fighter(s) have stale foot data: run node tools/fit-feet.mjs`);
  process.exit(1);
}
