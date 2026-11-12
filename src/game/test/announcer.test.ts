// The announcer's show calls (content/voice.json, tools/announcer-calls.mjs): every fighter's name and every stage's name are
// recorded in the announcer's voice with their files on disk, plus "Choose your fighter!", "The winner is...", "Ready... FIGHT!"
// (2 takes), "GAME!" (3 takes), "Final stock!" (the 4th last-stock call) and "No contest!"; each file is about -16 LUFS.

import voice from '../../../content/voice.json' with { type: 'json' };
import fighters from '../../../content/fighters.json' with { type: 'json' };
import stages from '../../../content/stages.json' with { type: 'json' };
import type { VoiceCatalog } from '../audio.ts';

declare const process: { exit(code: number): never; getBuiltinModule(id: string): { existsSync(p: string): boolean; statSync(p: string): { size: number } } };
const fs = process.getBuiltinModule('node:fs');
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
const v = voice as unknown as VoiceCatalog;
const line = (id: string) => v.lines.find((l) => l.id === id);
const recorded = (id: string): boolean => {
  const l = line(id);
  if (!l?.audio || l.who !== 'announcer' || l.take?.voice !== v.voices.announcer) return false;
  const file = new URL(`../../..${l.audio}`, import.meta.url).pathname;
  return fs.existsSync(file) && fs.statSync(file).size > 4000;
};

const fighterIds = (fighters as { id: string }[]).map((f) => f.id);
const stageIds = (stages as { id: string }[]).map((s) => s.id);
check('every fighter has a recorded name call', fighterIds.every((id) => recorded(`announcer.name.${id}`)), fighterIds.filter((id) => !recorded(`announcer.name.${id}`)).join(','));
check('every stage has a recorded name call', stageIds.every((id) => recorded(`announcer.stage.${id}`)), stageIds.filter((id) => !recorded(`announcer.stage.${id}`)).join(','));
check('Choose your fighter, The winner is, No contest are recorded', ['announcer.choose', 'announcer.winner-is', 'announcer.no-contest'].every(recorded));
check('Ready... FIGHT! has 2 takes', ['announcer.ready-fight.1', 'announcer.ready-fight.2'].every(recorded) && !line('announcer.ready-fight.3'));
check('GAME! has 3 takes', ['announcer.game.1', 'announcer.game.2', 'announcer.game.3'].every(recorded));
check('Final stock! is a last-stock call', recorded('announcer.last-stock.4') && /final stock/i.test(line('announcer.last-stock.4')?.text ?? ''));
check('a stage call says its stage name', stageIds.every((id) => (line(`announcer.stage.${id}`)?.text ?? '').toLowerCase().startsWith((stages as { id: string; name: string }[]).find((s) => s.id === id)!.name.toLowerCase())));
check('no announcer call over 6 words', v.lines.filter((l) => /^announcer\.(choose|winner-is|ready-fight|game|no-contest|stage|name)/.test(l.id)).every((l) => l.text.split(/\s+/).length <= 6));
if (failed) process.exit(1);
console.log('\nall announcer checks passed');
