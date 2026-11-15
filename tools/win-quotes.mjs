// Win quotes (content/voice.json `winQuotes`): per fighter, one general quote (the existing `fighter.<id>.win` line is the
// other general one) and one matchup quote against each story rival (the pairs in content/intros.json, both directions).
// The words live in tools/win-quotes.data.json; this merges them into voice.json. A quote gets `audio` and `take` only when
// its mp3 is in audio/voice/ (recorded through Hawkes Gen audio.voice in the fighter's own voice, id = the file name), so the
// game never asks for a file that isn't there.   node tools/win-quotes.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const voicePath = path.join(root, 'content/voice.json');
const voice = JSON.parse(fs.readFileSync(voicePath, 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'tools/win-quotes.data.json'), 'utf8'));
const intros = JSON.parse(fs.readFileSync(path.join(root, 'content/intros.json'), 'utf8'));

const entry = (id, who, text) => {
  const q = { id, text };
  if (fs.existsSync(path.join(root, 'audio/voice', `${id}.mp3`))) {
    q.audio = `/audio/voice/${id}.mp3`;
    q.take = { text, voice: voice.voices[who] };
  }
  return q;
};

const out = {};
for (const [who, text] of Object.entries(data.general)) out[who] = { general: [entry(`winquote.${who}.1`, who, text)], vs: {} };
for (const [who, m] of Object.entries(data.vs)) for (const [rival, text] of Object.entries(m)) out[who].vs[rival] = entry(`winquote.${who}.vs.${rival}`, who, text);

const problems = [];
for (const p of intros.pairs) for (const [a, b] of [[p.a, p.b], [p.b, p.a]]) if (!out[a]?.vs[b]) problems.push(`no quote: ${a} beats ${b}`);
for (const [who, q] of Object.entries(out)) {
  if (!voice.voices[who]) problems.push(`${who} has no voice`);
  if (!voice.lines.some((l) => l.id === `fighter.${who}.win`)) problems.push(`${who} has no win line`);
  for (const t of [...q.general, ...Object.values(q.vs)]) if (t.text.split(/\s+/).length > 10) problems.push(`over 10 words: ${t.id}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const all = Object.values(out).flatMap((q) => [...q.general, ...Object.values(q.vs)]);
console.log(`${all.length} quotes, ${all.filter((q) => q.audio).length} recorded`);
if (process.argv.includes('--check')) process.exit(0);
voice.winQuotes = out;
fs.writeFileSync(voicePath, JSON.stringify(voice, null, 2) + '\n');
