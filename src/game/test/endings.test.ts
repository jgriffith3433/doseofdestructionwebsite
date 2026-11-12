// Tour endings (campaign/endings.ts, content/endings.json): one per fighter (33), two short caption lines, a voiced second
// line in Blog Man's voice, unlock rules. Run: npm test.
import fs from 'node:fs';
import { CHARACTERS } from '../sim/characters.ts';
import { MAX_WORDS } from '../campaign/sceneText.ts';
import { TOURS } from '../campaign/tour.ts';
import { ENDINGS, ENDING_BEATS, MECHANIC, endingUnlocked } from '../campaign/endings.ts';
import voiceJson from '../../../content/voice.json' with { type: 'json' };

declare const process: { exit(code: number): never };
let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}
const voice = voiceJson as unknown as { voices: Record<string, string>; endings: Record<string, { text: string; voice: string; audio?: string }> };

check(ENDINGS.length === CHARACTERS.length && CHARACTERS.every((c) => ENDINGS.some((e) => e.fighter === c.id)), `an ending for each of the ${CHARACTERS.length} fighters`);
check(ENDINGS.every((e) => e.lines.length === 2 && e.lines.every((l) => l.trim() && l.split(/\s+/).length <= MAX_WORDS)), `two caption lines of at most ${MAX_WORDS} words each`);
check(ENDINGS.every((e) => e.art === `/characters/endings/${e.fighter}.webp`), 'the picture path is characters/endings/<id>.webp');
check(ENDINGS.every((e) => e.audio === `/audio/voice/ending.${e.fighter}.mp3` && fs.existsSync(`.${e.audio}`)), 'the second line has a recorded take');
check(ENDINGS.every((e) => voice.endings[e.fighter]?.text === e.lines[1] && voice.endings[e.fighter].voice === voice.voices['blog-man']), "voice.json holds each narration line in Blog Man's voice");
check(new Set(ENDINGS.map((e) => e.lines.join('|'))).size === ENDINGS.length, 'no two endings share their words');
const done = new Set(TOURS.map((t) => t.fighter));
check(TOURS.every((t) => endingUnlocked(t.fighter, new Set([t.fighter]))) && !endingUnlocked('kaelen', new Set()), 'a cleared Tour opens its fighter, none opens nobody');
check(!endingUnlocked(MECHANIC, new Set([...done].slice(1))) && endingUnlocked(MECHANIC, done), "The Mechanic's ending opens when every Tour is cleared");
const b = ENDING_BEATS;
check(b.caption1 < b.caption2 && b.caption2 < b.sting && b.sting < b.card && b.card < b.end && b.end >= 12000 && b.end <= 15000, 'the beats run in order over 12 to 15 s');
if (failed) process.exit(1);
