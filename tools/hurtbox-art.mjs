// Measures each fighter's idle art and compares it with its hurtbox (content/fighters.json `w` x `h`).
//
// The opaque bounds (alpha >= 20%) of every idle frame are measured from the sheet in characters/anim/<id>/ and the
// median frame is taken (a breath or a sway doesn't decide it). A sheet pixel is `h * ART_SCALE / refHeight` world units
// (render/renderer.ts: the art is drawn ART_SCALE taller than the hurtbox, standing on the same feet), so:
//   width   the hurtbox is as wide as the art a player sees (a hit that touches the art lands),
//   height  the art stands ART_SCALE taller than the box by design (the sprite's head room), so the box is compared
//           with the art's height / ART_SCALE: the height stays what it is, because it also scales every move.
// A fighter more than TOLERANCE off either is flagged.
//
//   node tools/hurtbox-art.mjs            # the table; exit 1 while a fighter is flagged
//   node tools/hurtbox-art.mjs --write    # fit the flagged fighters' width (and height) in content/fighters.json
//
// Needs ffmpeg (with libwebp). Sheets not in the working tree (sparse checkout) are read from git HEAD.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ART_SCALE = 1.18;
export const TOLERANCE = 0.15;
const ALPHA = 51;
const DATA = join(ROOT, 'content', 'fighters.json');
const tmp = mkdtempSync(join(tmpdir(), 'hurtbox-'));

export function ffmpegOk() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** The idle art's opaque width and height in world units at the fighter's current height (null: no sheet). */
export function measureIdle(id, h) {
  const man = join(ROOT, 'characters', 'anim', id, 'anims.json');
  if (!existsSync(man)) return null;
  const m = JSON.parse(readFileSync(man, 'utf8'));
  const c = m.clips.idle;
  let path = join(ROOT, 'characters', 'anim', id, c.file);
  if (!existsSync(path)) {
    path = join(tmp, `${id}.webp`);
    writeFileSync(path, execFileSync('git', ['show', `HEAD:characters/anim/${id}/${c.file}`], { cwd: ROOT, maxBuffer: 1 << 28 }));
  }
  const sw = c.fw * c.cols;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  const ws = [], hs = [];
  for (let fr = 0; fr < c.frames; fr++) {
    const x0 = (fr % c.cols) * c.fw, y0 = Math.floor(fr / c.cols) * c.fh;
    let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    for (let y = 0; y < c.fh; y++) {
      let o = ((y0 + y) * sw + x0) * 4 + 3;
      for (let x = 0; x < c.fw; x++, o += 4) if (raw[o] >= ALPHA) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    }
    if (maxx >= 0) { ws.push(maxx - minx + 1); hs.push(maxy - miny + 1); }
  }
  const k = (h * ART_SCALE) / m.refHeight;
  return { width: median(ws) * k, height: (median(hs) * k) / ART_SCALE };
}

/** One row per fighter: the box, the art, how far off each is (fraction of the art), and whether it is flagged. */
export function table() {
  return JSON.parse(readFileSync(DATA, 'utf8')).map((f) => {
    const art = measureIdle(f.id, f.h);
    const off = (box, a) => (box - a) / a;
    const dw = art ? off(f.w, art.width) : NaN;
    const dh = art ? off(f.h, art.height) : NaN;
    return { id: f.id, w: f.w, h: f.h, art, dw, dh, flagged: !art || Math.abs(dw) > TOLERANCE || Math.abs(dh) > TOLERANCE };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = table();
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`.padStart(5);
  for (const r of rows) console.log(r.id.padEnd(26), `box ${r.w}x${r.h}`.padEnd(12), `art ${r.art.width.toFixed(0)}x${r.art.height.toFixed(0)}`.padEnd(12), 'w', pct(r.dw), 'h', pct(r.dh), r.flagged ? ' FLAGGED' : '');
  const bad = rows.filter((r) => r.flagged);
  console.log(`\n${bad.length} of ${rows.length} fighters are more than ${TOLERANCE * 100}% off their art.`);
  if (process.argv.includes('--write')) {
    let text = readFileSync(DATA, 'utf8');
    for (const r of bad) {
      const at = text.indexOf(`"id": "${r.id}"`);
      const set = (key, v) => { text = text.slice(0, at) + text.slice(at).replace(new RegExp(`("${key}": )\\d+`), `$1${Math.round(v)}`); };
      if (Math.abs(r.dw) > TOLERANCE) set('w', r.art.width);
      if (Math.abs(r.dh) > TOLERANCE) set('h', r.art.height);
    }
    writeFileSync(DATA, text);
    console.log(`fitted ${bad.length} fighters in content/fighters.json`);
  } else process.exit(bad.length ? 1 : 0);
}
