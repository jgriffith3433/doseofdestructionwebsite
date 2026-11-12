// The finale takeover (sim/step.ts broadcastEvents, campaign/takeover.ts, content/campaign.json, content/voice.json): each of the
// ten season finales has one, it fires on the 60 s mark or the player's second-to-last stock, the rule lands within 1 s, the lines
// differ for ahead and behind, every line is recorded in the Orchestrator's voice, and the run is deterministic.

import campaign from '../../../content/campaign.json' with { type: 'json' };
import voice from '../../../content/voice.json' with { type: 'json' };
import { newGame, hashState, type BroadcastDef } from '../sim/state.ts';
import { step, TAKEOVER_RULE_FRAMES, playerMood, type SimEvent } from '../sim/step.ts';
import { NO_INPUT } from '../sim/input.ts';
import { POOL, takeoverLines } from '../campaign/takeover.ts';

declare const process: { exit(code: number): never; getBuiltinModule(id: string): { existsSync(p: string): boolean } };
const fs = process.getBuiltinModule('node:fs');
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}
type Ch = { id: string; season?: number; fight: { events?: BroadcastDef[] } };
const chapters = campaign as unknown as Ch[];
const lines = new Map((voice.lines as { id: string; text: string; audio?: string; take?: { voice: string } }[]).map((l) => [l.id, l]));

// One takeover in the last chapter of each of the ten seasons.
const finales: Ch[] = [];
for (let s = 1; s <= 10; s++) finales.push(chapters.filter((c) => (c.season ?? 1) === s).at(-1)!);
check('ten season finales', finales.length === 10 && finales.every(Boolean));
check('every finale has a takeover with a rule', finales.every((c) => c.fight.events?.some((e) => e.kind === 'takeover' && e.rule && e.when.time === 60 && e.when.stocks === 2)));

// Every line it can say is recorded, in the Orchestrator's voice.
let n = 0;
const wanted = new Set<string>();
for (const c of finales) for (const mood of [1, -1]) for (const hot of [false, true]) for (const id of takeoverLines(c.season ?? 1, c.id, mood, hot, true).ids) wanted.add(id);
for (const id of wanted) {
  const l = lines.get(id);
  n++;
  if (!l?.audio || !fs.existsSync(`.${l.audio}`) || l.take?.voice !== voice.voices.orchestrator) check(`line recorded: ${id}`, false);
}
check(`${n} reachable takeover lines are recorded`, failed === 0);
const all = [...lines.keys()].filter((k) => k.startsWith('orchestrator.takeover.'));
check('about 30 takeover lines', all.length === 30, `${all.length}`);
check('pools match the data', all.filter((k) => k.includes('.seize.')).length === POOL.seize && all.filter((k) => k.includes('.hot.')).length === POOL.hot);
check('every line is 12 words or fewer', all.every((k) => lines.get(k)!.text.split(/\s+/).length <= 12));
check('ahead and behind lines differ in every finale', finales.every((c) => takeoverLines(c.season ?? 1, c.id, 1, false, true).ids[1] !== takeoverLines(c.season ?? 1, c.id, -1, false, true).ids[1]));
check('over 100% changes the opener', takeoverLines(3, 'walk-on', 1, true, true).ids[0] !== takeoverLines(3, 'walk-on', 1, false, true).ids[0]);

// The sim: the trigger, the mood in the event, the rule within 1 s, deterministic.
const run = (stocksDown: boolean, rule: BroadcastDef['rule']) => {
  const g = newGame([{ char: 0, stocks: 3 }, { char: 1, stocks: 3 }], { stocks: 3, seed: 3, broadcast: [{ id: 't', kind: 'takeover', when: { time: 60, stocks: 2 }, rule }] });
  const evs: { frame: number; e: SimEvent }[] = [];
  for (let i = 0; i < 61 * 60 + 120; i++) {
    if (stocksDown && i === 300) { g.fighters[0].stocks = 2; g.fighters[0].percent = 1100; }
    if (i === 100) g.fighters[1].stocks = 3;
    for (const e of step(g, [NO_INPUT, NO_INPUT])) if (e.type === 'broadcast') evs.push({ frame: g.frame, e });
  }
  return { g, evs };
};
const early = run(true, { gravity: 60 });
const start = early.evs.find((x) => x.e.type === 'broadcast' && x.e.kind === 'takeover' && x.e.phase === 'start');
const ruled = early.evs.find((x) => x.e.type === 'broadcast' && x.e.kind === 'takeover-rule');
check('player down to 2 stocks fires it early', !!start && start.frame < 600, `${start?.frame}`);
check('the event carries hot (over 100%)', start?.e.type === 'broadcast' && start.e.hot === 1);
check('the rule lands within 1 s', !!start && !!ruled && ruled.frame - start.frame <= TAKEOVER_RULE_FRAMES + 1 && ruled.frame - start.frame < 60, `${ruled?.frame} - ${start?.frame}`);
check('gravity was rewritten', early.g.rules.gravity === 60);
const late = run(false, { giant: 'rival', startPercent: 300 });
const s2 = late.evs.find((x) => x.e.type === 'broadcast' && x.e.kind === 'takeover');
check('otherwise it fires at 60 s', !!s2 && s2.frame >= 3600 && s2.frame < 3610, `${s2?.frame}`);
check('giant grows the rival only', late.g.fighters[1].scale === 150 && late.g.fighters[0].scale === 100);
check('start percent hurts everyone up to it', late.g.fighters.every((f) => f.percent >= 300 && f.startPercent === 300));
check('deterministic', hashState(run(true, { gravity: 60 }).g) === hashState(early.g));
{
  const g = newGame([{ char: 0, stocks: 3 }, { char: 1, stocks: 3 }], { stocks: 3, seed: 1 });
  g.fighters[0].stocks = 2;
  check('mood: behind on stocks', playerMood(g) === -1);
  g.fighters[0].stocks = 3; g.fighters[0].percent = 500; g.fighters[1].percent = 100;
  check('mood: behind on damage at equal stocks', playerMood(g) === -1);
  g.fighters[0].percent = 0;
  check('mood: ahead', playerMood(g) === 1);
}
if (failed) process.exit(1);
console.log('takeover ok');
