// The match intro (campaign/intro.ts) and the stage tile's pan (ui/stagePreview.ts): the 13 Season 1 fighters each have their
// own entrance and the other 20 the spotlight drop; every entrance ends standing neutral (nothing to snap to when the fight
// starts), the plan fits the 3 s, the camera eases, and the tile's pan loops seamlessly.

import fighters from '../../../content/fighters.json' with { type: 'json' };
import stages from '../../../content/stages.json' with { type: 'json' };
import { FLY_MS, INTRO_MS, SEASON_ONE_ENTRANCES, entranceBeats, entranceKind, entrancePose, flyCamera, flyProgress, planIntro, type EntranceKind } from '../campaign/intro.ts';
import { layerShift, previewCamera, PREVIEW_MS } from '../ui/stagePreview.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const ids = (fighters as { id: string }[]).map((f) => f.id);
const S1 = Object.keys(SEASON_ONE_ENTRANCES);
check('13 Season 1 fighters have an entrance', S1.length === 13 && S1.every((id) => ids.includes(id)), String(S1.length));
const kinds = S1.map((id) => SEASON_ONE_ENTRANCES[id]);
check('each Season 1 entrance is its own', new Set(kinds).size === 13, kinds.join(','));
const rest = ids.filter((id) => !S1.includes(id));
check('the other fighters get the spotlight drop', rest.length === ids.length - 13 && rest.every((id) => entranceKind(id) === 'spotlight'), String(rest.length));
check('the spotlight drop ends on the fighter\'s taunt', entranceBeats('spotlight').some((b) => b.fx === 'taunt'));

const ALL: EntranceKind[] = [...new Set([...kinds, 'spotlight' as EntranceKind])];
for (const kind of ALL) {
  for (const from of [-1, 1] as const) {
    const end = entrancePose(kind, 1, from);
    const turns = end.rot / (Math.PI * 2);
    const neutral = !end.hidden && Math.abs(end.dx) < 1e-6 && Math.abs(end.dy) < 1e-6 && Math.abs(end.sx - 1) < 1e-6 && Math.abs(end.sy - 1) < 1e-6 && end.alpha === 1 && Math.abs(turns - Math.round(turns)) < 1e-6;
    check(`${kind} (from ${from}) ends standing where the sim has them`, neutral, JSON.stringify({ ...end, prop: undefined }));
    check(`${kind} (from ${from}) is not on stage before it starts`, entrancePose(kind, -0.01, from).hidden);
  }
  // No frame jumps: each step of 1/60 s through a 1 s entrance moves the fighter less than a height.
  let worst = 0;
  let prev = entrancePose(kind, 0.001, 1);
  for (let i = 1; i <= 200; i++) {
    const p = entrancePose(kind, i / 200, 1);
    if (!prev.hidden && !p.hidden) worst = Math.max(worst, Math.hypot(p.dx - prev.dx, p.dy - prev.dy));
    prev = p;
  }
  check(`${kind} moves smoothly`, worst < 0.6, worst.toFixed(3));
  const beats = entranceBeats(kind);
  check(`${kind} has beats in order, inside the entrance`, beats.length > 0 && beats.every((b, i) => b.at >= 0 && b.at <= 1 && (i === 0 || b.at >= beats[i - 1].at)));
}

// The plan: 2 to 4 fighters, the last entrance ends before the 3 s, and the left one comes in from the left.
for (const n of [1, 2, 3, 4]) {
  const cast = ['orchestrator', 'storm-less', 'got-ur-back', 'stratabots'].slice(0, n).map((who, i) => ({ slot: i, who, x: -600 + i * 400, color: '#fff' }));
  const plan = planIntro(cast, 'city-top');
  const end = Math.max(...plan.entries.map((e) => e.startMs + e.durMs));
  check(`${n} fighter(s): every entrance ends inside the intro`, end <= INTRO_MS - 200 && plan.totalMs === INTRO_MS, `ends ${end}`);
  check(`${n} fighter(s): entrances come one after another`, plan.entries.every((e, i) => i === 0 || e.startMs > plan.entries[i - 1].startMs || n === 1));
}
check('the left fighter comes in from the left', planIntro([{ slot: 0, who: 'exit-punk', x: -500, color: '#f00' }, { slot: 1, who: 'kaelen', x: 500, color: '#00f' }], 'x').entries.map((e) => e.from).join() === '-1,1');

// The camera: eased at both ends (no first-frame or last-frame lurch), monotonic, lands on the goal.
const steps = Array.from({ length: 101 }, (_, i) => flyProgress((i / 100) * FLY_MS));
check('the fly-in starts and ends gently', steps[0] === 0 && steps[100] === 1 && steps[1] < 0.001 && 1 - steps[99] < 0.001);
check('the fly-in only moves forward', steps.every((v, i) => i === 0 || v >= steps[i - 1]));
const wide = { x: -4, y: 3, d: 28 };
const goal = { x: 0, y: 1.4, d: 14 };
const end = flyCamera(wide, goal, 1);
check('the fly-in lands exactly on the fight framing', end.x === goal.x && end.y === goal.y && end.d === goal.d);
check('the fly-in starts wide', flyCamera(wide, goal, 0).d === 28);
check('3 s intro, fly-in inside it', INTRO_MS === 3000 && FLY_MS < INTRO_MS);

// The stage tile's pan: seamless at the loop, covers both sides, pushes in, far layers move less than near ones.
const a = previewCamera(0);
const b = previewCamera(PREVIEW_MS);
check('the tile\'s pan loops seamlessly', Math.abs(a.pan - b.pan) < 1e-9 && Math.abs(a.zoom - b.zoom) < 1e-9);
const pans = Array.from({ length: 41 }, (_, i) => previewCamera((i / 40) * PREVIEW_MS).pan);
check('the tile\'s pan sweeps both ways', Math.min(...pans) < -0.99 && Math.max(...pans) > 0.99);
check('the tile\'s pan is 2 s', PREVIEW_MS === 2000);
check('far layers slide less than near ones', layerShift(20) < layerShift(0.3) && layerShift(0.3) < layerShift(-2));
const sd = stages as { id: string; layers?: { image: string; hidden?: boolean; high?: boolean; z: number }[] }[];
check('all 9 stages have layers to pan', sd.length === 9 && sd.every((s) => (s.layers ?? []).filter((l) => l.image && !l.hidden && !l.high).length >= 2), sd.map((s) => `${s.id}:${(s.layers ?? []).length}`).join(' '));

process.exit(failed ? 1 : 0);
