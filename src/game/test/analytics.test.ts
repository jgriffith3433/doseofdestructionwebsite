// Hawkes Analytics in the game (analytics.ts) against a recording stand-in for the SDK: a real sim match (you vs
// a level 9 CPU, with a bot on your pad like the playtest's), its KOs as deaths with their causes, one level_end with the match's numbers, picks, the campaign
// run and progress, controls once per session, and the build stamp. Run: node src/game/test/analytics.test.ts

declare const process: { exit(code: number): never };

// No @types/node here (tsconfig "types": []): a small assert of our own.
const assert = {
  ok(v: unknown, msg = 'expected a true value'): void {
    if (!v) throw new Error(msg);
  },
  equal(a: unknown, b: unknown, msg?: string): void {
    if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  deepEqual(a: unknown, b: unknown): void {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  },
};

type Call = { m: string; args: unknown[] };
const calls: Call[] = [];
const record = (m: string) => (...args: unknown[]) => {
  calls.push({ m, args });
  return m === 'ask' ? Promise.resolve(null) : undefined;
};
const listeners = new Map<string, ((e: unknown) => void)[]>();
const store = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: '?playtest=match', pathname: '/Game/' };
g.sessionStorage = store();
g.addEventListener = (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
g.document = { querySelectorAll: () => [], activeElement: null };
g.__DOD_BUILD__ = { version: '1.2.3', commit: 'abc1234', date: '2026-10-19T00:00:00Z' };
g.hawkesAnalytics = new Proxy({ version: 1, debugLog: [] } as Record<string, unknown>, {
  get: (t, k: string) => (k in t ? t[k] : record(k)),
});
const fire = (type: string, e: unknown = {}) => listeners.get(type)?.forEach((fn) => fn(e));

const analytics = await import('../analytics.ts');
const { Match } = await import('../match.ts');
const { CHARACTERS, MOVE_KEYS } = await import('../sim/characters.ts');
const { CHAPTERS } = await import('../campaign/story.ts');
const { Bot } = await import('../ai/bot.ts');

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
const named = (m: string) => calls.filter((c) => c.m === m);
const tracked = (name: string) => calls.filter((c) => c.m === 'track' && c.args[0] === name);
const props = (c: Call | undefined, i = 1) => (c?.args[i] ?? {}) as Record<string, unknown>;

test('the build stamp is on the page and debug is on for playtests', () => {
  assert.deepEqual((g.window as { HAWKES_BUILD?: unknown }).HAWKES_BUILD, g.__DOD_BUILD__);
  const init = named('init')[0];
  assert.equal(props(init, 0).product, 'doseofdestruction');
  assert.equal(props(init, 0).debug, true);
  assert.equal(named('loadStart').length, 1);
});

const exitPunk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const brk = CHARACTERS.findIndex((c) => c.id === 'break');

test('fighter and stage picks', () => {
  analytics.fighterPicks('versus', [{ char: exitPunk, cpu: null }, { char: brk, cpu: 7 }]);
  analytics.stagePick('versus', 0, true);
  const picks = named('feature').filter((c) => c.args[0] === 'fighter_pick');
  assert.equal(picks.length, 1, 'one pick per person, none for CPUs');
  assert.equal(props(picks[0]).value, 'exit-punk');
  assert.equal(props(picks[0]).vs, 'break');
  assert.equal(props(picks[0]).cpu_level, 7);
  const stage = named('feature').find((c) => c.args[0] === 'stage_pick');
  assert.equal(props(stage).random, true);
});

// A real match, 2 stocks each: a level 9 bot on your pad (as in the playtest) against a level 9 CPU.
const m = new Match({ mode: 'versus', stage: 0, stocks: 2, rules: {}, slots: [{ char: exitPunk, cpu: null }, { char: brk, cpu: 9 }] }, 7);
const pad = new Bot(0, 9, 11);
analytics.matchStart(m, null);
for (let i = 0; i < 60 * 60 * 6 && !m.state.over; i++) analytics.matchEvents(m, m.tick(pad.think(m.state)));

test('the match plays out', () => assert.ok(m.state.over, 'the CPU should win within 6 minutes'));

test('level_start with the context', () => {
  const start = named('levelStart')[0];
  assert.equal(start.args[0], 'versus');
  assert.equal(props(start).fighter, 'exit-punk');
  assert.equal(props(start).opponent, 'break');
  const ctx = named('setContext').map((c) => props(c, 0)).find((c) => c.fighter === 'exit-punk');
  assert.equal(ctx?.opponent, 'break');
  assert.equal(ctx?.mode, 'versus');
});

test('a death for each KO, with the cause and the stage', () => {
  const deaths = named('death');
  assert.equal(deaths.length, m.kos.length);
  assert.ok(deaths.length >= 2);
  for (const d of deaths) {
    const cause = String(d.args[0]);
    assert.ok([...MOVE_KEYS, 'hit', 'fall', 'hazard'].includes(cause as never), `cause ${cause}`);
    assert.ok(['you', 'cpu'].includes(String(props(d).victim)));
    assert.ok(['you', 'cpu', 'none'].includes(String(props(d).by_role)));
    assert.ok(props(d).stage);
    assert.equal(typeof props(d).x, 'number');
  }
  // A KO by a fighter names the move that sent them, even after a trade.
  assert.ok(deaths.filter((d) => props(d).by !== 'none').every((d) => (MOVE_KEYS as readonly string[]).includes(String(d.args[0]))));
});

test('one level_end with the numbers (once, however it is reported)', () => {
  analytics.matchEnd(m, m.playerWon() ? 'complete' : 'death');
  analytics.matchEnd(m, 'quit');
  const ends = named('levelEnd');
  assert.equal(ends.length, 1);
  const [level, result, p] = ends[0].args as [string, string, Record<string, unknown>];
  assert.equal(level, 'versus');
  assert.equal(result, m.playerWon() ? 'complete' : 'death');
  assert.equal(p.won, m.playerWon());
  assert.equal(p.stocks_left, Math.max(0, m.state.fighters[0].stocks));
  assert.equal(p.deaths, m.stats[0].falls);
  assert.equal(p.kos, m.stats[0].kos);
  assert.equal(p.damage_taken, m.stats[0].taken / 10);
  assert.ok(Number(p.match_seconds) > 0);
});

test('nothing per frame: a whole match is a handful of calls', () => {
  assert.ok(calls.length < 40, `${calls.length} calls`);
});

test('the campaign: run_start once, progress per chapter unlocked, run_end on the main menu', () => {
  const [c1, c2] = CHAPTERS;
  analytics.screen('campaign');
  analytics.chapterPlayed(c1);
  analytics.chapterPlayed(c1);
  assert.equal(tracked('run_start').length, 1);
  analytics.chapterCleared(c1, true, new Set([c1.id]));
  analytics.chapterCleared(c1, false, new Set([c1.id]));
  const progress = tracked('progress');
  assert.equal(progress.length, 1, 'a replayed chapter unlocks nothing');
  assert.equal(props(progress[0]).step, 1);
  assert.equal(props(progress[0]).label, c2.id);
  analytics.screen('main');
  const end = tracked('run_end');
  assert.equal(end.length, 1);
  assert.equal(props(end[0]).cleared, 2);
  assert.equal(props(end[0]).result, 'quit');
});

test('each kind of controls once per session', () => {
  fire('keydown');
  fire('keydown');
  fire('pointerdown', { pointerType: 'touch' });
  fire('gamepadconnected');
  const names = named('feature').map((c) => c.args[0]).filter((n) => String(n).startsWith('controls_'));
  assert.deepEqual(names, ['controls_keyboard', 'controls_touch', 'controls_gamepad']);
});

if (failed) {
  console.log(`\n${failed} analytics test(s) failed`);
  process.exit(1);
}
console.log('\nanalytics ok');

export {};
