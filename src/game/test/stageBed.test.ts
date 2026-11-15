declare const process: { exit(code: number): never };
// Stage bed recipes and the intense trigger (last stock or ≥100%).
import { INTENSE_PERCENT, fightersNeedIntense, stageBedGaps, stageBedRecipe } from '../stageBed.ts';
import { BED_KINDS } from '../synth.ts';
import { STAGES } from '../sim/stage.ts';

let failed = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
};

for (const st of STAGES) {
  const bed = stageBedRecipe(st.id);
  check(!!bed.music, `${st.id}: has a music id`);
  check(BED_KINDS.includes(bed.bed), `${st.id}: bed kind ${bed.bed}`);
  check(!!bed.ambience, `${st.id}: reuses an ambience file (gap only if missing)`);
  check(bed.ambienceVolume > 0 && bed.ambienceVolume < 0.5, `${st.id}: ambience volume under the theme`);
  check(!!bed.intense, `${st.id}: has an intensity stem reuse`);
}

check(stageBedGaps().length >= 1, 'gaps lists the missing dedicated ambience loops');

check(!fightersNeedIntense([{ stocks: 2, percent: 0 }, { stocks: 2, percent: 500 }]), 'calm when both have stocks and under 100%');
check(fightersNeedIntense([{ stocks: 1, percent: 0 }, { stocks: 2, percent: 0 }]), 'intense on last stock');
check(fightersNeedIntense([{ stocks: 3, percent: INTENSE_PERCENT }, { stocks: 2, percent: 0 }]), 'intense at 100%');
check(!fightersNeedIntense([{ stocks: 0, percent: 2000 }, { stocks: 2, percent: 0 }]), 'out fighters do not trigger intense alone');

if (failed) {
  console.error(`${failed} stage-bed check(s) failed`);
  process.exit(1);
}
console.log('stage-bed: ok');
