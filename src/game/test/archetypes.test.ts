// Archetype normals (fighterDefs.ts applyArchetype, content/archetypes.json): a heavy's jab starts later and launches harder
// than a fast fighter's, floaty aerials stay out longer than fast ones, every fighter has an archetype.

import { CHARACTERS, ARCHETYPE_OF, ARCHETYPES, MOVE } from '../sim/characters.ts';
import { knockback } from '../sim/step.ts';
import { FIGHTERS } from '../sim/characters.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const of = (a: string) => CHARACTERS.filter((c) => c.archetype === a);
check('every fighter has an archetype', CHARACTERS.every((c) => ARCHETYPES.includes(c.archetype)) && FIGHTERS.every((f) => ARCHETYPE_OF[f.id] !== undefined));
check('all four archetypes are used', ARCHETYPES.every((a) => of(a).length >= 3), ARCHETYPES.map((a) => `${a} ${of(a).length}`).join(', '));

const startup = (c: (typeof CHARACTERS)[number], m: number) => Math.min(...c.moves[m].hits.map((w) => w.start));
/** Launch speed of the jab's hardest hit on a mid-weight at 100%. */
const jabKb = (c: (typeof CHARACTERS)[number]) => Math.max(...c.moves[MOVE.JAB].hits.flatMap((w) => w.boxes.map((b) => knockback(1000, b.dmg, 95, b.bkb, b.kbg))));
const active = (c: (typeof CHARACTERS)[number], m: number) => Math.max(...c.moves[m].hits.map((w) => w.end)) - startup(c, m) + 1;

const heavy = of('heavy'), fast = of('fast'), floaty = of('floaty');
check('a heavy jab starts later than any fast jab', Math.min(...heavy.map((c) => startup(c, MOVE.JAB))) > Math.max(...fast.map((c) => startup(c, MOVE.JAB))),
  `heavy ${Math.min(...heavy.map((c) => startup(c, MOVE.JAB)))}.., fast ..${Math.max(...fast.map((c) => startup(c, MOVE.JAB)))}`);
check('a heavy jab launches harder than any fast jab', Math.min(...heavy.map(jabKb)) > Math.max(...fast.map(jabKb)), `heavy ${Math.min(...heavy.map(jabKb))}.., fast ..${Math.max(...fast.map(jabKb))}`);
check('a fast jab is a multi-hit string, a heavy jab one hit', fast.every((c) => c.moves[MOVE.JAB].hits.length === 3) && heavy.every((c) => c.moves[MOVE.JAB].hits.length === 1));
for (const [name, m] of [['nair', MOVE.NAIR], ['fair', MOVE.FAIR], ['bair', MOVE.BAIR], ['uair', MOVE.UAIR], ['dair', MOVE.DAIR]] as const) {
  check(`floaty ${name} stays out longer than fast ${name}`, Math.min(...floaty.map((c) => active(c, m))) > Math.max(...fast.map((c) => active(c, m))),
    `floaty ${Math.min(...floaty.map((c) => active(c, m)))}.., fast ..${Math.max(...fast.map((c) => active(c, m)))}`);
}
check('fast ground normals start no later than heavy ones', ([MOVE.FTILT, MOVE.UTILT, MOVE.DTILT] as number[]).every((m) => Math.max(...fast.map((c) => startup(c, m))) <= Math.min(...heavy.map((c) => startup(c, m)))));

// One Attack press from a fast fighter lands all three jab hits on a standing foe; a heavy's lands one.
import { STAGES } from '../sim/stage.ts';
import { newGame } from '../sim/state.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { step } from '../sim/step.ts';
import { FX } from '../sim/fixed.ts';
function jabHits(id: string): number {
  const ix = CHARACTERS.findIndex((c) => c.id === id);
  const foe = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
  const stage = STAGES.findIndex((x) => x.id === 'city-top');
  const g = newGame([{ char: ix }, { char: foe }], { stocks: 3, seed: 5, stage });
  const [a, b] = g.fighters;
  for (let i = 0; i < 40; i++) step(g, [NO_INPUT, NO_INPUT]);
  b.x = a.x + a.facing * 40 * FX;
  let hits = 0;
  const press = packInput(0, 0, BTN.ATTACK);
  for (let i = 0; i < 60; i++) {
    const ev = step(g, [i === 0 ? press : NO_INPUT, NO_INPUT]);
    hits += ev.filter((e) => e.type === 'hit' && e.attacker === a.id).length;
  }
  return hits;
}

const fh = fast.map((c) => jabHits(c.id)), hh = heavy.map((c) => jabHits(c.id));
check('one press: every fast jab lands 3 hits on a close foe', fh.every((n) => n === 3), fh.join(','));
check('one press: every heavy jab lands 1 hit on a close foe', hh.every((n) => n === 1), hh.join(','));
if (failed) process.exit(1);
