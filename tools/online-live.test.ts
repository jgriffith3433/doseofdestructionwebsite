// Online play over Hawkes Net, from Node (docs/online.md, "Checks"): two players join a fresh test lobby, see each
// other, one renames, both queue, get paired, meet in a match room (a direct WebRTC link between the two, inputs as
// express frames), and play an online fight (CPU bots on the pads) through the rollback to the same result on both
// sides; then both sign the result, it is kept as a Hawkes Net record, and a third page that only reads builds the
// same leaderboard from it.
//
// Hawkes Net runs in this process from a hawkesnet checkout (its own test service: this machine is trusted), so it
// tests the network code as it is in that checkout, deployed or not. Not part of `npm test` (it needs WebRTC for Node):
//   npm i --no-save node-datachannel@0.33.4      (or set DATACHANNEL=/path/to/node_modules/node-datachannel)
//   node tools/online-live.test.ts                (HAWKESNET=<a hawkesnet checkout>, default C:/Projects/hawkesnet)
//   NO_LINK=1 node tools/online-live.test.ts      (no WebRTC: two networks that can't link; the match goes on the relay)

import { pathToFileURL } from 'node:url';
import type { Found, OnlineSetup } from '../src/game/net/matchmaker.ts';
import type { FightEnd } from '../src/game/net/fight.ts';
import type { MatchSetup } from '../src/game/match.ts';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

// NO_LINK=1: no WebRTC at all, as two players whose networks refuse a direct link: the match must move to the relay.
const noLink = Boolean(process.env.NO_LINK);
if (!noLink) {
  const dc = process.env.DATACHANNEL ? `${process.env.DATACHANNEL}/dist/esm/polyfill/index.mjs` : 'node-datachannel/polyfill';
  const { RTCPeerConnection } = await import(dc);
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = RTCPeerConnection;
}

// Hawkes Net here, before the game's network code reads where it is.
const net = process.env.HAWKESNET ?? 'C:/Projects/hawkesnet';
const { startTestHub } = await import(pathToFileURL(`${net}/test/helper.ts`).href);
const hub = await startTestHub();
(globalThis as { DOD_NET_ENDPOINT?: string }).DOD_NET_ENDPOINT = hub.endpoint;
const { Lobby } = await import('../src/game/net/lobby.ts');
const { Matchmaker } = await import('../src/game/net/matchmaker.ts');
const { OnlineFight } = await import('../src/game/net/fight.ts');
const { Match } = await import('../src/game/match.ts');
const { Bot } = await import('../src/game/ai/bot.ts');
const { randomId } = await import('../src/game/net/util.ts');
const { makeKey } = await import('../src/game/net/sign.ts');
const { Leaderboard } = await import('../src/game/net/board.ts');
const { formatDelta } = await import('../src/game/net/ratings.ts');

