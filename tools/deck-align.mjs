// Painted platform decks vs collision: for every stage layer that draws platforms (`platforms` + an image), finds the
// top of the painted deck (the first row, scanning down from 35 units above the platform, where 95% of the platform's
// columns are opaque) and compares it with the platform's y. A deck more than 2 units off is reported (exit 1);
// `--fix` slides each such layer so its widest deck lines up, then moves the collision of any other deck of the layer that is still over 1.5 units off (a few units, never the widest).
// Platforms whose top is not a flat painted deck (a dome, a curve; offset over 12 units) are listed, not used to fix.
// Needs `sharp` (not a dependency: `npm i --no-save sharp`); reads images from the working tree, else from git HEAD.
// usage: node tools/deck-align.mjs [stage-id] [--fix]
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const fix = args.includes('--fix');
const only = args.find((a) => !a.startsWith('--'));
let sharp;
try {
  sharp = createRequire(import.meta.url)('sharp');
} catch {
  console.log('deck-align: sharp is not installed (npm i --no-save sharp); skipped');
  process.exit(0);
}
const TOL = 2;
const path = root + 'content/stages.json';
const stages = JSON.parse(fs.readFileSync(path, 'utf8'));

function read(p) {
  if (fs.existsSync(root + p)) return fs.readFileSync(root + p);
  try {
    return execSync(`git -C ${root} show HEAD:${p}`, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

let bad = 0;
let changed = false;
for (const st of stages) {
  if (only && st.id !== only) continue;
  for (const l of st.layers ?? []) {
    if (!l.platforms?.length || !l.image || l.hidden || l.image.endsWith('.svg')) continue;
    const buf = read(l.image);
    if (!buf) continue;
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sc = l.width / info.width;
    const H = l.width * (info.height / info.width);
    const diffs = [];
    for (const pi of l.platforms) {
      const p = st.platforms[pi];
      const c0 = Math.max(0, Math.floor((p.x1 - (l.x - l.width / 2)) / sc));
      const c1 = Math.min(info.width - 1, Math.floor((p.x2 - (l.x - l.width / 2)) / sc));
      if (c1 <= c0) continue;
      const r0 = Math.max(0, Math.floor((l.y + H / 2 - (p.y + 35)) / sc));
      const r1 = Math.min(info.height - 1, Math.ceil((l.y + H / 2 - (p.y - 35)) / sc));
      let top = -1;
      for (let r = r0; r <= r1 && top < 0; r++) {
        let n = 0;
        for (let c = c0; c <= c1; c++) if (data[(r * info.width + c) * 4 + 3] > 128) n++;
        if (n / (c1 - c0 + 1) > 0.95) top = r;
      }
      if (top < 0) continue;
      diffs.push({ pi, d: l.y + H / 2 - top * sc - p.y });
    }
    const flat = diffs.filter((x) => Math.abs(x.d) < 12);
    for (const x of diffs) if (!flat.includes(x)) console.log(`  ${st.id}/${l.id} platform ${x.pi}: top ${x.d.toFixed(1)} off (not a flat deck, left alone)`);
    if (!flat.length) continue;
    // The widest deck is the one fighters spend the match on: it lines up exactly, the others get what is left.
    const widest = flat.reduce((a, b) => (st.platforms[b.pi].x2 - st.platforms[b.pi].x1 > st.platforms[a.pi].x2 - st.platforms[a.pi].x1 ? b : a));
    const dy = -Math.round(widest.d * 2) / 2;
    if (fix && Math.abs(dy) >= 0.5) {
      l.y = Math.round((l.y + dy) * 2) / 2;
      changed = true;
    }
    // A shared layer can't line up every deck: the others (never the widest) get their collision moved the last few units.
    if (fix) {
      for (const x of flat) {
        const left = x.d + dy;
        if (x !== widest && Math.abs(left) > TOL - 0.5) {
          st.platforms[x.pi].y += Math.round(left);
          x.d -= Math.round(left);
          changed = true;
        }
      }
    }
    const worst = Math.max(...flat.map((x) => Math.abs(x.d + (fix ? dy : 0))));
    const ok = worst <= TOL;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'OFF'} ${st.id}/${l.id}: offsets ${flat.map((x) => `p${x.pi} ${x.d.toFixed(1)}`).join(', ')}${fix ? ` -> moved ${dy} (worst now ${worst.toFixed(1)})` : ''}`);
  }
}
if (fix && changed) fs.writeFileSync(path, JSON.stringify(stages, null, 2) + '\n');
process.exit(bad && !fix ? 1 : 0);
