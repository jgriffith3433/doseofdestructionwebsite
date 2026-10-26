# Online play

J, 2026-10-18: "make the dose of destruction game multiplayer now. Make it work so all players join the same room and
there's a queue for them to play against other players. … Allow users to change their profile picture (use our
characters) and name. While players are waiting for a match they can play against CPU and play the game normally.
Once the match gets ready to start there should be an indicator … make it work on all platforms and without having to
join rooms make it work automatically."

Part 1 is the lobby, the queue, profiles and the online fight. Part 2 (J: "Make a leaderboard system too.") is the
leaderboard: signed results, Elo, the Leaderboard screen (below, "The leaderboard").

J, 2026-10-26: "completely switch Dose Of Destruction to Hawkes Net … fighting games need to have low latency and
"feel fair"." Everything online now runs on **Hawkes Net** (Hawkes Gen `docs/net.md`, project `doseofdestruction`):
the lobby, the match rooms and the leaderboard's store. The public Nostr relays and WebTorrent trackers are gone.

## Hard rules

- **Hawkes Net, nothing else.** The site is static on GitHub Pages; everything online goes through Hawkes Net
  (`https://net.hawkesgen.com`, the project `doseofdestruction`; pages are let in by origin, no key in the page).
  The lobby is one relay room; a match is a pair room that starts peer to peer (a direct WebRTC link between the
  two browsers) and moves to Hawkes Net's relay when they can't link; the leaderboard's results are Hawkes Net
  records. The SDK is a copy in `src/game/net/hawkes/` (Gen `clients/js/sdk.json`; `node bin/hawkesgen-sdk.mjs sync`
  in Gen rewrites it).
- **Beta apart from live.** Only doseofdestruction.com plays in the live rooms and writes the live leaderboard; the
  beta site and localhost use test rooms (`t-…`) and test records (`net/hawkes.ts`). `?net=http://127.0.0.1:8786`
  (off the live site) points a page at a local Hawkes Net (Gen `net/tools/net-dev.mjs`).
- **No codes, nothing to join by hand.** Every page joins the one global lobby on load.
- **Never block the game.** Everything online is asynchronous. If Hawkes Net can't be reached, the menu says
  so plainly and single player works as before.
- **Every network error is reported:** `console.error("[dod-online] …")` with context (`net/util.ts` `netError`), so
  the beta 🐞 capture and Studio's error reports pick it up. A leaderboard request that fails (and is retried) is a
  `console.warn`.

## Code

`src/game/net/`:

