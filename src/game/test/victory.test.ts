// The victory stage (victory.ts, ui/victory.ts): 8 fanfare groups assigned in content/fighters.json (every fighter in one, every group
// used), each group's sound entry and file when it is made, the clip choice, the frame stepping, the hop, the push-in and the confetti.

import fighters from '../../../content/fighters.json' with { type: 'json' };
import sounds from '../../../content/sounds.json' with { type: 'json' };
import { FANFARES, LOSER_CLIPS, PANEL_AT_MS, PUSH_SCALE, WINNER_CLIPS, clipIndex, fanfareFor, makeConfetti, pickPoseClip, pushScale, rng, stepConfetto, victoryHop } from '../victory.ts';

declare const process: { exit(code: number): never; getBuiltinModule(id: string): { existsSync(p: string): boolean } };
const fs = process.getBuiltinModule('node:fs');
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
const list = fighters as { id: string; fanfare?: string }[];
const ids = new Set(FANFARES.map((g) => g.id));

check('8 fanfare groups', FANFARES.length === 8 && ids.size === 8);
check('every fighter names a group', list.every((f) => f.fanfare && ids.has(f.fanfare)), list.filter((f) => !f.fanfare || !ids.has(f.fanfare)).map((f) => f.id).join(','));
check('every group has fighters', FANFARES.every((g) => list.some((f) => f.fanfare === g.id)));
check('fanfareFor reads the fighter', fanfareFor('exit-punk').id === 'open-mic' && fanfareFor('future-man').id === 'the-reboot');
check('unknown fighter falls back to the first group', fanfareFor('nobody').id === FANFARES[0].id);

const entries = new Map((sounds as { id: string; file?: string; loop?: boolean; duration?: number | null }[]).map((s) => [s.id, s]));
for (const g of FANFARES) {
  const e = entries.get(g.sound);
  if (!e) continue; // not made yet: the entry arrives with the take
  check(`${g.id}: fanfare is a one-shot with a file on disk`, !e.loop && !!e.file && fs.existsSync(`.${e.file}`), e.file ?? 'no file');
}

check('winner clip: jump when no win or taunt clip', pickPoseClip({ jump: 1, idle: 2 }, WINNER_CLIPS)?.key === 'jump');
check('winner clip: a win clip beats the rest', pickPoseClip({ win: 1, jump: 1, idle: 2 }, WINNER_CLIPS)?.key === 'win');
check('loser clip: idle then hurt', pickPoseClip({ hurt: 1, idle: 2 }, LOSER_CLIPS)?.key === 'idle' && pickPoseClip({ hurt: 1 }, LOSER_CLIPS)?.key === 'hurt');
check('no clip: null', pickPoseClip({}, WINNER_CLIPS) === null);

const c = { frames: 10, fps: 30 };
check('clip frames step by time and loop', clipIndex(c, 0) === 0 && clipIndex(c, 100) === 3 && clipIndex(c, 334) === 0);
check('hop starts at the floor and ends on it', victoryHop(0, 20) === 0 && victoryHop(5000, 20) === 0 && victoryHop(300, 20) > 0);
check('push-in eases from 1 to the cap and holds', pushScale(0) === 1 && Math.abs(pushScale(5000) - PUSH_SCALE) < 1e-9 && pushScale(9000) === pushScale(5000) && pushScale(1000) > 1 && pushScale(1000) < pushScale(2500));
check('the panel opens within 3 s', PANEL_AT_MS <= 3000);

const a = makeConfetti(40, 400, '#ff0000', rng(7));
const b = makeConfetti(40, 400, '#ff0000', rng(7));
check('confetti is deterministic and in the winner colour', JSON.stringify(a) === JSON.stringify(b) && a.some((p) => p.color === '#ff0000') && a.length === 40);
const p = a[0];
const y0 = p.y;
check('confetti falls and leaves the stage', stepConfetto(p, 0.1, 300) && p.y > y0 && !stepConfetto({ ...p, y: 400 }, 0.1, 300));

if (failed) process.exit(1);
console.log('victory ok');
