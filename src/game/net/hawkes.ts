// Dose Of Destruction on Hawkes Net (docs/online.md; Hawkes Gen docs/net.md): the project, where this page runs and
// what its rooms are called. doseofdestruction.com plays in the live rooms; anywhere else (the beta site, localhost)
// in the test rooms ("t-..."), apart from the players; a playtest's ?room=<id> in a private test room of its own.

export const NET_PROJECT = 'doseofdestruction';
export const LIVE_HOSTS = ['doseofdestruction.com', 'www.doseofdestruction.com'];

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const onLiveHost = typeof location !== 'undefined' && LIVE_HOSTS.includes(location.hostname.toLowerCase());
/** Hawkes Net. Off the live site another one can be named: ?net=http://127.0.0.1:8786 or globalThis.DOD_NET_ENDPOINT
 *  (a Hawkes Net on this machine, for trying the network end to end before it's deployed), else the page's
 *  globalThis.HAWKES_NET_ENDPOINT (Studio sets it on the beta site: beta Hawkes Net, hawkesnet.hawkesgen.ai). */
const g = globalThis as { DOD_NET_ENDPOINT?: string; HAWKES_NET_ENDPOINT?: string };
const askedNet = String(g.DOD_NET_ENDPOINT ?? params.get('net') ?? g.HAWKES_NET_ENDPOINT ?? '');
export const NET_ENDPOINT = !onLiveHost && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(askedNet) ? askedNet : 'https://net.hawkesgen.ai';
/** A playtest's private room (?room=<id>: Hawkes Gen's playtest.run with peers), "" otherwise. */
export const TEST_ROOM = /^[A-Za-z0-9_.-]{1,24}$/.test(params.get('room') ?? '') ? (params.get('room') as string) : '';
/** On the game's own site: the live rooms and the live leaderboard. */
export const IS_LIVE = onLiveHost && !TEST_ROOM;

/** A room's full name here: "lobby" live, "t-lobby" in the test rooms, "t-<id>/lobby" in a playtest's own. */
export function roomName(area: string): string {
  if (TEST_ROOM) return `t-${TEST_ROOM}/${area}`;
  return IS_LIVE ? area : `t-${area}`;
}
