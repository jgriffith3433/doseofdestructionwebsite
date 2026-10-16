# Dose Of Destruction

Platform fighter with every main IP character (doseofdestruction.com). The game is `Game/index.html` +
`src/game/`; content is `content/*.json`; devtools are `/devtools.html` on the dev server (`auto-start.bat`,
port 8089). Docs are in `docs/`. Check with `npm test` (sim) and `npm run typecheck`. Pushing `main`
deploys the live site (GitHub Actions `pages.yml`): don't commit or push unless asked.

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
| `roster` (~8 min; 13 min in headless software rendering) | Setup shortcut: each fighter goes straight into training (no menus) and does all 14 moves from their inputs. |

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

## Versions and What's new

Every go live is a release, made by Hawkes Studio (`hawkesstudio/src/releases.ts`): a semver version bumped at
go live (minor when players get something new, patch for fixes) plus the build (the commit), shown as
"1.4.0 (build ...)" and tagged `v<version>` in git. Studio adds the release to `releases.json` at the repo root (copied by `pages.yml`) (newest first) with the
player-facing notes J approved in the go-live plan. `whatsnew.html`, the footer version and the game's title screen and main menu (`Game/index.html`) read it through `hawkes-release.js` (a copy of
`hawkesstudio/clients/web/hawkes-release.js`: `[data-hawkes-version]`, `[data-hawkes-releases]`). Don't bump versions
by hand; a typo in old notes can be fixed in the file on beta.
