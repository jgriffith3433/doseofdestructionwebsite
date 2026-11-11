declare const process: { exit(code: number): never };
// Season 1 fighter voice kit: unique KO cries, short taunts, effort/hurt pools.
// Run: node --experimental-strip-types src/game/test/fighter-voice.test.ts

import voice from '../../../content/voice.json' with { type: 'json' };

const SEASON_ONE = [
  'exit-punk',
  'kaelen',
  'break',
  'dj-wont-read',
  'shutup-bot',
  'small-weather',
  'blog-man',
  'evil-blue-bird',
  'got-ur-back',
  'slice',
  'ss-boulder',
  'stratabots',
  'orchestrator',
] as const;

const lines = (voice as { lines: { id: string; who: string; group: string; text: string; audio: string | null; take: { text: string; voice: string } | null }[] }).lines;

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok - ${name}`);
  else {
    failed++;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const kos = SEASON_ONE.map((id) => {
  const l = lines.find((x) => x.id === `fighter.${id}.ko`);
  return { id, text: l?.text ?? '', line: l };
});
check('every Season 1 fighter has a KO line', kos.every((k) => !!k.line));
check('no Season 1 KO is still Aaaaagh!', kos.every((k) => k.text !== 'Aaaaagh!'));
const koSet = new Set(kos.map((k) => k.text));
check('Season 1 KO cries are all different', koSet.size === kos.length, [...kos.map((k) => k.text)].join(' | '));

for (const id of SEASON_ONE) {
  const efforts = [0, 1, 2].map((i) => lines.find((l) => l.id === `fighter.${id}.effort.${i}`));
  const hurts = [0, 1].map((i) => lines.find((l) => l.id === `fighter.${id}.hurt.${i}`));
  const taunt = lines.find((l) => l.id === `fighter.${id}.taunt`);
  check(`${id}: 3 efforts`, efforts.every((l) => !!l && l.group === 'effort'));
  check(`${id}: 2 hurts`, hurts.every((l) => !!l && l.group === 'hurt'));
  check(`${id}: taunt`, !!taunt && taunt.group === 'taunt');
  const words = (taunt?.text ?? '').trim().split(/\s+/).filter(Boolean).length;
  check(`${id}: taunt ≤4 words`, words > 0 && words <= 4, taunt?.text);
  for (const l of [...efforts, ...hurts, taunt, kos.find((k) => k.id === id)?.line]) {
    if (!l) continue;
    check(`${l.id}: audio path`, !!l.audio && l.audio === `/audio/voice/${l.id}.mp3`);
  }
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log('fighter-voice: all checks passed');
