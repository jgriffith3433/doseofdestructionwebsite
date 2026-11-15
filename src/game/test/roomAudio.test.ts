declare const process: { exit(code: number): never };
// Per-stage rooms (content/stages.json `room`), the impulse built from them, the pan and the KO fade.
import { LOW_MAX_SECONDS, departing, makeImpulse, panFromScreen, wetFor } from '../roomAudio.ts';
import { STAGES } from '../sim/stage.ts';

let failed = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
};

const names = new Set<string>();
for (const st of STAGES) {
  const r = st.room;
  check(!!r, `${st.id}: has a room`);
  if (!r) continue;
  check(!names.has(r.name), `${st.id}: room name ${r.name} is its own`);
  names.add(r.name);
  check(r.wet >= 0.1 && r.wet <= 0.25, `${st.id}: wet ${r.wet} is 10-25%`);
  check(r.seconds >= 0.1 && r.seconds <= 2, `${st.id}: length ${r.seconds}`);
  const ir = makeImpulse(r, 48000);
  check(ir.length === 2 && ir[0].length === ir[1].length, `${st.id}: stereo impulse`);
  check(Math.abs(ir[0].length - (r.seconds + r.preDelayMs / 1000) * 48000) < 100, `${st.id}: impulse is as long as the room`);
  check(ir[0].every(Number.isFinite), `${st.id}: finite impulse`);
  check(ir[0].some((x, i) => x !== ir[1][i]), `${st.id}: the two channels differ`);
  check(wetFor(r, true) === wetFor(r, false) / 2, `${st.id}: Low sends half the wet`);
  check(makeImpulse(r, 48000, true).length <= (LOW_MAX_SECONDS + r.preDelayMs / 1000) * 48000 + 16, `${st.id}: Low caps the impulse`);
}
check(STAGES.length === 9 && names.size === 9, 'nine stages, nine rooms');
const byId = (id: string) => STAGES.find((s) => s.id === id)!.room!;
check(byId('humans-in-the-loop').seconds === 0.6, 'TV studio: 0.6 s');
check(byId('city-top').seconds === 0.2, 'rooftop: 0.2 s');
check(byId('yo-house').seconds === 1.8 && !!byId('yo-house').dryLowpassHz, 'underwater: 1.8 s with a low-pass');
const a = makeImpulse(byId('humans-in-the-loop'), 44100);
const b = makeImpulse(byId('humans-in-the-loop'), 44100);
check(a[0].every((x, i) => x === b[0][i]), 'the impulse is deterministic');
// The tail darkens: the last tenth has less high-frequency content (fewer sign changes) than the first tenth after the delay.
const dark = makeImpulse(byId('yo-house'), 44100)[0];
const zc = (from: number, to: number) => { let n = 0; for (let i = from + 1; i < to; i++) if (dark[i] * dark[i - 1] < 0) n++; return n / (to - from); };
check(zc(dark.length * 0.85 | 0, dark.length) < zc(dark.length * 0.05 | 0, dark.length * 0.3 | 0), 'underwater tail gets darker');

check(panFromScreen(0) === -0.8 && panFromScreen(1) === 0.8 && Math.abs(panFromScreen(0.5)) < 1e-9, 'pan: edges are -0.8 and 0.8, centre 0');
check(panFromScreen(-3) === -0.8 && panFromScreen(5) === 0.8 && panFromScreen(NaN) === 0, 'pan is clamped');
// Equal-power: a hit at the left edge is well over 6 dB louder in the left channel.
const x = (panFromScreen(0) + 1) / 2;
const leftDb = 20 * Math.log10(Math.cos((x * Math.PI) / 2) / Math.sin((x * Math.PI) / 2));
check(leftDb > 6, `a hit at the left edge is ${leftDb.toFixed(1)} dB louder on the left`);
const near = departing(0), far = departing(1);
check(far.cutoffHz < near.cutoffHz && far.gain < near.gain && far.seconds > near.seconds, 'a KO far away is darker, quieter and slower');

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('roomAudio: ok');
