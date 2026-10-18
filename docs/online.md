# Online play

J, 2026-10-18: "make the dose of destruction game multiplayer now. Make it work so all players join the same room and
there's a queue for them to play against other players. … Allow users to change their profile picture (use our
characters) and name. While players are waiting for a match they can play against CPU and play the game normally.
Once the match gets ready to start there should be an indicator … make it work on all platforms and without having to
join rooms make it work automatically."

Part 1 (this) is the lobby, the queue, profiles and the online fight. Part 2 is the leaderboard: it listens on the
match-result event (below).

## Hard rules

- **No server of ours.** The site is static on GitHub Pages. Presence and signalling go through free public relays
  (Nostr relays; WebTorrent trackers as a fallback for a match's signalling); the fight is a direct WebRTC data
  channel between the two browsers. Nothing we host, nothing that needs a key.
- **No codes, nothing to join by hand.** Every page joins the one global lobby on load.
- **Never block the game.** Everything online is asynchronous. If the relays or WebRTC can't be reached, the menu says
  so plainly and single player works as before.
- **Every network error is reported:** `console.error("[dod-online] …")` with context (`net/util.ts` `netError`), so
  the beta 🐞 capture and Studio's error reports pick it up. Relay refusals (rate limits, policies) are a
  `console.warn`, once per relay and reason.

## Code

`src/game/net/` (the network code is adapted from Yooba Land's `Tools/Web/net/src`, copied, not depended on):

| File | What |
|---|---|
| `util.ts` | relays, trackers, STUN servers, sealing, `netError`, a tiny emitter |
| `nostr.ts` | one pool of Nostr relay sockets per page; Schnorr-signed events (`@noble/curves`) |
| `tracker.ts` | WebTorrent trackers as a message bus (fallback signalling) |
| `link.ts` | one WebRTC link: a reliable channel (events, hashes) and an unreliable one (inputs) |
| `room.ts` | `PairRoom`: the two players of a match find each other and link (Yooba Land's room, cut down to a pair) |
| `lobby.ts` | presence: the global lobby as Nostr beats |
| `pairing.ts` | the pairing rule (pure) |
| `matchmaker.ts` | the queue: pairing, the handshake, the host's setup |
| `rollback.ts` | rollback netcode (pure) |
| `fight.ts` | one online fight: the `Match` through the rollback over the link; how it ends |
| `results.ts` | the match-result event |
| `profile.ts` | name and picture in localStorage |
| `online.ts` | wiring: which lobby, the online rules, `startOnline()` |

The UI is `src/game/ui/online.ts` (lobby strip, Find match, the searching chip, the match-found banner, Profile) and
the markup in `Game/index.html`; `main.ts` runs the online fight in the match loop.

## The lobby

- On load the page publishes a presence **beat** on the public Nostr relays: a NIP-78 app-data event (kind 30078,
  replaceable per key, NIP-40 expiration), tagged `hawkes-dod/lobby/global`, content
  `{ id, n: name, a: picture, s: idle | queued | in-match | left, q: when the search started }`.
- Each tab has its own id and signing key (sessionStorage), so two tabs are two players and a reload keeps the id.
- Beats go out every 20 s (8 s while searching) and at once on a change (at most one per 1.2 s). A player counts
  while their last beat is under 60 s old; a searching player is pairable while it's under 25 s old, so a closed tab
  stops being paired quickly. Leaving the page publishes a `left` beat.
- The main menu shows "N online" (a green dot when the lobby is reached) and up to 8 other players with their
  picture, name and "searching" / "in a match". "Connecting…" while the relays open; "Offline: the lobby is
  unreachable from this network" if none opens in 10 s (it keeps trying and recovers).
- The lobby is only beats, no WebRTC, so it holds any number of players. Only the two players of a match link.
- `?room=<id>` puts the page in a private test lobby `test-<id>` (the two-tab playtest). Test lobbies play 1 stock,
  90 s matches so a playtest sees an end.

## Profile

- A name and a picture, which is one of our fighters (`content/fighters.json`); online you fight as your picture.
- Default: a generated show-crowd name ("Neon Rookie 42") and a random fighter. Kept in localStorage `dod.profile`.
- Main menu → **Profile**: a name field (2–16 characters: letters, digits, spaces and `- _ . '`, after NFKC; anything
  else is dropped; an unusable name keeps the old one), **Random name**, and a grid of every fighter's thumb.
  Save sends it to the lobby at once.
- Names and pictures from other players are cleaned the same way (`cleanName`, `cleanAvatar`) before they show.

## Pairing

- **Find match** (main menu) puts you in the queue. The chip at the top left says "Searching for opponent… 0:42 ·
  Cancel" on every screen, in menus and in matches, while you play anything you like (CPU versus, training, the
  campaign). Cancel leaves the queue.
- **The rule** (`pairing.ts`): the queue sorted oldest first (time queued, ties by id) is paired off in twos down the
  list; the older of a pair hosts (slot 0). Everyone runs it on their own view of the lobby, so both sides of a pair
  pick each other without asking anyone. `pairFor` skips players this one recently failed to reach.
- **The handshake** (`matchmaker.ts`): the pair opens a match room named after both ids and both search times, links,
  and each sends `hello` ("I'm search q, I paired with your search you"). Each checks the hello names its own current
  search and the one it paired with, then answers `ok` (a promise: it pairs with nobody else until this resolves) or
  `no`. With both oks the pair is **committed**: both show "in a match" in the lobby and the host sends the `setup`
  (match id, seed, a Versus stage, stocks, time limit, both names, pictures and fighters). The guest checks the
  setup before using it.
  - No double pairing: a pair is real only with two promises, and a player holds one at a time.
  - Views that disagree for a moment cost a retry, not a mistake: an unpromised pairing follows the queue if it changes.
- **Timeouts and retries**: no link in 20 s → that player is skipped for 90 s and the search goes on ("Couldn't
  connect to <name>. Still searching…"); a `no` or a vanished partner → skipped 3 s. Two failed links in a row add
  "this network may block player links" to the chip.
- **Match found**: a banner over whatever is on, "Match found · vs <name>" with their picture and "Starting in 5… 4…",
  the announcer's "We have a challenger on the line!" (`announcer.match-found`; Find match plays "Calling all
  challengers!", `announcer.searching`) and a tick each second. Cancel on the banner backs out; the other player gets
  "<name> backed out. Back in the queue." and keeps their place. At 0 the current game ends (a campaign scene, a CPU
  match, a menu) and the online match loads with the VS screen (names under the fighters).

## The fight

- **Rollback netcode** (`rollback.ts`): the sim is integer-only and its whole state saves and restores
  (`Match.snapshot()` / `restore()`, which include the stats), so each side runs at full speed on its own input and a
  guess of the other's (their last one). When the real input arrives and the guess was wrong, it goes back to that
  frame and runs forward again. Sounds and effects come only from frames run the first time.
  - Input delay 2 frames; rollback window 8 frames past the last frame both inputs are known for. Further ahead the
    side waits ("Waiting for <name>… 3 s" after 1.5 s): a lag spike stalls the match instead of drifting.
  - Time sync: each packet carries how far ahead its sender runs; the side further ahead skips a frame now and then.
  - Packets: every frame, over the unreliable channel, every local input the other side hasn't acknowledged (so a lost
    packet costs nothing), plus an ack and the frame number.
  - **Desync check**: every 30 frames both inputs are known for, each side hashes its state (`hashState`) and sends it
    on the reliable channel. A different hash ends the match as void ("Match void … a desync. It has been reported.")
    and `console.error`s both hashes and the frame.
- **Starting**: both pages load the match, say `go`, and run Ready… Go! from when both have. A page that doesn't start
  within 45 s voids the match.
- **Ending**: the sim's game over is final only on a frame both inputs are known for, and the sim stops there, so both
  sides end on the same frame with the same winner. Each keeps sending its last inputs for 5 s so the other can
  confirm, then hangs up.
- **Leaving and disconnects**: Esc (or the pause button) opens the menu over the match, which goes on (your fighter
  stands still); "Leave match (you lose)" forfeits. Closing the tab forfeits too. A link that drops (6 s silent, or
  WebRTC says failed) ends it: "Connection lost … The win is yours."
- The HUD shows each player's name with their fighter ("Neon Rookie 42 · Break") and their picture on the card; a
  small line under the top shows the round trip and the longest rollback.
- **Results**: the usual results screen with "You win" / "<name> wins" (or why it ended early), then **Queue again**
  (back to the menu and straight into the queue) or Main menu.
- Online matches: 3 stocks, 5 minutes, a random Versus stage (its Versus rules), no pause.

## The match-result event (the leaderboard's hook)

Every online match that ends fires once on each player's page, with the same `matchId` on both:

```ts
import { onMatchResult } from './net/results.ts';
onMatchResult((r) => { /* r: MatchResult */ });
// or: window.addEventListener('dod:match-result', (e) => e.detail)
```

`{ matchId, self, players: [{ id, name, avatar, fighter }] (by slot, 0 hosts), winner: id | null, reason: game | time
| forfeit | disconnect | desync | no-start, stage, frames, durationMs, endedAt, stocks }`. It is also logged as
`[dod-online] match result {…}`. A `disconnect` is claimed by whoever is still connected on their own page; the
leaderboard should count only results both pages agree on (or ignore disconnects).

## All platforms

- Desktop, phone and tablet in Chrome, Safari and Firefox: WebSocket, WebCrypto and WebRTC data channels are all the
  game needs. Touch controls work online as offline; the chip, banner and Profile fit portrait and landscape.
- **Limits**: no TURN server (none is free and keyless). Two players whose networks both refuse a direct link (strict
  or symmetric NATs, some carriers and offices) can't play each other: the search says it couldn't connect and keeps
  looking for someone else. A browser without WebRTC (some in-app webviews) can't link; it says so and stays single
  player. Public relays can rate-limit or refuse events (seen: relay.damus.io rate-limiting this server's IP after
  heavy testing; offchain.pub refusing keys outside its web of trust, removed from the list); the pool uses five at
  once so one refusing doesn't matter.
- With no server everything a page sends can be faked (a name, a result). Names and setups are cleaned and checked;
  results are claims from each page.

## Checks

- `npm test` runs `src/game/test/net.test.ts`: pairing (300 random queues: everyone agrees, nobody is in two, the
  older hosts, skips), the rollback over a simulated network (delay, jitter, 8% loss, a 0.7 s spike, one clock 1%
  fast: no desync, hashes compared all along, the stall works, clocks stay together), a full match ending identically
  on both sides, and a drifting sim caught by the hash on both sides.
- `node tools/online-live.test.ts` (with `npm i --no-save node-datachannel@0.33.4`) runs two players over the real
  public relays and WebRTC: both see "2 online", a rename shows for the other, both queue and pair, the fight plays to
  the same end on both, both go back to idle.
- The playtest scenario `online` (Hawkes Gen `playtest.run` with `peers: 2`): see AGENTS.md.
