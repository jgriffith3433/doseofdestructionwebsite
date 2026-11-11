// Tour (campaign/tour.ts, content/tours.json): every open-able fighter has a six-fight route with its own rival, the four
// rule twists come up, the CPU never gets easier, scenes use recorded lines, and the cleared mark is kept. Run: npm test.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { MAX_WORDS } from '../campaign/sceneText.ts';
import { TOURS, TOURS_KEY, TOUR_LENGTH, loadTours, markTourCleared, tourEnding, tourFor, tourIntro, tourSetup } from '../campaign/tour.ts';
import voiceJson from '../../../content/voice.json' with { type: 'json' };

const VOICE = voiceJson as { lines: { id: string; text: string; audio: string | null }[] };

declare const process: { exit(code: number): never };
let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const ids = new Set(CHARACTERS.map((c) => c.id));
const stages = new Set(STAGES.map((s) => s.id));
const voice = (id: string) => VOICE.lines.find((l) => l.id === id);
const cast = CHARACTERS.map((c) => c.id).filter((id) => id !== 'the-mechanic');

check(TOURS.length === cast.length && cast.every((id) => tourFor(id)), `a Tour for each of the ${cast.length} fighters on the card (The Mechanic is not on it)`);
check(TOURS.every((t) => ids.has(t.fighter) && ids.has(t.rival) && t.rival !== t.fighter && !t.fights.some((f) => f.foes.includes(t.fighter))), 'fighters, rivals and foes are real, and nobody fights themselves');
check(TOURS.every((t) => t.fights.length === TOUR_LENGTH), 'every Tour is six fights');
check(TOURS.every((t) => t.fights.every((f) => f.foes.every((x) => ids.has(x) && x !== 'the-mechanic') && stages.has(f.stage) && f.title && f.line)), 'every foe, stage, title and card line is valid');
check(TOURS.every((t) => { const last = t.fights[TOUR_LENGTH - 1]; return last.twist === 'rival' && last.foes.length === 1 && last.foes[0] === t.rival; }), 'the last fight is against the fighter\'s rival');
check(TOURS.every((t) => ['giant', 'two', 'low', 'race'].every((k) => t.fights.some((f) => f.twist === k))), 'every route uses a giant, two on one, low gravity and a KO race');
check(TOURS.every((t) => t.fights.every((f, i) => i === 0 || f.cpu >= t.fights[i - 1].cpu)), 'the CPU never gets easier through a run');
check(TOURS.every((t) => t.fights[TOUR_LENGTH - 1].cpu > t.fights[0].cpu), 'the last fight is harder than the first');
check(TOURS.every((t) => new Set(t.fights.flatMap((f) => f.foes)).size === t.fights.flatMap((f) => f.foes).length), 'no foe repeats within a route');
const sig = (t: (typeof TOURS)[number]) => JSON.stringify(t.fights.map((f) => [f.foes, f.stage, f.twist]));
check(new Set(TOURS.map(sig)).size === TOURS.length, 'every fighter\'s route is its own');
check(new Set(TOURS.map((t) => t.rival)).size >= 20, 'rivals are chosen per fighter, not one for all');

// The setups play the twists.
const t0 = tourFor('exit-punk')!;
for (const [i, f] of t0.fights.entries()) {
  const s = tourSetup(t0, i);
  const ok =
    s.slots[0].char === CHARACTERS.findIndex((c) => c.id === 'exit-punk') && s.slots[0].cpu === null && s.slots.slice(1).every((x) => x.team === 1 && x.cpu === f.cpu) &&
    (f.twist !== 'giant' || s.slots[1].scale === f.scale) && (f.twist !== 'low' || s.rules.gravity === f.gravity) && (f.twist !== 'race' || (s.objective === 'ko' && s.kos === 3 && !!s.rules.timeLimit)) && (f.twist !== 'two' || s.slots.length === 3);
  check(ok, `fight ${i + 1} (${f.twist}) is set up with its twist`);
}

// Scenes: recorded lines only, short, and the ending's closing card.
check(TOURS.every((t) => t.fights.every((_, i) => tourIntro(t, i, voice).lines.length >= 1 && tourIntro(t, i, voice).lines.every((l) => !!l.audio))), 'every between-fight scene has a recorded foe line');
check(TOURS.every((t) => t.fights.every((_, i) => tourIntro(t, i, voice).lines.every((l) => l.text.split(/\s+/).length <= MAX_WORDS))), `every scene line is ${MAX_WORDS} words or fewer`);
check(TOURS.every((t) => t.fights.every((_, i) => { const w = tourIntro(t, i, voice).lines.map((l) => l.who); return (i >= 1 && i < 5) === w.includes(t.rival) || i === 5; })), 'the rival heckles in fights 2 to 5 and is a foe in the sixth');
check(TOURS.every((t) => t.fights.every((f) => f.line.split(/\s+/).length <= 10) && t.ending.split(/\s+/).length <= 10), 'card lines are ten words or fewer');
check(TOURS.every((t) => { const e = tourEnding(t, voice); return e.lines.length === 1 && !!e.lines[0].audio && e.lines[0].who === t.fighter && e.card.title === `${CHARACTERS.find((c) => c.id === t.fighter)!.name} clears the Tour`; }), 'every ending is the fighter\'s own recorded win line and the card "<Fighter> clears the Tour"');

// The cleared mark is kept.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
check(loadTours().size === 0, 'a fresh save has no Tour cleared');
check(markTourCleared('kaelen') === true && markTourCleared('kaelen') === false, 'clearing marks it, the second time is not new');
check(loadTours().has('kaelen') && JSON.parse(store.get(TOURS_KEY)!).includes('kaelen'), 'the mark is in localStorage and read back');
store.set(TOURS_KEY, '{oops');
check(loadTours().size === 0, 'a damaged save reads as nothing cleared');

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('tour: all checks passed');
