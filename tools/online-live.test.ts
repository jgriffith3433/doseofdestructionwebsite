// Online play over the real public network, from Node (docs/online.md, "Checks"): two players join a fresh test lobby
// through the public Nostr relays, see each other, one renames, both queue, get paired, link over WebRTC, and play an
// online fight (CPU bots on the pads) through the rollback to the same result on both sides.
//
// Not part of `npm test` (it needs the network and a WebRTC for Node):
//   npm i --no-save node-datachannel@0.33.4      (or set DATACHANNEL=/path/to/node_modules/node-datachannel)
//   node tools/online-live.test.ts

import { Lobby } from '../src/game/net/lobby.ts';
import { Matchmaker, type Found, type OnlineSetup } from '../src/game/net/matchmaker.ts';
import { OnlineFight, type FightEnd } from '../src/game/net/fight.ts';
import { Match, type MatchSetup } from '../src/game/match.ts';
import { Bot } from '../src/game/ai/bot.ts';
import { randomId } from '../src/game/net/util.ts';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const dc = process.env.DATACHANNEL ? `${process.env.DATACHANNEL}/dist/esm/polyfill/index.mjs` : 'node-datachannel/polyfill';
const { RTCPeerConnection } = await import(dc);
(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = RTCPeerConnection;

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
  const me = { name, avatar: 'exit-punk', char };
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
    }),
  });
  let found: Found | null = null;
  mm.on('found', (f: Found) => {
    found = f;
    log(`${name}: match found vs ${f.opponent.name} (slot ${f.slot}, ${f.setup.matchId})`);
  });
  lobby.start();
  return { lobby, mm, me, found: () => found };
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

function fightOf(f: Found) {
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
  const fight = new OnlineFight(f, m);
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

const pa = fightOf(fa);
const pb = fightOf(fb);
check(await until(() => !!pa.end() && !!pb.end(), 150000, 'the fight to end'), 'the online fight plays to an end on both sides');
const ea = pa.end();
const eb = pb.end();
if (ea && eb) {
  log(`ends: ${ea.reason} winner ${ea.result.winner} at frame ${ea.result.frames} / ${eb.reason} winner ${eb.result.winner} at frame ${eb.result.frames}`);
  log(`rollback: ${pa.fight.rb.rollbacks} + ${pb.fight.rb.rollbacks} rollbacks, max ${Math.max(pa.fight.rb.maxRolled, pb.fight.rb.maxRolled)} frames, ${pa.fight.rb.hashesMatched} hashes matched, rtt ${Math.round(fa.room.rttAvg)} ms, route ${fa.room.route}`);
  check((ea.reason === 'game' || ea.reason === 'time') && ea.reason === eb.reason, 'it ends on the game (not a desync or a lost link)');
  check(ea.result.winner === eb.result.winner && ea.result.frames === eb.result.frames, 'both sides agree on the winner and the last frame');
  check(pa.fight.rb.hashesMatched > 5, 'desync hashes were compared along the way');
}
a.mm.matchOver();
b.mm.matchOver();
check(await until(() => a.lobby.players().find((p) => p.id === b.lobby.id)?.status === 'idle', 15000, 'idle again'), 'after the match both are back to idle in the lobby');
a.lobby.leave();
b.lobby.leave();
log(failed ? `${failed} live check(s) failed` : 'all live checks passed');
setTimeout(() => process.exit(failed ? 1 : 0), 500);
