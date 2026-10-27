// Everything online, in one chunk that loads after the game has booted (net/loader.ts). main.ts and the playtest
// reach it only through the loader, so nothing in here (the relays, WebRTC, @noble's crypto, the online menus) can
// stop single player or window.hawkesPlaytest.

export { startOnline, onlineParts, PLAYTEST_PEER, TEST_LOBBY } from './online.ts';
export { OnlineFight } from './fight.ts';
export { sharedBoard } from './board.ts';
export { background } from '@hawkesgen/net';
export { profileId } from './profile.ts';
export { closeProfile, findMatch, initOnlineUi, openProfile } from '../ui/online.ts';
export { initLeaderboardUi, renderBoard, showRatingChange } from '../ui/leaderboard.ts';
