// The episode highlight (campaign/highlight.ts): a campaign match records its last seconds of inputs, the replay runs
// through the same sim and reaches the same final KO, the final hit plays at 25%, the save round-trips and a stale save
// is dropped; and every episode has a Blog Man tease and recap line of at most 10 words in the voice catalog.
// Run: node src/game/test/highlight.test.ts

declare const process: { exit(code: number): never };

import { Bot } from '../ai/bot.ts';
import {
  HighlightPlayer, REPLAY, REPLAY_MS, loadHighlight, nextChapterId, recapApplies, recapId, saveHighlight, teaseId, WINDOW_TICKS,
} from '../campaign/highlight.ts';
import { CHAPTERS } from '../campaign/story.ts';
import { chunkLine, MAX_WORDS } from '../campaign/sceneText.ts';
import { Match } from '../match.ts';
import { characterIndex } from '../sim/characters.ts';
import voice from '../../../content/voice.json' with { type: 'json' };

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const check = (v: unknown, msg: string): void => {
  if (!v) throw new Error(msg);
  console.log(`ok - ${msg}`);
};

// A real campaign match, bots on both sides, to its end.
function play(seed: number): Match {
  const m = new Match(
    { mode: 'campaign', stage: 0, stocks: 1, rules: { timeLimit: 60 * 90 }, slots: [{ char: characterIndex('exit-punk'), cpu: null }, { char: characterIndex('kaelen'), cpu: 5 }] },
    seed,
  );
  const me = new Bot(0, 9, seed * 3);
  for (let i = 0; i < 60 * 120 && !m.state.over; i++) m.tick(me.think(m.state));
  return m;
}

let m = play(1);
for (let seed = 2; seed < 8 && !m.highlight; seed++) m = play(seed);
check(m.state.over && m.highlight, 'a finished campaign match has a highlight');
const h = m.highlight!;
h.chapter = 'open-mic';
check(h.inputs.length > 0 && h.inputs.length <= WINDOW_TICKS + 4 * 60, `it stores the last seconds of inputs (${h.inputs.length} ticks), not video`);
check(h.hit <= h.ko && h.ko >= h.from, 'the final hit is at or before the KO');

// The replay is deterministic: played to its end it shows the same final KO the match had.
const p = new HighlightPlayer(h);
let kos = 0;
let sawSlow = false;
let hitSeen = false;
let ms = 0;
while (!p.done() && ms < 20000) {
  if (p.slowed()) sawSlow = true;
  const ev = p.advance(1000 / 60);
  ms += 1000 / 60;
  for (const e of ev) {
    if (e.type === 'ko') kos++;
    if (e.type === 'hit' && !e.shield) hitSeen = true;
  }
}
check(hitSeen, 'the replay plays the final hit');
check(sawSlow, 'the final hit plays slowed');
check(ms <= REPLAY_MS + 200, `the replay is about 3 s of real time (${Math.round(ms)} ms, plan ${REPLAY_MS} ms)`);
check(REPLAY.slow === 0.25, 'the slow part runs at 25%');
if (h.ko <= h.hit + REPLAY.tail - 1) check(kos >= 1, 'the replay reaches the KO');

// The save round-trips; a changed roster or stage drops it.
saveHighlight(h);
const back = loadHighlight();
check(back && back.chapter === 'open-mic' && back.inputs.length === h.inputs.length, 'the highlight is kept in the save');
store.set('dod-highlight', JSON.stringify({ ...h, chars: ['nobody', 'kaelen'] }));
check(loadHighlight() === null, 'a save that no longer matches the roster is dropped');
store.set('dod-highlight', '{nope');
check(loadHighlight() === null, 'a broken save is dropped');

// The recap belongs to the episode after the highlight's.
check(recapApplies({ ...h, chapter: 'open-mic' }, 'house-heavy'), 'the next episode opens with the recap');
check(!recapApplies({ ...h, chapter: 'open-mic' }, 'bad-signal') && !recapApplies(null, 'open-mic'), 'no other episode does');
check(recapApplies({ ...h, chapter: CHAPTERS[CHAPTERS.length - 1].id }, CHAPTERS[0].id), 'a run that starts over recaps the finale');
check(nextChapterId(CHAPTERS[CHAPTERS.length - 1].id) === null, 'the finale has no next episode');

// 39 episodes, a tease and a recap for each, 10 words or fewer, in the catalog.
const lines = new Map((voice as { lines: { id: string; text: string; who: string; audio?: string }[] }).lines.map((l) => [l.id, l]));
check(CHAPTERS.length === 39, 'there are 39 episodes');
for (const c of CHAPTERS) {
  for (const id of [teaseId(c.id), recapId(c.id)]) {
    const l = lines.get(id);
    check(l && l.who === 'blog-man', `${id} is a Blog Man line`);
    const words = l!.text.trim().split(/\s+/).length;
    if (words > MAX_WORDS) throw new Error(`${id} has ${words} words`);
  }
}
console.log('highlight tests passed');
process.exit(0);