| File | What |
|---|---|
| `hawkes/` | the Hawkes Net SDK (a copy from Gen: `hawkes-net.mjs`, `hawkes-net-core.mjs`, types) |
| `hawkes.ts` | the project, the endpoint, live or test (`IS_LIVE`, `TEST_ROOM`), room names (`roomName`) |
| `util.ts` | ids, hashing, `netError`, a tiny emitter |
| `sign.ts` | signing keys and Schnorr-signed events (`@noble/curves`; Nostr's event shape, kept for the results) |
| `room.ts` | `PairRoom`: the match room on Hawkes Net (p2p first, relay fallback), messages and express frames |
| `lobby.ts` | presence: the lobby as one Hawkes Net relay room |
| `records.ts` | the leaderboard's store: Hawkes Net records (`/v1/net/records`) |
| `pairing.ts` | the pairing rule (pure) |
| `matchmaker.ts` | the queue: pairing, the handshake, the host's setup |
| `rollback.ts` | rollback netcode (pure) |
| `fight.ts` | one online fight: the `Match` through the rollback over the link; how it ends |
| `results.ts` | the match-result event |
| `profile.ts` | name and picture in localStorage; the profile key (the leaderboard's player id) |
| `ratings.ts` | the leaderboard's rules (pure): result bodies, signatures, what counts, dedupe, Elo, the table |
| `board.ts` | the leaderboard's data: results to and from Hawkes Net's records, the localStorage cache, the outbox |
| `online.ts` | wiring: which lobby, the online rules, `startOnline()` |
| `entry.ts` | the online chunk: everything `main.ts` and the playtest use, re-exported |
| `loader.ts` | loads `entry.ts` after boot (`bootOnline`, `onlineApi`, `onlineReady`) |

The UI is `src/game/ui/online.ts` (lobby strip, Find match, the searching chip, the match-found banner, Profile),
`src/game/ui/leaderboard.ts` (the Leaderboard screen, the rating line on the results, the Profile stats) and the
markup in `Game/index.html`; `main.ts` runs the online fight in the match loop.

**Online never stops the game.** `main.ts` and `playtest/dod.ts` import no online code (types only): `main.ts`
installs `window.hawkesPlaytest` and boots single player, then `bootOnline()` imports `net/entry.ts` on the next
task and starts the lobby, the online menus and the leaderboard, each on its own guard. A failure (a package not
installed, Hawkes Net unreachable, a menu that throws) goes to `console.error("[dod-online] …")` and the game plays on without
online; on the dev server, Vite's error overlay for the online chunk is taken down so it can't cover the menus.
Keep it that way: a new static import of `net/` or `ui/online|leaderboard` from `main.ts` or `dod.ts` brings back
beta's "page never exposed window.hawkesPlaytest" (2026-10-18).

## The lobby

- On load the page joins the lobby: one Hawkes Net room (`lobby/global` live, `t-lobby/beta` on beta; relay only,
  up to 1,000 players). Presence is a message `p` with `{ id, n: name, a: picture, s: idle | queued | in-match | left,
  q: when the search started }`, sent to the room and to each newcomer when they join. Hawkes Net says who is in the
  room, so a closed tab is gone as soon as its connection is (no expiry to wait out).
- Each tab has its own id (sessionStorage), so two tabs are two players and a reload keeps the id.
- Presence goes out at once on a change (at most one per 1.2 s) and every 20 s (8 s while searching) as a heartbeat.
  Leaving the page sends `left` and leaves the room.
- The main menu shows "N online" (a green dot when the lobby is reached) and up to 8 other players with their
  picture, name and "searching" / "in a match". "Connecting…" while it joins; "Offline: the lobby is unreachable from
  this network" if it isn't in after 10 s (the SDK keeps reconnecting and it recovers).
- The lobby is relay only, no WebRTC. Only the two players of a match link.
- `?room=<id>` puts the page in a private test lobby `test-<id>` (the two-tab playtest). Test lobbies play 1 stock,
  90 s matches so a playtest sees an end.

## Profile

- A name and a picture, which is one of our fighters (`content/fighters.json`); online you fight as your picture.
- Default: a generated show-crowd name ("Neon Rookie 42") and a random fighter. Kept in localStorage `dod.profile`.
- Main menu → **Profile**: a name field (2–16 characters: letters, digits, spaces and `- _ . '`, after NFKC; anything
  else is dropped; an unusable name keeps the old one), **Random name**, and a grid of every fighter's face.
  Save sends it to the lobby at once.
- Pictures are round head crops, `characters/head/<id>.webp` (square, 128 px), cut from the large image by
  `node tools/heads.mjs` at the face box in `content/heads.json` (centre and side, as fractions of the image height).
  Every round avatar (Profile, the online list, Match found, the HUD badge, the Leaderboard) uses them with plain
  `object-fit: cover`, so the face is centred in every browser. A new or recut fighter: run `node tools/heads.mjs
  --only <id> --sheet sheet.png`, look at the sheet, tune its box, run again; `npm test` fails until it has one.
- Names and pictures from other players are cleaned the same way (`cleanName`, `cleanAvatar`) before they show.

## Pairing

- **Find match** (main menu) puts you in the queue. The chip at the top left says "Searching for opponent… 0:42 ·
  Cancel" on every screen, in menus and in matches (menu screens start below it while it is up, so it never covers
  their Back button), while you play anything you like (CPU versus, training, the
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

## The match room

- `room.ts` joins the Hawkes Net room `m/<a hash of the pairing>` (pair topology, 2 players, transport `auto`): it
  starts **peer to peer**, a direct WebRTC link between the two browsers (the shortest path, no hop through us), and if
  the two can't link (strict or symmetric NATs, carriers, offices) Hawkes Net moves the room to its **relay** on the
  same connections. Before, those two players could never play each other; now they can, at a relay hop's cost.
- The two say who they are (`~hi`, the lobby id) and then send:
  - **game messages** (`g`, reliable and in order): hello/ok/setup, go, the signed start and result, desync hashes, quit;
  - **express frames** (Hawkes Net's: binary, unreliable, sent and forwarded at once, no 33 ms bundling): the fight's
    inputs and a ping every second. On a direct link they ride their own unordered, no-retransmit data channel, so a
    lost packet never holds up the next one; on the relay the node forwards each the moment it arrives.
- The round trip shown in the HUD is measured over the express path, the inputs' own.
- 6 s with nothing from the other side, or the room closing, ends it as a lost link.

## The fight

- **Rollback netcode** (`rollback.ts`): the sim is integer-only and its whole state saves and restores
  (`Match.snapshot()` / `restore()`, which include the stats), so each side runs at full speed on its own input and a
  guess of the other's (their last one). When the real input arrives and the guess was wrong, it goes back to that
  frame and runs forward again. Sounds and effects come only from frames run the first time.
  - Input delay 2 frames; rollback window 8 frames past the last frame both inputs are known for. Further ahead the
    side waits ("Waiting for <name>… 3 s" after 1.5 s): a lag spike stalls the match instead of drifting. After 20 s
    with no inputs (their page still there) it ends as a lost link.
  - **A hidden page keeps playing.** Browsers stop animation frames for a hidden tab, a minimised window and a window
    covered by another, which stopped that side's inputs and froze the other player (J, 2026-10-26: two windows on
    one machine). During an online match a worker's timer (not throttled) runs the loop at 60 Hz, unrendered, whenever
    frames stop for 100 ms (`main.ts`, the background ticker).
  - Time sync: each packet carries how far ahead its sender runs; the side further ahead skips a frame now and then.
  - Packets: every frame, as an express frame, every local input the other side hasn't acknowledged (so a lost packet
    costs nothing), plus an ack and the frame number. Binary (`encodePacket`: varints, inputs run-length coded): about
    13 bytes where the JSON was 85.
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
  the room closes) ends it: "Connection lost … The win is yours."
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

