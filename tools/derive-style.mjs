// Derives each fighter's art-bible style (content/fighters.json `style`, docs/art-bible.md) from its idle clip sheet:
// measures saturation and value, solves the per-fighter remap that lands it inside the bible's ranges, simulates the
// remap on the same pixels to measure what the fighter looks like after it, and picks the outline colour (the main hue,
// darkened). Prints the style report; exits 1 when any fighter is outside the ranges.
// Usage: node tools/derive-style.mjs [--write]   (needs ffmpeg and git; the sprite sheets are read from HEAD)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ART, solveRemap, remapSV, outlineColor, outsideRanges, toHsv } from '../src/game/artStyle.ts';

const file = 'content/fighters.json';
const fighters = JSON.parse(readFileSync(file, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'style-'));
const q = (a, p) => a[Math.floor((a.length - 1) * p)];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function stats(px, m) {
  const vs = [], ss = [];
  for (const [s, v] of px) {
    const [ns, nv] = m ? remapSV(s, v, m) : [s, v];
    vs.push(nv);
    if (v > 0.15 && s > 0.12) ss.push(ns); // the coloured set is picked on the original pixels, so the gain is linear
  }
  vs.sort((a, b) => a - b);
  const r = (x) => Math.round(x * 1000) / 1000;
  return { sMean: r(mean(ss)), vP5: r(q(vs, 0.05)), vP95: r(q(vs, 0.95)), vMean: r(mean(vs)) };
}

const rows = [];
for (const f of fighters) {
  writeFileSync(join(dir, 'in.webp'), execFileSync('git', ['show', `HEAD:characters/anim/${f.id}/idle.webp`], { maxBuffer: 1 << 28 }));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'in.webp'), '-vf', 'scale=160:-1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 29 });
  const px = [], hist = new Array(36).fill(0);
  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i + 3] < 200) continue;
    const [h, s, v] = toHsv(raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255);
    px.push([s, v]);
    // Main hue: skin and tan (10-52 deg) only count when they are vivid, so the outfit decides.
    if (s > 0.2 && v > 0.15 && !(h >= 10 && h < 52 && s < 0.72)) hist[Math.floor(h / 10) % 36] += s * v;
  }
  if (hist.every((x) => x === 0)) for (let i = 0; i < raw.length; i += 4) { if (raw[i + 3] < 200) continue; const [h, s, v] = toHsv(raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255); if (s > 0.1) hist[Math.floor(h / 10) % 36] += s * v; }
  let bi = 0, best = 0;
  for (let i = 0; i < 36; i++) { const v = hist[i] + 0.5 * (hist[(i + 35) % 36] + hist[(i + 1) % 36]); if (v > best) { best = v; bi = i; } }
  const hue = bi * 10 + 5;
  const before = stats(px);
  let remap = solveRemap(before);
  const round = (m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, Math.round(x * 1000) / 1000]));
  remap = round(remap);
  const after = stats(px, remap);
  f.style = { outline: outlineColor(hue, after.sMean), hue, remap, before, after };
  rows.push({ id: f.id, before, after, out: outsideRanges(after), outline: f.style.outline });
}

const f2 = (x) => x.toFixed(2);
console.log('fighter'.padEnd(26), 'sMean    vP5      vP95     vMean    outline   (before -> after)');
for (const r of rows) {
  const c = (k) => `${f2(r.before[k])}>${f2(r.after[k])}`.padEnd(9);
  console.log(r.id.padEnd(26), c('sMean'), c('vP5'), c('vP95'), c('vMean'), r.outline, r.out.length ? '  OUTSIDE: ' + r.out.join('; ') : '');
}
const bad = rows.filter((r) => r.out.length);
const wasBad = rows.filter((r) => outsideRanges(r.before).length).length;
console.log(`\nRanges: sMean ${ART.ranges.sMean}, vP5 ${ART.ranges.vP5}, vP95 ${ART.ranges.vP95}, vMean ${ART.ranges.vMean}`);
console.log(`Before the remap ${wasBad} of ${rows.length} fighters were outside the ranges; after it ${bad.length} of ${rows.length} are.`);

if (process.argv.includes('--write')) {
  // Insert (or replace) each fighter's `style` as one compact line after its "blurb" line, so the file's layout stays as authored.
  let text = readFileSync(file, 'utf8').replace(/^    "style": .*\n/gm, '');
  for (const f of fighters) {
    const at = text.indexOf(`"id": "${f.id}"`);
    const dmg = text.indexOf('\n    "blurb":', at);
    const end = text.indexOf('\n', dmg + 1);
    text = text.slice(0, end) + `\n    "style": ${JSON.stringify(f.style)},` + text.slice(end);
  }
  writeFileSync(file, text);
  console.log('wrote content/fighters.json');
}
process.exit(bad.length ? 1 : 0);
