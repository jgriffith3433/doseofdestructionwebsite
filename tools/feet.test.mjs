// Feet on the floor (tools/fit-feet.mjs): every floor clip of every fighter has a per-frame foot offset,
// no idle frame floats or sinks more than 2 px after the renderer lift, and walk clips carry the stride
// the renderer plays them by. Run with `node tools/feet.test.mjs` (and in `npm test`).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFrame, walkStride, feetLift } from '../src/game/render/anims.ts';
import { CHARACTERS } from '../src/game/sim/characters.ts';
import { ACT } from '../src/game/sim/state.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed++;
}

/** After the renderer applies feetLift, an idle sole may sit at most this far off the floor (sheet px). */
const IDLE_GAP = 2;
/** Floor clips the renderer corrects (render/anims.ts FEET_CLIPS). */
const FLOOR = new Set(['idle', 'walk', 'run', 'crouch', 'jumpsquat', 'land', 'shield', 'dodge', 'roll', 'dizzy']);
const fighters = JSON.parse(readFileSync(join(ROOT, 'content', 'fighters.json'), 'utf8'));
check(fighters.length === 33, 'all 33 fighters are checked', String(fighters.length));

const tooFar = [];
const missing = [];
const badLength = [];
const badStride = [];
let clips = 0;
let idles = 0;
for (const fd of fighters) {
  const path = join(ROOT, 'characters', 'anim', fd.id, 'anims.json');
  if (!existsSync(path)) { missing.push(`${fd.id}: no anims.json`); continue; }
  const anims = JSON.parse(readFileSync(path, 'utf8'));
  const idle = anims.clips.idle;
  if (!idle?.feet) missing.push(`${fd.id}: idle has no feet`);
  else {
    idles++;
    const f = { action: ACT.IDLE, grounded: 1 };
    const pick = { key: 'idle', clip: idle, exact: true, refHeight: anims.refHeight };
    let worst = 0;
    for (let i = 0; i < idle.feet.length; i++) {
      const raw = idle.feet[i];
      worst = Math.max(worst, Math.abs(raw - feetLift(f, pick, i)));
    }
    if (worst > IDLE_GAP) tooFar.push(`${fd.id} ${worst}px`);
  }
  for (const [key, clip] of Object.entries(anims.clips)) {
    if (!FLOOR.has(key)) continue;
    clips++;
    if (!clip.feet) { missing.push(`${fd.id}/${key}`); continue; }
    if (clip.feet.length !== clip.frames) badLength.push(`${fd.id}/${key}`);
    if (clip.stride != null) {
      const ok = clip.travel && clip.travel.length === clip.frames && Math.abs(clip.travel.reduce((a, b) => a + b, 0) - clip.stride) < 1 && clip.stride > 0;
      if (!ok) badStride.push(`${fd.id}/${key}`);
    }
  }
}
check(idles === 33, 'every fighter has an idle with per-frame feet', String(idles));
check(tooFar.length === 0, `no idle frame floats or sinks more than ${IDLE_GAP} px after the fit`, tooFar.join(', '));
check(missing.length === 0, `every floor clip has a per-frame foot offset (${clips} clips)`, missing.slice(0, 5).join(', '));
check(badLength.length === 0, 'foot offsets have one entry per frame', badLength.join(', '));
check(badStride.length === 0, 'walk/run stride and travel agree', badStride.join(', '));

{
  const clip = { file: '', frames: 3, cols: 3, rows: 1, fw: 10, fh: 10, ax: 5, ay: 9, fps: 12, loop: true, feet: [3, -2, 80] };
  const f = { action: ACT.IDLE, grounded: 1 };
  const pick = { key: 'idle', clip, exact: true, refHeight: 300 };
  check(feetLift(f, pick, 0) === 3 && feetLift(f, pick, 1) === -2, 'a grounded idle frame is moved by its foot offset');
  check(feetLift(f, pick, 2) === 300 * 0.2, 'a wild offset is capped at 20% of height');
  check(feetLift({ ...f, grounded: 0 }, pick, 0) === 0, 'a fighter in the air is not moved');
  check(feetLift(f, { ...pick, key: 'jab' }, 0) === 0, 'an attack clip keeps its anchor');
}

{
  const char = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
  const anims = JSON.parse(readFileSync(join(ROOT, 'characters', 'anim', 'exit-punk', 'anims.json'), 'utf8'));
  const clip = anims.clips.walk;
  const ref = anims.refHeight;
  const stride = walkStride(char, clip, ref);
  check(!!clip.stride && stride > 0, 'a walk clip with a stride plays by its measured ground', String(stride));
  const w = { char, facing: 1, x: 0 };
  let worst = 0;
  let prev = walkFrame(w, clip, ref);
  const step = stride / 2000;
  const grounds = new Array(clip.frames).fill(0);
  for (let i = 0; i < 2000; i++) {
    w.x += step;
    const j = walkFrame(w, clip, ref);
    if (j === prev) grounds[j] += step;
    prev = j;
  }
  for (let i = 0; i < clip.frames; i++) {
    const want = (clip.travel[i] / clip.stride) * stride;
    worst = Math.max(worst, Math.abs(grounds[i] - want) / (stride / clip.stride));
  }
  check(worst < 3, 'each walk frame is on screen for the ground its planted foot covers (under 3 px of slide)', `${worst.toFixed(2)} px`);
  w.x = 777;
  const held = walkFrame(w, clip, ref);
  check(walkFrame(w, clip, ref) === held, 'standing still holds the stride');
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
