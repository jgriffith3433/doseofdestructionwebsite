// Extra jumps are paid for: no fighter with 2+ extra jumps is above the roster's median power index (kb x dmg / frames),
// and Cel's gravity and fall speed sit inside the floaty group's range (the other multi-jumpers').
import { CHARACTERS } from '../sim/characters.ts';

declare const process: { exit(code: number): never };
let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const fighters = (await import('../../../content/fighters.json', { with: { type: 'json' } })).default as unknown as { id: string; jumps: number; kb: number; dmg: number; frames: number; gravity: number; fall: number }[];
const power = (f: { kb: number; dmg: number; frames: number }) => (f.kb * f.dmg) / f.frames;
const sorted = fighters.map(power).sort((a, b) => a - b);
const median = sorted[sorted.length >> 1];
check('the roster is whole', fighters.length === CHARACTERS.length, `${fighters.length}`);
const multi = fighters.filter((f) => f.jumps >= 2);
for (const f of multi) check(`${f.id} (${f.jumps} extra jumps) is not above the median power index`, power(f) <= median, `${power(f).toFixed(3)} vs ${median.toFixed(3)}`);
const floaty = multi.filter((f) => f.id !== 'cel');
const cel = fighters.find((f) => f.id === 'cel')!;
const lo = (k: 'gravity' | 'fall') => Math.min(...floaty.map((f) => f[k]));
const hi = (k: 'gravity' | 'fall') => Math.max(...floaty.map((f) => f[k]));
check('Cel gravity is above the floaty group minimum and inside its range', cel.gravity > lo('gravity') && cel.gravity <= hi('gravity'), `${cel.gravity}`);
check('Cel fall speed is above the floaty group minimum and inside its range', cel.fall > lo('fall') && cel.fall <= hi('fall'), `${cel.fall}`);
if (failed) process.exit(1);
