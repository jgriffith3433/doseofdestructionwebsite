// Online play, wired up (docs/online.md): the lobby every page joins on load, the queue, and the setup the host
// picks for a match. Nothing here blocks the game: every step is asynchronous and every failure is reported
// (console.error via netError) and shown as a plain line, while single player carries on.
//
// All of it runs on Hawkes Net (hawkes.ts: the project and its rooms). URL options: ?room=<id> puts this page in a
// private test lobby (Hawkes Net's "t-<id>/lobby") instead of the shared one (the two-tab playtest: Hawkes Gen's
// playtest.run peers: 2 adds room and peer); ?peer=<n> marks a playtest player.

import { Lobby } from './lobby.ts';
import { Matchmaker, type OnlineSetup } from './matchmaker.ts';
import { avatarChar, onProfile, profile, profileId } from './profile.ts';
import { netError, randomId } from './util.ts';
import { leaderboard } from './board.ts';
import { IS_LIVE, TEST_ROOM } from './hawkes.ts';
import { stagesFor } from '../modes.ts';

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

/** Whose players and table: "global" on doseofdestruction.com, "beta" anywhere else (the beta site, localhost: Hawkes
 *  Net's test rooms and test records), "test-<id>" in a playtest's private room. */
export const LOBBY_ID = TEST_ROOM ? `test-${TEST_ROOM}` : IS_LIVE ? 'global' : 'beta';
/** A private test lobby: shorter matches, so a playtest sees one end. */
export const TEST_LOBBY = !!TEST_ROOM;
/** A playtest player (?peer=<n>: Hawkes Gen's playtest.run with peers). */
export const PLAYTEST_PEER = params.has('peer') ? Number(params.get('peer')) || 0 : -1;

/** Online matches: 3 stocks and 5 minutes (test lobbies: 1 stock, 90 s). */
export const ONLINE_RULES = TEST_LOBBY ? { stocks: 1, minutes: 1.5 } : { stocks: 3, minutes: 5 };

let lobby: Lobby | null = null;
let mm: Matchmaker | null = null;

function me() {
  const p = profile();
  return { name: p.name, avatar: p.avatar, char: avatarChar(p.avatar), pid: profileId() };
}

function makeSetup(host: ReturnType<typeof me> & { id: string }, guest: ReturnType<typeof me> & { id: string }): OnlineSetup {
  const stages = stagesFor('versus');
  const seed = (Math.random() * 0x7fffffff) | 0;
  const entry = stages.length ? stages[Math.abs(seed) % stages.length] : null;
  return {
    matchId: `${host.id}-${guest.id}-${randomId(6)}`,
    seed,
    stage: entry?.index ?? 0,
    // The Versus version of the stage (a calm one keeps its hazards off).
    rules: entry?.entry.rules ?? {},
    stocks: ONLINE_RULES.stocks,
    timeLimit: Math.round(ONLINE_RULES.minutes * 60 * 60),
    ids: [host.id, guest.id],
    names: [host.name, guest.name],
    avatars: [host.avatar, guest.avatar],
    chars: [host.char, guest.char],
    pids: [host.pid, guest.pid],
    at: Math.floor(Date.now() / 1000),
  };
}

/** Joins the lobby (once). Safe to call before anything else is ready; failures only turn online off. */
export function startOnline(): { lobby: Lobby; mm: Matchmaker } | null {
  if (lobby && mm) return { lobby, mm };
  try {
    const p = profile();
    lobby = new Lobby(LOBBY_ID, { name: p.name, avatar: p.avatar });
    mm = new Matchmaker(lobby, { me, makeSetup, sameMachine: PLAYTEST_PEER >= 0 });
    onProfile((next) => lobby?.update({ name: next.name, avatar: next.avatar }));
    lobby.start();
    // The leaderboard refreshes in the background from Hawkes Net's records; its cached table is there already.
    leaderboard(LOBBY_ID).start();
    console.info(`[dod-online] joined lobby "${LOBBY_ID}" as ${p.name} (${lobby.id})`);
    return { lobby, mm };
  } catch (e) {
    netError('online: could not start (single player is unaffected)', e);
    lobby = null;
    mm = null;
    return null;
  }
}

export function onlineParts(): { lobby: Lobby; mm: Matchmaker } | null {
  return lobby && mm ? { lobby, mm } : null;
}
