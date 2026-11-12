// Win quotes (content/voice.json winQuotes, winQuote.ts): two general quotes per fighter (the older win line plus one), one
// matchup quote against each story rival (content/intros.json, both directions), every quote 10 words or fewer, a recorded one
// in the fighter's own voice with its file on disk; a rival win picks the matchup quote and no fighter repeats a quote back to back.

import intros from '../../../content/intros.json' with { type: 'json' };
import voice from '../../../content/voice.json' with { type: 'json' };
import fighters from '../../../content/fighters.json' with { type: 'json' };
import type { VoiceCatalog } from '../audio.ts';
import { generalPool, pickWinQuote, resetWinQuotes, winQuoteLines } from '../winQuote.ts';

declare const process: { exit(code: number): never; getBuiltinModule(id: string): { existsSync(p: string): boolean } };
const fs = process.getBuiltinModule('node:fs');
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const v = voice as unknown as VoiceCatalog;
const ids = (fighters as { id: string }[]).map((f) => f.id);
const pairs = (intros as { pairs: { a: string; b: string }[] }).pairs;

check('every fighter has 2 general quotes', ids.every((id) => generalPool(v, id).length === 2), ids.filter((id) => generalPool(v, id).length !== 2).join(','));
const rivals = new Map<string, string[]>();
for (const p of pairs) {
  rivals.set(p.a, [...(rivals.get(p.a) ?? []), p.b]);
  rivals.set(p.b, [...(rivals.get(p.b) ?? []), p.a]);
}
check('a matchup quote for each rival, both directions', [...rivals].every(([a, bs]) => bs.every((b) => v.winQuotes?.[a]?.vs[b])));
check('no matchup quote for a non-rival', Object.entries(v.winQuotes ?? {}).every(([a, q]) => Object.keys(q.vs).every((b) => rivals.get(a)?.includes(b))));
const all = winQuoteLines(v);
check('about 90 new quotes (97)', all.length === 97, String(all.length));
check('quote ids are unique', new Set(all.map((l) => l.id)).size === all.length);
check('every quote is 10 words or fewer', all.every((l) => words(l.text) <= 10 && words(l.text) > 0));
const recorded = all.filter((l) => l.audio);
check('a recorded quote has its file and its fighter\'s voice', recorded.every((l) => fs.existsSync(`.${l.audio}`) && l.take?.voice === v.voices[l.who] && l.take.text === l.text));
console.log(`info ${recorded.length} of ${all.length} quotes recorded`);

// Picking
resetWinQuotes();
const r = pickWinQuote(v, 'exit-punk', ['kaelen']);
check('beating a rival plays the matchup quote', r.kind === 'rival' && r.id === 'winquote.exit-punk.vs.kaelen' && r.loser === 'kaelen');
const again = pickWinQuote(v, 'exit-punk', ['kaelen']);
check('never the same quote twice in a row (the repeat becomes a general one)', again.id !== r.id && again.kind === 'general');
resetWinQuotes();
let repeats = 0;
let prev = '';
for (let i = 0; i < 200; i++) {
  const q = pickWinQuote(v, 'slice', ['tt'], Math.random);
  if (q.id === prev) repeats++;
  prev = q.id;
}
check('general quotes alternate with no back-to-back repeat', repeats === 0, `${repeats} repeats`);
check('every fighter, every rival: no repeats over 40 results', ids.every((id) => {
  resetWinQuotes();
  let last = '';
  for (let i = 0; i < 40; i++) {
    const q = pickWinQuote(v, id, i % 3 === 0 ? [...(rivals.get(id) ?? []), 'tt'] : ['tt-none'], Math.random);
    if (q.id === last) return false;
    last = q.id;
  }
  return true;
}));
const forced = pickWinQuote(v, 'break', ['ss-boulder'], Math.random, 'fighter.break.win');
check('a Tour ending keeps its own win line', forced.id === 'fighter.break.win' && forced.text === "Rule one. I don't fall off.");

if (failed) process.exit(1);
console.log('win quotes ok');
