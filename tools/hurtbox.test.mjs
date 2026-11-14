// Every fighter's hurtbox (`w` x `h` in content/fighters.json) is within 15% of its idle art's opaque width and height,
// measured from the sheets by tools/hurtbox-art.mjs (fix with `node tools/hurtbox-art.mjs --write`). Run with `npm test`.
import { ffmpegOk, table, TOLERANCE } from './hurtbox-art.mjs';

if (!ffmpegOk()) { console.log('skip hurtbox test: ffmpeg is not installed'); process.exit(0); }
let failed = 0;
const rows = table();
for (const r of rows) {
  const ok = !r.flagged;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.id}: hurtbox ${r.w}x${r.h}, idle art ${r.art ? `${r.art.width.toFixed(0)}x${r.art.height.toFixed(0)}` : 'missing'}${ok ? '' : ` (off ${(r.dw * 100).toFixed(0)}% wide, ${(r.dh * 100).toFixed(0)}% tall; limit ${TOLERANCE * 100}%)`}`);
  if (!ok) failed++;
}
if (rows.length !== 33) { console.log(`FAIL all 33 fighters are checked (${rows.length})`); failed++; }
const sb = rows.find((r) => r.id === 'spider-bot');
if (sb && sb.w > 70) { console.log(`FAIL spider-bot hurtbox is ${sb.w} wide, over the roster's widest bodies`); failed++; }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('hurtbox: all fighters fit their art');