const t0 = Date.now();
const log = (text: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${text}`);
let failed = 0;
const check = (ok: boolean, text: string) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed++;
};
const until = async (test: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`timed out waiting for ${what}`);
  return false;
};

const lobbyId = `test-live-${randomId(6)}`;
log(`lobby ${lobbyId}`);

function player(name: string, char: number) {
  const lobby = new Lobby(lobbyId, { name, avatar: 'exit-punk' });
  const key = makeKey();
  const me = { name, avatar: 'exit-punk', char, pid: key.pubkey };
  const mm = new Matchmaker(lobby, {
    me: () => me,
    makeSetup: (host, guest): OnlineSetup => ({
      matchId: `${host.id}-${guest.id}-${randomId(6)}`,
      seed: 4242,
      stage: 0,
      rules: {},
      stocks: 1,
      timeLimit: 60 * 60,
      ids: [host.id, guest.id],
      names: [host.name, guest.name],
      avatars: [host.avatar, guest.avatar],
      chars: [host.char, guest.char],
      pids: [host.pid, guest.pid],
      at: Math.floor(Date.now() / 1000),
    }),
  });
  let found: Found | null = null;
  mm.on('found', (f: Found) => {
    found = f;
    log(`${name}: match found vs ${f.opponent.name} (slot ${f.slot}, ${f.setup.matchId})`);
  });
  lobby.start();
  return { lobby, mm, me, key, found: () => found };
}

const a = player('Live One', 0);
await new Promise((r) => setTimeout(r, 1500));
const b = player('Live Two', 1);

check(await until(() => a.lobby.count() === 2 && b.lobby.count() === 2, 30000, 'both in the lobby'), 'both players see "2 online"');
b.lobby.update({ name: 'Tester Two', avatar: 'break' });
check(await until(() => a.lobby.players().some((p) => p.name === 'Tester Two' && p.avatar === 'break'), 15000, 'the new name'), 'a profile change shows up for the other player');

a.mm.queue();
await new Promise((r) => setTimeout(r, 1000));
b.mm.queue();
check(await until(() => !!a.found() && !!b.found(), 60000, 'the pairing'), 'both queued players are paired with each other');
const fa = a.found()!;
const fb = b.found()!;
check(fa.setup.matchId === fb.setup.matchId && fa.slot !== fb.slot, `one match, two slots (host ${fa.slot === 0 ? 'Live One' : 'Tester Two'})`);
check(a.lobby.players().find((p) => p.self)?.status === 'in-match', 'the lobby shows them in a match');

function fightOf(f: Found, key: ReturnType<typeof makeKey>) {
  const s = f.setup;
  const setup: MatchSetup = {
    mode: 'online',
    stage: s.stage,
    stocks: s.stocks,
    rules: { ...s.rules, timeLimit: s.timeLimit },
    slots: s.chars.map((char, i) => ({ char, cpu: null, remote: i !== f.slot })),
    online: { matchId: s.matchId, names: s.names, avatars: s.avatars, ids: s.ids },
  };
  const m = new Match(setup, s.seed);
  const fight = new OnlineFight(f, m, key);
  const bot = new Bot(f.slot, 9, 77 + f.slot);
  let end: FightEnd | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  fight.onEnd = (e) => {
    end = e;
    clearInterval(timer);
  };
  fight.onStart = () => {
    fight.beginPlay();
    timer = setInterval(() => fight.tick(bot.think(m.state)), 1000 / 60);
  };
  fight.markLoaded();
  return { m, fight, end: () => end };
}

const pa = fightOf(fa, a.key);
const pb = fightOf(fb, b.key);
check(await until(() => !!pa.end() && !!pb.end(), 150000, 'the fight to end'), 'the online fight plays to an end on both sides');
const ea = pa.end();
const eb = pb.end();
if (ea && eb) {
  log(`ends: ${ea.reason} winner ${ea.result.winner} at frame ${ea.result.frames} / ${eb.reason} winner ${eb.result.winner} at frame ${eb.result.frames}`);
  log(`rollback: ${pa.fight.rb.rollbacks} + ${pb.fight.rb.rollbacks} rollbacks, max ${Math.max(pa.fight.rb.maxRolled, pb.fight.rb.maxRolled)} frames, ${pa.fight.rb.hashesMatched} hashes matched, rtt ${Math.round(fa.room.rttAvg)} ms, route ${fa.room.route}`);
  const st = fa.room.net?.stats();
  log(`match room: ${fa.room.net?.transport}, express ${st?.expressUp} up / ${st?.expressDown} down, ${fa.room.sent.u} input packets sent`);
  const want = noLink ? 'relay' : 'direct';
  check(fa.room.route === want && fb.room.route === want, noLink ? `with no link between them, the match is on Hawkes Net's relay (${fa.room.route} / ${fb.room.route})` : `the two are linked directly (${fa.room.route} / ${fb.room.route})`);
  check((st?.expressDown ?? 0) > 100, 'the inputs came as express frames');
  check((ea.reason === 'game' || ea.reason === 'time') && ea.reason === eb.reason, 'it ends on the game (not a desync or a lost link)');
  check(ea.result.winner === eb.result.winner && ea.result.frames === eb.result.frames, 'both sides agree on the winner and the last frame');
  check(pa.fight.rb.hashesMatched > 5, 'desync hashes were compared along the way');
}
if (ea && eb) {
  // The leaderboard: both sides sign the same result; it is kept as a Hawkes Net record and a reading page counts it.
  const [ra, rb] = await Promise.all([ea.rated, eb.rated]);
  check(ra?.kind === 'full' && rb?.kind === 'full', `both sides end with a fully signed result (${ra?.kind} / ${rb?.kind})`);
  check(!!ra && !!rb && JSON.stringify(ra.record) === JSON.stringify(rb.record), 'the two signed results are the same');
  const watcher = new Leaderboard(lobbyId);
  watcher.start();
  if (ra) new Leaderboard(lobbyId).addOwn(ra.record, { n: 'Tester Two', a: 'break' });
  check(await until(() => watcher.board('all').table.length === 2, 40000, 'the result in the records'), "a page that only reads gets the result from Hawkes Net's records");
  const table = watcher.board('all').table;
  log(`board: ${table.map((p) => `#${p.rank} ${p.id.slice(0, 8)} ${p.rating} ${p.wins}-${p.losses}`).join(' | ')}`);
  const d = watcher.board('all').deltas.get(ea.result.matchId);
  check(!!d && d[0] === -d[1] && Math.abs(d[0]) === (ea.result.winner ? 16 : 0), `the rating change is ${d ? d.map(formatDelta).join(' / ') : 'missing'}`);
}
a.mm.matchOver();
b.mm.matchOver();
check(await until(() => a.lobby.players().find((p) => p.id === b.lobby.id)?.status === 'idle', 15000, 'idle again'), 'after the match both are back to idle in the lobby');
a.lobby.leave();
b.lobby.leave();
log(failed ? `${failed} live check(s) failed` : 'all live checks passed');
setTimeout(() => void hub.stop().finally(() => process.exit(failed ? 1 : 0)), 500);
