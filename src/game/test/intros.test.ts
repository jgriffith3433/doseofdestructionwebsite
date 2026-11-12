// Pre-fight exchanges (content/intros.json, campaign/intros.ts): 32 rival pairs, two voiced lines each, every line
// 10 words or fewer and recorded in that speaker's own voice; 6 generic exchanges cover every fighter type.

import intros from '../../../content/intros.json' with { type: 'json' };
import voice from '../../../content/voice.json' with { type: 'json' };
import fighters from '../../../content/fighters.json' with { type: 'json' };
import { exchangeFor, pairFor } from '../campaign/intros.ts';

declare const process: { exit(code: number): never; getBuiltinModule(id: string): { existsSync(p: string): boolean } };
const fs = process.getBuiltinModule('node:fs');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const voices = (voice as { voices: Record<string, string> }).voices;
const ids = new Set((fighters as { id: string }[]).map((f) => f.id));

type L = { who: string; text: string; audio: string; take: { text: string; voice: string } };
const pairs = (intros as { pairs: { id: string; a: string; b: string; lines: L[] }[] }).pairs;
const generic = (intros as { generic: Record<string, { lines: L[] }> }).generic;
const all: L[] = [...pairs.flatMap((p) => p.lines), ...Object.values(generic).flatMap((g) => g.lines)];

check('at least 32 rival pairs', pairs.length >= 32, String(pairs.length));
check('every pair has two lines, each by one of the pair', pairs.every((p) => p.lines.length === 2 && p.lines.every((l) => l.who === p.a || l.who === p.b)));
check('a pair is listed once', new Set(pairs.map((p) => [p.a, p.b].sort().join('+'))).size === pairs.length);
check('pairs are of known fighters, never The Mechanic', pairs.every((p) => ids.has(p.a) && ids.has(p.b) && p.a !== 'the-mechanic' && p.b !== 'the-mechanic'));
check('6 generic exchanges', Object.keys(generic).length === 6);
const long = all.filter((l) => words(l.text) > 10);
check('every line is 10 words or fewer', long.length === 0, long.map((l) => l.text).join(' | '));
const unvoiced = all.filter((l) => !l.audio || !fs.existsSync(`audio/voice/${l.audio.split('/').pop()}`));
check(`every line (${all.length}) has its recorded take`, unvoiced.length === 0, unvoiced.map((l) => l.audio).join(', '));
const wrong = all.filter((l) => l.take.voice !== voices[l.who] || l.take.text !== l.text);
check("every take is in the speaker's own voice and says the line", wrong.length === 0, wrong.map((l) => l.audio).join(', '));
const roles = new Set((fighters as { role: string }[]).map((f) => f.role));
const types = (intros as { types: Record<string, string> }).types;
check('every fighter role maps to a generic exchange', [...roles].every((r) => generic[types[r]]), [...roles].filter((r) => !generic[types[r]]).join(','));

check('a listed pair is found in either order', pairFor('kaelen', 'exit-punk')?.id === pairFor('exit-punk', 'kaelen')?.id && !!pairFor('exit-punk', 'kaelen'));
check('an unlisted pair gets a generic exchange by type', exchangeFor('break', 'kaelen', 'Heavy').generic && exchangeFor('break', 'kaelen', 'Heavy').id === 'intro.generic.heavy');

process.exit(failed ? 1 : 0);
