# Dose Of Destruction

Platform fighter with every main IP character (doseofdestruction.com). The game is `Game/index.html` +
`src/game/`; content is `content/*.json`; devtools are `/devtools.html` on the dev server (`auto-start.bat`,
port 8089). Docs are in `docs/`. Check with `npm test` (sim) and `npm run typecheck`. Pushing `main`
deploys the live site (GitHub Actions `pages.yml`): don't commit or push unless asked.

## Online

Online is always on (docs/online.md): every page joins one global lobby on load (Nostr presence beats on public
relays, no server of ours, no codes), the main menu shows "N online" and who, **Find match** queues (the player keeps
playing anything meanwhile under a "Searching for opponent…" chip), a pair is made by a deterministic rule plus a
handshake, and the fight runs the sim through rollback netcode over a WebRTC data channel, with a desync hash. The
code is `src/game/net/` (adapted from Yooba Land's `Tools/Web/net/src`, copied, not depended on) and
`src/game/ui/online.ts`. **Profile** is a name and a fighter picture (localStorage `dod.profile`); online you fight as
your picture. Every finished online match fires the match-result event (`net/results.ts` `onMatchResult`,
`window` `dod:match-result`). **Leaderboard** (menu): both players sign each online result with their profile key
(localStorage `dod.profile.key`), it goes on the same relays, and every page builds the same Elo table from the signed
results (`net/ratings.ts` rules, `net/board.ts` relays + cache, `ui/leaderboard.ts`). `?room=<id>` is a private test
lobby (and its own leaderboard). Network errors go to
`console.error("[dod-online] …")`. `npm test` covers pairing, the rollback and the rating rules; `node tools/online-live.test.ts`
checks the real network from Node, signed results included.

## Library (Hawkes Gen)

Dev Tools → **Library** shows every fighter in Hawkes Gen's library (`hawkesgen/docs/library.md`), the same one
Studio, the other products and Claude use. Each slot keeps every version:
- the slots: concept, reference, side, `pose/<name>`, `clip/<name>`
- what you can do: pick, discard, note, revise with feedback, make more takes

The recipes are DoD's tuned settings, in `hawkesgen/presets/doseofdestruction.json` under `kinds.fighter`.

`hawkes.library.json` says which `AllTheCharacters` file is which slot.
- **Import from AllTheCharacters** brings folders in. It's safe to run again.
- A pick is written back to the fighter folder ("Write picks back", or **Write back**), so the game and the other
  tabs keep reading the folders.
- From a terminal: `node C:/Projects/hawkesgen/bin/hawkesgen-folders.mjs status|import|export hawkes.library.json [--only Break] [--dry]`.

The web components are a copy of Hawkes Gen's (`src/devtools/hawkesgen/`; copy them again when Gen's change). They
call Gen through this dev server (`/api/dev/gen/v1/...`), which adds the key.

## Playtests

