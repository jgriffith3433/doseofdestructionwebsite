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

// Roster-wide lint: all 33 fighters (Season 1 plus the 20 others): own KO cry, efforts, hurts and taunt.
const fsMod = 'node:fs';
const fs = (await import(fsMod)) as { readFileSync(p: URL, enc: string): string; existsSync(p: URL): boolean };
const fightersJson = JSON.parse(fs.readFileSync(new URL('../../../content/fighters.json', import.meta.url), 'utf8')) as { id: string }[];
const roster = fightersJson.map((f) => f.id);
check('roster is 33 fighters', roster.length === 33, String(roster.length));
const rest = roster.filter((id) => !(SEASON_ONE as readonly string[]).includes(id));
check('20 fighters outside Season 1', rest.length === 20, String(rest.length));
const byId = new Map(lines.map((l) => [l.id, l]));
const allKo = roster.map((id) => byId.get(`fighter.${id}.ko`));
check('every fighter has a KO line', allKo.every((l) => !!l?.audio));
check('no KO is the shared "Aaaaagh!"', allKo.every((l) => l?.text !== 'Aaaaagh!'));
check('33 unique KO lines', new Set(allKo.map((l) => l?.text)).size === 33);
for (const id of rest) {
  for (const slot of ['effort.0', 'effort.1', 'hurt.0', 'hurt.1', 'ko', 'taunt']) {
    const l = byId.get(`fighter.${id}.${slot}`);
    check(`${id}.${slot}: line and take file`, !!l && l.audio === `/audio/voice/${l.id}.mp3` && fs.existsSync(new URL(`../../..${l.audio}`, import.meta.url)));
    if (l && !slot.startsWith('hurt.1')) {
      const w = l.text.trim().split(/\s+/).length;
      check(`${l.id}: ≤4 words`, w <= 4, l.text);
    }
  }
  check(`${id}: voice is its win-line voice`, byId.get(`fighter.${id}.ko`)?.take?.voice === byId.get(`fighter.${id}.win`)?.take?.voice);
}
const fighterLines = lines.filter((l) => /^fighter\.[^.]+\.(effort|hurt|ko|taunt)/.test(l.id));
const files = fighterLines.map((l) => l.audio);
check('no two fighter lines share a take file', new Set(files).size === files.length);
for (const g of ['ko', 'taunt']) {
  const t = fighterLines.filter((l) => l.group === g).map((l) => l.text);
  check(`no two fighters share a ${g} line`, new Set(t).size === t.length);
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log('fighter-voice: all checks passed');
