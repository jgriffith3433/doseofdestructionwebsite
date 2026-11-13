// The select screen's special preview (ui/specialSim.ts): for every fighter and every special slot the scripted loop
// makes the real sim play that special within the 3 s loop, deterministically (same hash twice).

import { CHARACTERS } from '../sim/characters.ts';
import { hashState } from '../sim/state.ts';
import { NO_INPUT } from '../sim/input.ts';
import { step } from '../sim/step.ts';
import { LOOP_FRAMES, inputAt, runLoop, startLoop, type Slot } from '../ui/specialSim.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name} ${detail}`);
  }
};

const slots: Slot[] = ['neutral', 'side', 'up', 'down'];
let hits = 0;
for (let c = 0; c < CHARACTERS.length; c++) {
  for (const slot of slots) {
    const r = runLoop(c, slot);
    check(`${CHARACTERS[c].id} ${slot} comes out`, r.cameOut);
    if (slot === 'neutral' && r.hit) hits++;
  }
  const run = () => {
    const s = startLoop(c);
    for (let f = 0; f < LOOP_FRAMES; f++) step(s, [inputAt(c, 'neutral', f), NO_INPUT]);
    return hashState(s);
  };
  check(`${CHARACTERS[c].id} loop is deterministic`, run() === run());
}
check('most neutral specials reach the dummy', hits >= CHARACTERS.length * 0.45, `${hits}/${CHARACTERS.length}`);
console.log(`specialSim: ${CHARACTERS.length} fighters x 4 specials, ${hits} neutral hits, ${failed} failed`);
if (failed) throw new Error(`specialSim: ${failed} checks failed`);
