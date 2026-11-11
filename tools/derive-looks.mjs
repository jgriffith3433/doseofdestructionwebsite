// Derives each fighter's colour looks (content/fighters.json `looks`) from its idle clip sheet:
// finds the main outfit hue (skin tones 10-50 deg excluded unless nothing else is there), then writes four looks.
// Usage: node tools/derive-looks.mjs [--write]   (needs ffmpeg and git; the sprite sheets are read from HEAD)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = 'content/fighters.json';
const fighters = JSON.parse(readFileSync(file, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'looks-'));
const skin = (h) => h >= 10 && h < 52;

for (const f of fighters) {
  const blob = execFileSync('git', ['show', `HEAD:characters/anim/${f.id}/idle.webp`], { maxBuffer: 1 << 28 });
  writeFileSync(join(dir, 'in.webp'), blob);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'in.webp'), '-vf', 'scale=160:-1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  const hist = new Array(36).fill(0);
  let n = 0, coloured = 0, vivid = 0, nonSkin = 0;
  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i + 3] < 200) continue;
    n++;
    const r = raw[i] / 255, g = raw[i + 1] / 255, b = raw[i + 2] / 255;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b), s = mx ? d / mx : 0;
    if (s < 0.3 || mx < 0.2) continue;
    let h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    coloured++;
    if (skin(h) && s < 0.72) continue; // skin and tan: keep
    nonSkin++;
    hist[Math.floor(h / 10) % 36] += s * mx;
    if (s > 0.6) vivid++;
  }
  let best = 0, bi = 0;
  for (let i = 0; i < 36; i++) {
    const v = hist[i] + 0.5 * (hist[(i + 35) % 36] + hist[(i + 1) % 36]);
    if (v > best) { best = v; bi = i; }
  }
  const share = nonSkin / n;
  const hue = bi * 10 + 5;
  let looks;
  if (share >= 0.07) {
    // Outfit mode: turn the main hue band.
    const m = { from: hue, range: 42 };
    looks = [
      { name: 'Classic' },
      { name: 'Flip', ...m, hue: 150, sat: 1.05, val: 1 },
      { name: 'Neon', ...m, hue: 70, sat: 1.15, val: 1.12, wins: 3 },
      { name: 'Midnight', ...m, hue: -80, sat: 0.95, val: 0.78, wins: 10 },
    ];
  } else {
    // Mostly dark or grey: tint the neutral mid-tones (from -1), keeping blacks, whites and skin.
    looks = [
      { name: 'Classic' },
      { name: 'Ice', from: -1, hue: 195, sat: 0.55, val: 1.15 },
      { name: 'Ember', from: -1, hue: 12, sat: 0.7, val: 1.1, wins: 3 },
      { name: 'Venom', from: -1, hue: 105, sat: 0.65, val: 1.05, wins: 10 },
    ];
  }
  f.looks = looks.map((l) => (l.wins ? l : { ...l, wins: 0 }));
  console.log(f.id.padEnd(26), `peak ${String(hue).padStart(3)} share ${share.toFixed(2)} ->`, share >= 0.07 ? 'outfit' : 'neutral');
}
if (process.argv.includes('--write')) {
  // Insert (or replace) each fighter's `looks` as compact lines after its "blurb" line, so the file's layout stays as authored.
  let text = readFileSync(file, 'utf8').replace(/^    "looks": \[\n(?:      .*\n)*?    \],\n/gm, '');
  for (const f of fighters) {
    const at = text.indexOf(`"id": "${f.id}"`);
    const dmg = text.indexOf('\n    "blurb":', at);
    const end = text.indexOf('\n', dmg + 1);
    const block = `\n    "looks": [\n${f.looks.map((l) => `      ${JSON.stringify(l)}`).join(',\n')}\n    ],`;
    text = text.slice(0, end) + block + text.slice(end);
  }
  writeFileSync(file, text);
}
