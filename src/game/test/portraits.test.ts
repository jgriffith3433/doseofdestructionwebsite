// Portraits (docs/art-bible.md "Portraits"): every fighter on the roster has a painted portrait at both sizes that the
// select, VS and results screens ask for (ui/dom.ts portraitUrl), the files are real WebP, square at the right size, and
// the screens ask for them by fighter id. Reads the committed files with git (a sparse checkout has no images on disk).
// Run: npm test.

import { execSync } from 'node:child_process';
import { CHARACTERS } from '../sim/characters.ts';
import { portraitUrl } from '../ui/dom.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const tracked = new Map<string, string>();
for (const line of execSync('git ls-files -s characters/portrait', { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  const [, sha, , file] = line.split(/\s+/);
  tracked.set(file, sha);
}

const problems: string[] = [];
for (const c of CHARACTERS) {
  for (const size of [256, 512] as const) {
    const url = portraitUrl(c.id, size);
    if (url !== `/characters/portrait/${c.id}-${size}.webp`) problems.push(`${c.name}: url ${url}`);
    const file = url.slice(1);
    const sha = tracked.get(file);
    if (!sha) {
      problems.push(`${c.name} (${c.id}): ${file} does not exist`);
      continue;
    }
    const b = execSync(`git cat-file -p ${sha}`, { maxBuffer: 1 << 26 });
    if (b.length < 2000 || b.subarray(0, 4).toString() !== 'RIFF' || b.subarray(8, 12).toString() !== 'WEBP') {
      problems.push(`${c.name}: ${file} is not a WebP image (${b.length} bytes)`);
      continue;
    }
    // Lossy WebP: width and height are 14 bits at bytes 26 and 28.
    const w = b.readUInt16LE(26) & 0x3fff;
    const h = b.readUInt16LE(28) & 0x3fff;
    if (b.subarray(12, 16).toString() === 'VP8 ' && (w !== size || h !== size)) problems.push(`${c.name}: ${file} is ${w}x${h}, want ${size}x${size}`);
  }
}
check(problems.length === 0, `all ${CHARACTERS.length} fighters have a real square portrait at 256 and 512 px${problems.length ? `: ${problems.join('; ')}` : ''}`);
const wanted = new Set(CHARACTERS.flatMap((c) => [256, 512].map((s) => `characters/portrait/${c.id}-${s}.webp`)));
const stray = [...tracked.keys()].filter((f) => !wanted.has(f));
check(stray.length === 0, `no portrait file without a fighter${stray.length ? `: ${stray.join(', ')}` : ''}`);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('portraits: all checks passed');
