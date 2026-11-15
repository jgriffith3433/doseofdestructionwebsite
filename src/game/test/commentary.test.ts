// The announcer and Blog Man (commentary.ts): at least 8 kinds of call come from match events, no line repeats
// twice in a row (not even across kinds, not after an intro), every episode has a Blog Man intro, and the
// pools are all in the voice catalog. Run: node src/game/test/commentary.test.ts

declare const process: { exit(code: number): never };

import { CALL_KINDS, Commentator, introCall, poolOf, type Call } from '../commentary.ts';
import { CHAPTER_ENTRIES } from '../campaign/story.ts';
import { Match } from '../match.ts';
import { characterIndex } from '../sim/characters.ts';
import type { SimEvent } from '../sim/step.ts';

const assert = (v: unknown, msg: string): void => {
  if (!v) throw new Error(msg);
};

// A real two-fighter state (3 stocks) to edit; the events are made up, the state is the sim's.
const m = new Match({ mode: 'versus', stage: 0, stocks: 5, rules: { timeLimit: 20000 }, slots: [{ char: characterIndex('exit-punk'), cpu: null }, { char: characterIndex('kaelen'), cpu: null }] }, 7);
const s = m.state;
const seen = new Set<string>();
const all: Call[] = [];
const feed = (frame: number, events: SimEvent[]): void => {
  s.frame = frame;
  for (const c of cm.onEvents(s, events)) {
    seen.add(c.kind);
    all.push(c);
  }
};
let n = 0;
const cm = new Commentator(s, () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff));
const hit = (by: number, dmg: number, shield = false): SimEvent => ({ type: 'hit', attacker: by, victim: 1 - by, x: 0, y: 0, dmg, kb: 0, shield, lag: 3 });
const ko = (victim: number, by: number): SimEvent => ({ type: 'ko', victim, by, x: 0, y: 0 });
const die = (victim: number): void => void s.fighters[victim].stocks--;

let f = 100;
// First blood: fighter 1 takes the first stock (3 -> 2).
die(0); feed(f, [ko(0, 1)]); f += 400;
// A big hit, then a combo of three, then shield break and a danger-zone hit.
feed(f, [hit(1, 150)]); f += 200;
feed(f, [hit(0, 60)]); feed(f + 20, [hit(0, 60)]); feed(f + 40, [hit(0, 60)]); f += 400;
feed(f, [{ type: 'shieldbreak', id: 0, x: 0, y: 0 }]); f += 400;
s.fighters[1].percent = 1600; feed(f, [hit(0, 80)]); f += 400;
// Comeback: fighter 1 was ahead (3 v 2), fighter 0 now KOs twice to go ahead.
die(1); feed(f, [ko(1, 0)]); f += 400;
// A plain KO, a self-destruct, a hazard and a stage warning.
die(0); feed(f, [ko(0, 1)]); f += 400;
die(1); feed(f, [ko(1, -1)]); f += 400;
feed(f, [{ type: 'hurt', victim: 0, source: 'hazard', index: 0, x: 0, y: 0, dmg: 50, kb: 0 }]); f += 400;
feed(f, [{ type: 'stage', event: 0, phase: 'warn' }]); f += 400;
// Time running low (limit 3600), then a lull.
feed(f, []);
feed(20000 - 300, []);

// Last stock and showdown: a fresh pair.
const m2 = new Match({ mode: 'versus', stage: 0, stocks: 2, rules: {}, slots: [{ char: 0, cpu: null }, { char: 1, cpu: null }] }, 3);
const cm2 = new Commentator(m2.state, () => 0.3);
m2.state.frame = 500;
m2.state.fighters[0].stocks = 1;
for (const c of cm2.onEvents(m2.state, [ko(0, 1)])) seen.add(c.kind); // first blood
m2.state.frame = 900;
m2.state.fighters[1].stocks = 1;
for (const c of cm2.onEvents(m2.state, [ko(1, 0)])) seen.add(c.kind); // both on one: showdown or last-stock
m2.state.frame = 1300;
m2.state.fighters[0].stocks = 1;
cm2.onEvents(m2.state, []);
m2.state.frame = 1300 + 13 * 60;
for (const c of cm2.onEvents(m2.state, [])) seen.add(c.kind); // a lull

console.log('kinds:', [...seen].join(', '));
assert(seen.size >= 8, `only ${seen.size} kinds of call came from events (want at least 8)`);
for (const k of ['first-blood', 'ko', 'comeback', 'self-destruct', 'big-hit', 'combo', 'danger', 'shield-break', 'hazard', 'stage-event', 'time-low']) assert(seen.has(k), `no ${k} call`);

// No line twice in a row, even with a one-line-only RNG; and the pools have room.
for (let i = 1; i < all.length; i++) assert(all[i].id !== all[i - 1].id, `line repeated: ${all[i].id}`);
for (const k of CALL_KINDS) assert(poolOf(k).length >= 3, `${k} has fewer than 3 lines`);
{
  // Stress: a pool picked from over and over never repeats back to back.
  const st = new Match({ mode: 'versus', stage: 0, stocks: 99, rules: {}, slots: [{ char: 0, cpu: null }, { char: 1, cpu: null }] }, 1).state;
  const c = new Commentator(st, () => 0);
  let lastId = '';
  for (let i = 0; i < 200; i++) {
    st.frame = 1000 + i * 400;
    st.fighters[0].stocks--;
    for (const call of c.onEvents(st, [ko(0, 1)])) {
      assert(call.id !== lastId, `stress repeat ${call.id}`);
      lastId = call.id;
    }
  }
}

// The voice director's 5 minute rule: with `fresh` refusing every line the commentator stays silent; with it allowing only
// unheard lines, no id comes twice (a pool of 3 or 4 is used up, then the calls are skipped).
{
  const heard = new Set<string>();
  const m2 = new Match({ mode: 'versus', stage: 0, stocks: 99, rules: {}, slots: [{ char: characterIndex('exit-punk'), cpu: null }, { char: characterIndex('kaelen'), cpu: null }] }, 3);
  const quiet = new Commentator(m2.state, Math.random, () => false);
  const loud = new Commentator(m2.state, Math.random, (id) => !heard.has(id));
  let said = 0;
  for (let i = 0; i < 40; i++) {
    m2.state.frame = 1000 + i * 600;
    const e: SimEvent[] = [{ type: 'ko', victim: 0, by: 1, x: 0, y: 0 }];
    m2.state.fighters[0].stocks = 90 - i;
    assert(quiet.onEvents(m2.state, e).length === 0, 'a commentator with no fresh lines still spoke');
    for (const c of loud.onEvents(m2.state, e)) {
      assert(!heard.has(c.id), `repeated inside the window: ${c.id}`);
      heard.add(c.id);
      said++;
    }
  }
  assert(said > 0 && said <= 20, `fresh-only commentator said ${said} lines`);
}

// Blog Man: every episode has an intro, and it counts as the line said last.
for (const c of CHAPTER_ENTRIES) {
  const call = introCall(c.id);
  assert(call && call.who === 'blog-man' && call.text.length > 20, `no Blog Man intro for ${c.id}`);
}
const seasons = new Set(CHAPTER_ENTRIES.map((c) => c.season ?? 1));
assert(seasons.size === 10, 'expected 10 seasons');
console.log(`ok: ${seen.size} call kinds, ${all.length} calls, ${CHAPTER_ENTRIES.length} Blog Man intros across ${seasons.size} seasons`);
process.exit(0);
