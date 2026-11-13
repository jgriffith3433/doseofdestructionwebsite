// Writes characters/portrait/<id>-256.webp from <id>-512.webp (ffmpeg), and prints a contact sheet path for a look.
//   node tools/bake-portraits.mjs [--sheet out.png]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'characters', 'portrait');
const ids = fs.readdirSync(dir).filter((f) => f.endsWith('-512.webp')).map((f) => f.replace('-512.webp', '')).sort();
for (const id of ids) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, `${id}-512.webp`), '-vf', 'scale=256:256:flags=lanczos', '-quality', '86', path.join(dir, `${id}-256.webp`)]);
}
console.log(`${ids.length} portraits: wrote the 256 px files`);
const si = process.argv.indexOf('--sheet');
if (si > 0) {
  const out = process.argv[si + 1];
  const cols = 7;
  const inputs = ids.flatMap((id) => ['-i', path.join(dir, `${id}-256.webp`)]);
  const layout = ids.map((_, i) => `${(i % cols) * 256}_${Math.floor(i / cols) * 256}`).join('|');
  const chain = ids.map((_, i) => `[${i}:v]`).join('') + `xstack=inputs=${ids.length}:layout=${layout}[o]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', chain, '-map', '[o]', out]);
  console.log('contact sheet', out);
}
