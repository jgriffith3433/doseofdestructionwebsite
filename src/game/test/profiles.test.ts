// CPU playstyle profiles (ai/profiles.ts): every fighter has one, and the five produce different measured
// behaviour. The same fighter is played by a bot under each style against the same opponent: a zoner keeps
// more room than a rushdown, a grappler grabs far more often than an aerial, an aerial spends more time in the air.

import { CHARACTERS, FIGHTERS, characterIndex } from '../sim/characters.ts';
import { ACT, newGame } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { PLAYSTYLES, styleId, type PlaystyleId } from '../ai/profiles.ts';

declare const process: { argv?: string[]; exit(code: number): never; env: Record<string, string | undefined> };

export interface Measure { distance: number; grabsPerMin: number; airShare: number; frames: number }

/** Plays `style` as `char` against a default-style bot of `foe` over a few seeds and stages, and measures the first bot. */
export function measureStyle(style: PlaystyleId, char: string, foe: string, level = 7, seeds = 6): Measure {
  let dist = 0;
  let n = 0;
  let grabs = 0;
  let air = 0;
  for (let k = 0; k < seeds; k++) {
    const g = newGame([{ char: characterIndex(char) }, { char: characterIndex(foe) }], { stocks: 3, seed: 100 + k, stage: k % 4, rules: {} });
    const bots = [new Bot(0, level, 31 + k * 7, false, style), new Bot(1, level, 977 + k * 11)];
    let was = false;
    for (let i = 0; i < 3600 && !g.over; i++) {
      step(g, bots.map((b) => b.think(g)));
      const a = g.fighters[0];
      const b = g.fighters[1];
      if (a.action === ACT.DEAD || b.action === ACT.DEAD || a.action === ACT.RESPAWN || b.action === ACT.RESPAWN) continue;
      dist += Math.abs(a.x - b.x) / 1000;
      n++;
      if (!a.grounded) air++;
      const now = a.action === ACT.GRAB;
      if (now && !was) grabs++;
      was = now;
    }
  }
  return { distance: dist / n, grabsPerMin: grabs / (n / 3600), airShare: air / n, frames: n };
}

export function runProfileTests(check: (name: string, ok: boolean, detail?: string) => void): void {
  const missing = FIGHTERS.filter((_, i) => !(PLAYSTYLES as string[]).includes(styleId(i))).map((f) => f.id);
  check(`profiles: every one of the ${FIGHTERS.length} fighters has a playstyle`, FIGHTERS.length === 33 && missing.length === 0, missing.join(', '));
  const used = new Set(FIGHTERS.map((_, i) => styleId(i)));
  check('profiles: the roster uses all five playstyles', used.size === 5, [...used].join(', '));
  const bad = FIGHTERS.filter((f) => (f as { playstyle?: string }).playstyle && !(PLAYSTYLES as string[]).includes((f as { playstyle?: string }).playstyle!));
  check('profiles: every content override names a real playstyle', bad.length === 0, bad.map((f) => f.id).join(', '));

  const m = Object.fromEntries(PLAYSTYLES.map((p) => [p, measureStyle(p, 'exit-punk', 'wallit')])) as Record<PlaystyleId, Measure>;
  const line = PLAYSTYLES.map((p) => `${p}: ${m[p].distance.toFixed(0)}u ${m[p].grabsPerMin.toFixed(1)}g/min ${(m[p].airShare * 100).toFixed(0)}% air`).join(' | ');
  if (process.env.PROFILE_REPORT) console.log(line);
  check('profiles: a zoner keeps a larger average distance than a rushdown', m.zoner.distance > m.rushdown.distance * 1.15, line);
  check('profiles: a grappler grabs at least twice as often as an aerial', m.grappler.grabsPerMin >= m.aerial.grabsPerMin * 2 && m.grappler.grabsPerMin > 0.5, line);
  check('profiles: an aerial spends more time in the air than a grappler or a bruiser', m.aerial.airShare > m.grappler.airShare && m.aerial.airShare > m.bruiser.airShare, line);
  check('profiles: a rushdown stays closer than an aerial', m.rushdown.distance < m.aerial.distance, line);
  void CHARACTERS;
}

if (process.argv?.[1]?.endsWith('profiles.test.ts')) {
  let fail = 0;
  runProfileTests((name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail ?? ''})`}`);
    if (!ok) fail++;
  });
  process.exit(fail ? 1 : 0);
}
