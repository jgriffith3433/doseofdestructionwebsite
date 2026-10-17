# Dose Of Destruction

Platform fighter with every main IP character (doseofdestruction.com). The game is `Game/index.html` +
`src/game/`; content is `content/*.json`; devtools are `/devtools.html` on the dev server (`auto-start.bat`,
port 8089). Docs are in `docs/`. Check with `npm test` (sim) and `npm run typecheck`. Pushing `main`
deploys the live site (GitHub Actions `pages.yml`): don't commit or push unless asked.

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
| `match` (~2.5 min) | A full 1v1 versus a CPU, 2 stocks, no time limit, to the results screen. Outcome won/lost. |
| `campaign` (≤10 min) | The campaign from chapter 1: dialogue, fights, outros. Two tries per chapter; stops cleanly at 9.5 min. |
| `sound-settings` (~2 min) | Studio standard: taps the Tap to play prompt (hit-tested pointer press), checks the AudioContext runs and the menu music starts, Settings from the main menu (Sound off, Music 40%), reloads the page (the run carries on via `sessionStorage`), checks the choice came back, then Settings from Pause in a match. Puts the player's `hawkes.sound` back. |
| `site-links` (~1 min) | Checks the game screen has no site marks, then opens the website over the game in a full-screen frame and walks it by its own links (landing → footer Characters → a fighter card → Privacy → What's new), checking "Powered by HAWKES GEN" → https://hawkesgen.com on each page (and on every fighter page, read), and Hawkes Biomedical → https://hawkesbiomedical.com on the landing page. External links are checked, not followed. |
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
