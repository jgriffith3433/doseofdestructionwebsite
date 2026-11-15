// Tour endings (content/endings.json): per fighter an illustration (art/endings/<id>.webp, painted through Hawkes Gen
// image.generate at 1920x1080), two caption lines (the second voiced by Blog Man as audio/voice/ending.<id>.mp3) and
// the words in tools/endings.data.json. `node tools/endings.mjs` merges words + files into content/endings.json and
// voice.json `endings`; `--prompts` prints the Gen prompts; `--check` only validates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'tools/endings.data.json'), 'utf8'));
const fighters = Object.values(JSON.parse(fs.readFileSync(path.join(root, 'content/fighters.json'), 'utf8'))).map((f) => f.id);
const voicePath = path.join(root, 'content/voice.json');
const voice = JSON.parse(fs.readFileSync(voicePath, 'utf8'));

if (process.argv.includes('--prompts')) {
  for (const [id, e] of Object.entries(data.endings)) console.log(`${id}\t${e.look}, ${e.scene}. ${data.style}`);
  process.exit(0);
}

const problems = [];
const out = [];
for (const id of fighters) {
  const e = data.endings[id];
  if (!e) { problems.push(`no ending: ${id}`); continue; }
  for (const l of [e.l1, e.l2]) if (l.split(/\s+/).length > 10) problems.push(`over 10 words: ${id}: ${l}`);
  const vid = `ending.${id}`;
  const art = `/characters/endings/${id}.webp`;
  const hasArt = fs.existsSync(path.join(root, art.slice(1)));
  const hasVoice = fs.existsSync(path.join(root, 'audio/voice', `${vid}.mp3`));
  const entry = { fighter: id, art, lines: [e.l1, e.l2] };
  if (hasVoice) entry.audio = `/audio/voice/${vid}.mp3`;
  if (!hasArt) entry.pending = true;
  out.push(entry);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`${out.length} endings, ${out.filter((e) => !e.pending).length} with art, ${out.filter((e) => e.audio).length} voiced`);
if (process.argv.includes('--check')) process.exit(0);
fs.mkdirSync(path.join(root, 'content'), { recursive: true });
fs.writeFileSync(path.join(root, 'content/endings.json'), JSON.stringify(out.map(({ pending, ...e }) => e), null, 1) + '\n');
voice.endings = Object.fromEntries(out.map((e) => [e.fighter, { id: `ending.${e.fighter}`, text: e.lines[1], voice: voice.voices['blog-man'], ...(e.audio ? { audio: e.audio, take: { text: e.lines[1], voice: voice.voices['blog-man'] } } : {}) }]));
fs.writeFileSync(voicePath, JSON.stringify(voice, null, 2) + '\n');