`{ matchId, self, players: [{ id, pid, name, avatar, fighter }] (by slot, 0 hosts; pid is the profile id), winner:
id | null, reason: game | time | forfeit | disconnect | desync | no-start, stage, frames, durationMs, endedAt, stocks }`.
It is also logged as `[dod-online] match result {…}`. The leaderboard doesn't trust this event: it counts the signed
result the fight produces (`FightEnd.rated`, next section).

## The leaderboard

J, 2026-10-18: "Make a leaderboard system too." Results are signed by the players and kept as Hawkes Net **records**
(Gen `docs/net.md`, "Records"; until 2026-10-26 on public Nostr relays). Hawkes Net only stores them; every page
builds the table itself from them with the same code, so every device shows the same one.

**Who is who.** The profile gets a signing key (secp256k1, localStorage `dod.profile.key`, made on first visit); its
public key is the player's **profile id**. Lobby ids stay per tab; the profile id is per browser, so a rating
survives visits (and two tabs of one browser are one profile: their matches aren't rated). The handshake's `hello`
carries it and the host's setup lists both (`pids`) with the setup time (`at`); the guest checks its own is there.

**Signing a result** (`fight.ts`, rules in `ratings.ts`):
- When a page has loaded the match it signs the **start** (match id, both profile ids, fighters, stage, time) and
  sends it to the other (`ss`). It proves that player was in the match.
- At the end each page signs the **result**: match id, both ids, the winning slot (-1 draw), fighters, stage, frames
  played, the setup time and how it ended (`game`, `time`, or `left`), and sends its signature (`rs`). Both bodies are
  the same (the fight ends on the same frame on both sides), so both pages end with the same record carrying both
  signatures (`kind: full`). A Schnorr signature is made once per body, so the two copies match byte for byte.
- **Leaving**: Leave match (or closing the tab) signs the player's own loss (`left`) before it sends `quit`, so a
  forfeit is normally fully signed. A lost link, or a loser who never signs, is a `left` result signed by the winner
  alone plus the leaver's start signature (`kind: claim`): it counts as a loss for the leaver, marked `left`.
- Void ends (desync, no start) aren't rated. The end waits up to 6 s for the other signature.

**Publishing.** A page publishes its record as a signed event (Nostr's shape: kind 30078, `d` =
`hawkes-dod/result/<match id>`, tag `hawkes-dod/results/<lobby>`; test lobbies have their own table) signed with its
profile key, with the publisher's name and picture (`me`) and the opponent's as seen (`o`, used only until that
player's own arrives), to Hawkes Net's records (`POST /v1/net/records`, one kept per match and publisher; off the live
site as test records). Both players publish, so one missing still leaves the other. If Hawkes Net can't be reached it
waits in an outbox (cached) and goes out later. Pages read the tag's records every 30 s (`records.ts`).

**What counts** (`ratings.ts`, the same on every client):
- Signatures checked: a `game`/`time` result needs both; a `left` one needs the winner's and the leaver's (on the
  result, or on the start). A bad signature, a malformed field, the same profile on both sides, or a time before
  2026-10-01 is ignored (and a result stamped over an hour ahead waits for its time).
- **One result per match id**: a fully signed one wins over claims; two claims that disagree (both sides say the
  other dropped, which a real network drop does) void the match.
- **The same two players count 5 rated matches a UTC day** (`PAIR_PER_DAY`); later ones that day don't count at all.
- **Elo**: everyone starts at 1000, K = 32, results applied in order of their setup time (ties by match id). The
  expected score comes from an integer table (the FIDE way: rating difference → percent), so no floating point
  differs between browsers; changes are zero-sum (+16 / −16 between two new players). A draw on time is half a win.
- Per player: rating, wins, losses, draws, the current streak, the favourite fighter (played most; ties: last
  played). Rank: rating, then wins, then fewer losses, then id.
- **Weekly**: the same rules over results since Monday 00:00 UTC, from a fresh 1000.

**Fast and offline-safe** (`board.ts`): the counted results, names and the outbox are cached in localStorage
(`dod.board.<lobby>`, newest 3000), so the table shows at once and offline. On load it subscribes for results
since a day before the newest it has; new events are checked a dozen at a time between frames, so nothing blocks the
game. The table is recomputed only when results change.

**Screens**:
- Main menu → **Leaderboard** (its line shows "You: #3 · 1016 · 4–2"): This week / All time, the top 100 with rank,
  picture, name, rating and W–L, your row highlighted (and pinned at the bottom with your rank, or "Unranked", only when it isn't in the list), and a
  status line (Live / Saved results · updating… / Offline: showing the results this device has saved). Fits phones in
  portrait and landscape.
- The online results: "Rating 1016 +16 · <name> 984 (−16)" once both signatures are in ("confirming the result with
  <name>…" before). A result only we signed (we left) shows the expected change with "Counts once <name>'s copy
  reaches the board." Unrated matches say why (void, same profile, the day's limit for the pair).
- Profile: "Rating 1016 · #3 all time · 4–2 · 3 wins in a row · mostly Break".

**Limits**: with no server a cheat can't win a match they didn't (the loser's key never signs it), but they can void
one they lost (refuse to sign and claim the other left: two claims void). Keys live in one browser: clearing site data
starts a new profile at 1000, and many fresh profiles can farm one another (the pair limit slows it). Results from
the Nostr days (before 2026-10-26) live only in the players' caches.

## All platforms

- Desktop, phone and tablet in Chrome, Safari and Firefox: WebSocket, WebCrypto and WebRTC data channels are all the
  game needs. Touch controls work online as offline; the chip, banner and Profile fit portrait and landscape.
- Two players whose networks refuse a direct link play over Hawkes Net's relay (a hop through net.hawkesgen.com: a
  few ms to tens of ms more each way, depending on where they are). A browser without WebRTC plays on the relay too.
- Hawkes Net's limits for the project are in Gen `net/projects.json` (`doseofdestruction`: 120 messages and 300 express
  frames a second per player, 10,000 players).
- Everything a page sends can still be faked (a name, a result). Names and setups are cleaned and checked; results
  count only with the players' signatures.

## Checks

- `npm test` runs `src/game/test/net.test.ts`: pairing (300 random queues: everyone agrees, nobody is in two, the
  older hosts, skips), the rollback over a simulated network (delay, jitter, 8% loss, a 0.7 s spike, one clock 1%
  fast: no desync, hashes compared all along, the stall works, clocks stay together), a full match ending identically
  on both sides, and a drifting sim caught by the hash on both sides.
- `npm test` also checks the binary input packet (`encodePacket` / `decodePacket`).
- `node tools/online-live.test.ts` (with `npm i --no-save node-datachannel@0.33.4`) starts a Hawkes Net in the process
  from the Gen checkout (`HAWKESGEN`, default `C:/Projects/hawkesgen`) and runs two players over it and WebRTC: both see
  "2 online", a rename shows for the other, both queue and pair, the fight plays to the same end on both over a direct
  link with the inputs as express frames, both go back to idle. `NO_LINK=1` runs it with no WebRTC: the match must go
  on the relay.
- `npm test` also runs `src/game/test/ratings.test.ts`: signatures (a changed field, a swapped key, one signature,
  a bad one), `left` claims (with and without the leaver's start; disagreeing claims void), dedupe (both copies count
  once, a full result beats a claim, the pair-per-day limit), Elo (the table, zero-sum, the same table from the same
  results in any order and with repeats, streaks, favourites, +16/−16) and the weekly table.
- `node tools/online-live.test.ts` also checks both sides end with the same fully signed result, and a third page that
  only reads builds the same table from Hawkes Net's records.
- The playtest scenario `online` (Hawkes Gen `playtest.run` with `peers: 2`): see AGENTS.md. After the match each
  peer checks its rating change and the Leaderboard (both tabs: winner #1 at 1000 + d, loser #2 at 1000 − d).
