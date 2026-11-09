// Story scenes (ui/scene.ts): on-screen story text is one short line at a time (studio quality rule 6e).
// Every campaign line and every commentary caption is cut into pieces of at most MAX_WORDS words, nothing is
// lost or reordered, and each piece gets a sensible time on screen. Run with `npm test`.

import campaign from '../../../content/campaign.json' with { type: 'json' };
import voice from '../../../content/voice.json' with { type: 'json' };
import { MAX_WORDS, chunkLine, chunkTimes } from '../campaign/sceneText.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const count = (s: string) => s.split(/\s+/).filter(Boolean).length;

const texts: string[] = [];
for (const c of campaign as { intro: { text: string }[]; outro: { text: string }[] }[]) {
  for (const l of [...c.intro, ...c.outro]) texts.push(l.text);
}
for (const l of (voice as { lines: { text: string }[] }).lines) texts.push(l.text);

let longest = 0;
let lost = '';
for (const t of texts) {
  const pieces = chunkLine(t);
  for (const p of pieces) longest = Math.max(longest, count(p));
  if (!lost && norm(pieces.join(' ')) !== norm(t)) lost = t;
}
check(`every story and commentary line shows at most ${MAX_WORDS} words at a time (${texts.length} lines)`, longest <= MAX_WORDS, `longest ${longest}`);
check('cutting a line never drops or reorders words', !lost, lost);

check('a short line stays whole', chunkLine('Hi. Bye.').join('|') === 'Hi.|Bye.');
check('a long sentence is cut at its comma', chunkLine('Every night at midnight the furnace floor becomes a stage, and the whole city tunes in.').length === 2);
check('a run with no punctuation is cut evenly', chunkLine('a b c d e f g h i j k l m n o p q r s t u v').every((p) => count(p) <= MAX_WORDS));

const silent = chunkTimes(['one two three', 'four'], null);
check('without a voice take, each piece stays up long enough to read', silent.every((ms) => ms >= 1300 && ms <= 4200), silent.join(', '));
const voiced = chunkTimes(['one two three', 'four'], 4000);
check('with a voice take, the pieces share the take by words', voiced[0] > voiced[1] && Math.abs(voiced[0] + voiced[1] - 4350) < 400, voiced.join(', '));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all scene text checks passed');