The game implements the Hawkes playtest contract v1 (`window.hawkesPlaytest`; spec in
`hawkesstudio/docs/playtest.md`). The code is `src/game/playtest/`: `hawkes-playtest.js` is a copy of
`hawkesstudio/clients/web/hawkes-playtest.js` (update it from there, don't edit it here), and `dod.ts` has
the scenarios. The bot plays through real input: menus are clicked, pause is the Esc key, and in a match
the CPU bot (`src/game/ai/bot.ts`, level 9) drives your fighter through a virtual pad that the input layer
(`input/devices.ts`) reads like a gamepad. It never edits sim state. Nothing runs unless a scenario starts.

| Scenario | What it does |
|---|---|
| `smoke` (~50 s) | Title → Versus → a 1v1 picked from the seed → fight 20 s of game time → Esc → Quit to the menu. |
| `match` (~2.5 min) | A full 1v1 versus a CPU, 2 stocks, no time limit, to the results screen; then the "How was that fight?" card appears and is dismissed, and the analytics events (screen, fighter_pick, stage_pick, level_start, death, level_end) are logged going out with the build and env. Outcome won/lost. |
| `campaign` (≤10 min) | The campaign from chapter 1: dialogue, fights, outros. Two tries per chapter; stops cleanly at 9.5 min. Option `chapter` (or the contract's `at`): a chapter id from `content/campaign.json` (`{"chapter":"encore"}`); setup shortcut: every chapter before it is marked cleared (localStorage `dod-campaign`), the bot opens it on the map by id (`data-chapter`) and plays on from there; the player's progress is put back at the end. An unknown id is a `bug` problem and the run ends `error`. On the map it first checks the season headings (each `Season N` over its chapters, as `season` in campaign.json places them) and that the map doesn't overflow the window sideways (on 720p and up, Season 1 fits on screen): events `season`, `map-fit`. Events `chapter`, `chapter-cleared`, `chapter-failed`; after a season's last chapter, `season-end` (the end line shown under it on the map). Season 2 starts at `{"chapter":"title-defense"}`; its end line, `{"chapter":"sponsored"}`. |
| `sound-settings` (~2 min) | Studio standard: taps the Tap to play prompt (hit-tested pointer press), checks the AudioContext runs and the menu music starts, Settings from the main menu (Sound off, Music 40%), reloads the page (the run carries on via `sessionStorage`), checks the choice came back, then Settings from Pause in a match. Puts the player's `hawkes.sound` back. |
| `site-links` (~1 min) | Checks the game screen has no site marks, then opens the website over the game in a full-screen frame and walks it by its own links (landing → footer Characters → a fighter card → Privacy → What's new), checking "Powered by HAWKES GEN" → https://hawkesgen.com on each page (and on every fighter page, read), and Hawkes Biomedical → https://hawkesbiomedical.com on the landing page. External links are checked, not followed. |
| `online` (~6 min, `peers: 2`) | Two tabs in a private test lobby (`?room=<id>&peer=0/1`, which Hawkes Gen's `playtest.run` adds): both see "2 online" with no clicks; peer 1 renames itself to "Tester Two" with a new picture in Profile and peer 0 sees it; peer 0 presses Find match and plays a CPU versus match under the searching chip; peer 1 queues 30 s later; both see "Match found vs <name> · Starting in N", fight each other (bot on each pad; test lobbies play 1 stock, 90 s), names on the HUD, and see the result with Queue again, then the rating change on it (confirmed by both) and the Leaderboard, both tabs, with both players at the ranks and ratings the result implies. Events `lobby`, `profile`/`profile-seen`, `queued`, `cpu-while-searching`, `match-found`, `online-start`, `online-result`, `rating-change`, `leaderboard`, `leaderboard-relay`; metric `ratingChange`. Without `?room` it stops (never pairs with real players). |
| `ko-objective` (~2–4 min) | The `ko` chapter objective (Season 2's Ratings rule), with no chapter yet. Setup shortcut: straight into two campaign fights on Yo House. Round 1, Exit Punk vs Kaelen (CPU 1, every life at 120%), 3 KOs before 2 minutes: ends on the third KO. Round 2, vs a giant Break (CPU 9), 20 seconds: ends on time. Checks the "KOs 0/3" chip and the clock, each count up, and the results line. Events `round`, `ko-chip`, `ko-clock`, `ko-count`, `ko-result`. |
| `roster` (~8 min; 13 min in headless software rendering) | Setup shortcut: each fighter goes straight into training (no menus) and does all 14 moves from their inputs. |

Every page load starts behind the studio's full-screen Tap to play prompt (`#tap-to-play` in `Game/index.html`; its
inline script unlocks sound even before the module loads); scenarios tap it first. Sound settings are the studio
standard: `localStorage["hawkes.sound"]` = `{ on, music, sfx }` (`src/game/soundSettings.ts`); Effects also drives voices.

Reported: metrics `kos`, `falls`, `damageDealt`, `damageTaken` (percent), `matchSeconds`, `stocksLeft`,
`wins`/`losses`, `chaptersCleared`, plus fps; events `match-start`, `ko`, `match-end`, `chapter`,
`chapter-cleared`; problems for missing images, clip sheets, sounds and voice files (404s), fighters without
clips or with stand-in clips, unrecorded voice lines, unpainted stage layers, stages without music, NaN
positions, a fighter out of bounds without a KO, a stopped match clock, 30 s with no hits, and moves that
don't come out.

Run one: start the dev server and open `http://localhost:8089/Game/?playtest=smoke` (also `&seed=2`,
`&speed=2` for up to 4x sim speed). In the console, `hawkesPlaytest.state()` while it runs and
`hawkesPlaytest.report()` when it ends. Hawkes Gen's `playtest.run` does the same and records it.
Headless Chromium renders in software here (~6–10 fps), so the sim runs at about half speed and the
campaign gets through 2–3 chapters in its budget.

## Analytics

Hawkes Analytics (`hawkesgen/docs/analytics.md`) is the only analytics here; never add another tracker. The SDK is
`site/hawkes-analytics.js`, a copy of `hawkesgen/clients/js/hawkes-analytics.js` (copy it again when Gen's changes;
types: `src/game/hawkes-analytics.d.ts`). Every player-facing page loads it with `data-product="doseofdestruction"`:
`Game/index.html` (before the game module) and every site page (`/site/build.js` first, then the SDK, above
`site.js`; a new page copies those lines). `devtools.html` never loads it. The privacy page says what is collected
(anonymous gameplay statistics, no cookies, no personal data, no IP stored): keep it true when events change.

**Build:** `tools/buildStamp.mjs` makes `{ version, commit, date }`: version from `releases.json` `current` (else
package.json), commit from `DOD_BUILD_COMMIT`/`GITHUB_SHA` (pages.yml passes it) else `git rev-parse`, date = build
time. The game gets it as the Vite define `__DOD_BUILD__` (analytics.ts sets `window.HAWKES_BUILD`); the site pages
get `dist/site/build.js` (pages.yml and Studio's beta build copy `dist/` over `site/`; the dev server serves it).

**The game's events** all go through `src/game/analytics.ts` (nothing else calls `window.hawkesAnalytics`), at real
moments only, never per frame:

| Event | When (where it's called) | Props |
|---|---|---|
| `screen` | every screen switch (`ui/screens.ts` `show`) | ids: title, main, select, stages, versus, campaign, dialogue, howto, results, match, leaderboard |
| `game_ready` | the title screen first shows (main.ts `titleUp`) | |
| context | `mode` (versus, training, campaign, online), `fighter`, `opponent` (`a+b` for several), `stage`, `chapter`, `level`; match keys clear on menu screens, mode on title/main | |
| `feature` `fighter_pick` | Fight on the select screen, one per person's slot | `value` fighter id, `mode`, `vs`, `cpu_level`, `players` |
| `feature` `stage_pick` | a stage card | `value` stage id, `mode`, `random` |
| `level_start` / `level_end` | each match from its Ready (`beginReady`) to its end; level = chapter id in the campaign, else the mode | end: `result` complete (won) / death (lost) / quit / restart, `won`, `match_seconds`, `stocks_left`, `damage_dealt`/`damage_taken` (percent), `kos`, `deaths` (the player's falls), `reason` |
| `death` | every KO in the match (`matchEvents`, from the sim's events) | `cause` = the attacker's move (`fsmash`, `nair`…; `fall` for a self-destruct, `hazard`), `victim` (you, cpu, opponent, dummy, player), `fighter`, `by`, `by_role`, `stage`, `percent`, `x`, `y`, `at` |
| `run_start` / `run_end` | a campaign run: the first chapter played from the map until the main menu (or every chapter cleared) | `from`, `cleared`, `result` win / lose / quit, `duration` |
| `progress` | a chapter cleared for the first time | `step` (chapters done), `of`, `label` (the chapter it unlocks, or `complete`) |
| `video` | each campaign scene (`<chapter>.intro`/`.outro`) | `action` complete / skip, `line`, `of` |
| `feature` `settings.sound` / `settings.music` / `settings.sfx`, `settings_open` | Settings changes (sliders on release), M key | `value`, `from` menu / pause / key_m |
| `pause`, `quit_to_menu` | Esc/Start into Pause; Quit from Pause | `mode`, `stage`, `at`, `to` |
| `feature` `controls_keyboard` / `_gamepad` / `_touch` / `_mouse` | the first use of each in a session | |
| `feature` `find_match`, `profile_open`, `profile_save` | the online menu items; Save in Profile (`value` = the picture's fighter; never the name) | |

`death` counts every KO (filter `victim=you` for the player's own); `level_end` `deaths` is the player's falls.

**Feedback cards** (`ask`, styled in the game's colours): "How was that fight?" (thumbs + comment, id `after-match`)
on a versus or online match's results; "Rate tonight's episode: <title>" (stars + comment, id
`after-episode-<chapter>`) on the campaign map after an episode's outro. Never during a match: `matchStart` removes a
card still up. The card's focus goes back to the screen, so Enter still does what the screen says.

**Playtests:** `?playtest=` turns the SDK's debug log on (also `?hawkes-analytics-debug=1`); every scenario's run
does too. The `match` scenario ends by checking the "How was that fight?" card appears and closes with its ×, then
logs each needed event (`analytics-event`) with how many went out and the build and env (`analytics`).
`node src/game/test/analytics.test.ts` (in `npm test`) drives a real sim match through analytics.ts.

## The website

The site pages (`index.html`, `characters.html`, `characters/*.html`, `whatsnew.html`, `privacypolicy.html`) are
static HTML with the same footer copied into each: a new page copies it, including the
`<p class="footer-credit">` "Powered by HAWKES GEN" mark (→ https://hawkesgen.com). The landing page's footer also
links the parent company, Hawkes Biomedical. The game (`Game/index.html`) has no site footer and carries neither.

## Versions and What's new

Every go live is a release, made by Hawkes Studio (`hawkesstudio/src/releases.ts`): a semver version bumped at
go live (minor when players get something new, patch for fixes) plus the build (the commit), shown as
"1.4.0 (build ...)" and tagged `v<version>` in git. Studio adds the release to `releases.json` at the repo root (copied by `pages.yml`) (newest first) with the
player-facing notes J approved in the go-live plan. `whatsnew.html`, the footer version and the game's title screen and main menu (`Game/index.html`) read it through `hawkes-release.js` (a copy of
`hawkesstudio/clients/web/hawkes-release.js`: `[data-hawkes-version]`, `[data-hawkes-releases]`). Don't bump versions
by hand; a typo in old notes can be fixed in the file on beta.

## Making content (agents)

New stages, fighters, lines and music are made end to end by agents with the skills in `.claude/skills/`
(Claude Code loads them by themselves): `dod-stage` (concept → design → painted layers → `stages.json` +
`modes.json` → music recipe → playtest; headless through `tools/maps/make.mjs`), `dod-fighter` (side view → poses →
clips → `fighters.json`), `dod-voice-music`. Every generated file goes through Hawkes Gen and, when it's a file the
game ships, through `hawkes.assets.json`. GPU work is priced first (`hawkesgen_estimate`, or `make.mjs --estimate`)
and needs J's OK. Content playtests target the new content with scenario options: `{"stage": "<id>"}` or
`{"fighter": "<id>"}` on `match`/`smoke` (second line of `.hawkes/scenario.txt`).
