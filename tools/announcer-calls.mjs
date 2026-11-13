// The announcer's show calls (content/voice.json): "Choose your fighter!", "The winner is...", "Ready... FIGHT!" (2 takes),
// "GAME!" (3 takes), "Final stock!" (the 4th last-stock call), "No contest!" and every stage's name (`announcer.stage.<id>`).
// Fighter names are `announcer.name.<id>` (already recorded). Recorded through Hawkes Gen audio.voice in the announcer's voice
// (content/voice.json voices.announcer), cut and levelled to -16 LUFS (ffmpeg, true peak under -1.5 dB); a line gets `audio`
// and `take` only when its mp3 is in audio/voice/, so the game never asks for a file that isn't there.
//   node tools/announcer-calls.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const voicePath = path.join(root, 'content/voice.json');
const voice = JSON.parse(fs.readFileSync(voicePath, 'utf8'));
const stages = JSON.parse(fs.readFileSync(path.join(root, 'content/stages.json'), 'utf8'));
const who = voice.voices.announcer;

const calls = [
  ['announcer.choose', 'announcer', '[shouting] Choose your fighter!'],
  ['announcer.winner-is', 'announcer', '[shouting] The winner is...'],
  ['announcer.ready-fight.1', 'announcer', '[shouting] Ready... FIGHT!'],
  ['announcer.ready-fight.2', 'announcer', '[shouting] Ready... [pause] FIGHT!'],
  ['announcer.game.1', 'announcer', '[shouting] GAME!'],
  ['announcer.game.2', 'announcer', '[shouting] GAME!!'],
  ['announcer.game.3', 'announcer', '[shouting] And... GAME!'],
  ['announcer.last-stock.4', 'announcer', '[shouting] Final stock!'],
  ['announcer.no-contest', 'announcer', '[shouting] No contest!'],
  ...stages.map((s) => [`announcer.stage.${s.id}`, 'names', `[shouting] ${s.name}!`]),
];

const problems = [];
const made = new Map();
for (const [id, group, take] of calls) {
  const line = { id, group, who: 'announcer', text: take.replace(/^\[[a-z]+\]\s*/, '').replace(/\[pause\]\s*/, '') };
  if (fs.existsSync(path.join(root, 'audio/voice', `${id}.mp3`))) {
    line.audio = `/audio/voice/${id}.mp3`;
    line.take = { text: take, voice: who };
  } else problems.push(`no mp3: ${id}`);
  made.set(id, line);
}
for (const c of voice.lines.filter((l) => l.id.startsWith('announcer.name.'))) {
  if (!c.audio) problems.push(`name not recorded: ${c.id}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`${made.size} announcer calls, all recorded`);
if (process.argv.includes('--check')) process.exit(0);
const rest = voice.lines.filter((l) => !made.has(l.id));
const last = rest.map((l) => l.id.startsWith('announcer.')).lastIndexOf(true);
voice.lines = [...rest.slice(0, last + 1), ...made.values(), ...rest.slice(last + 1)];
fs.writeFileSync(voicePath, JSON.stringify(voice, null, 2) + '\n');
