import { RUMBLE, CALM_MAX_MS, CALM_MAX_STRENGTH, rumble, rumbleFor, rumbleHit, rumbleLog, rumbleStats } from '../rumble.ts';
import { setTouchSettings } from '../touchSettings.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

const k = ['light', 'medium', 'heavy', 'ko'] as const;
for (let i = 1; i < k.length; i++) {
  ok(RUMBLE[k[i]].ms > RUMBLE[k[i - 1]].ms, `${k[i]} lasts longer than ${k[i - 1]}`);
  ok(RUMBLE[k[i]].strong > RUMBLE[k[i - 1]].strong, `${k[i]} is stronger than ${k[i - 1]}`);
}
for (const x of k) {
  const c = rumbleFor(x, true);
  ok(c.ms <= CALM_MAX_MS && c.strong <= CALM_MAX_STRENGTH && c.weak <= CALM_MAX_STRENGTH, `calm ${x} stays inside the limits`);
  ok(c.ms <= RUMBLE[x].ms && c.strong <= RUMBLE[x].strong, `calm ${x} is never harder than normal`);
}
ok(rumbleFor('ko', true).strong > rumbleFor('light', true).strong, 'calm keeps the tiers apart');

setTouchSettings({ vibrate: true });
rumbleHit(30);
rumbleHit(150);
rumble('ko');
ok(rumbleLog.map((r) => r.kind).join() === 'light,heavy,ko', 'hit weights map to tiers');
setTouchSettings({ vibrate: false });
const n = rumbleLog.length;
rumbleHit(150);
rumble('ko');
ok(rumbleLog.length === n && rumbleStats.suppressed === 2, 'Rumble off sends nothing');

if (fails) process.exit(1);
console.log('rumble ok');
