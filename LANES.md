# Dose Of Destruction: lanes, local dev and deploys

Generated from `hawkesstudio/tools/lanes/repos.json` (`node ../hawkesstudio/tools/lanes/lanes.mjs docs`); the whole
picture for every repo is `hawkesstudio/docs/lanes.md`.

**Branches: `dev` -> `beta` -> `main`.** Work on `dev` (local). `beta` is for testing. `main` is live.
Agents' fixes land on `beta` (pull requests Studio merges); `sync.bat` brings them into `dev`.

| | Address |
|---|---|
| Local | [http://localhost:8089/Game/](http://localhost:8089/Game/), [http://localhost:8089/devtools.html](http://localhost:8089/devtools.html) |
| Beta | [https://dod.hawkesgen.ai/Game/](https://dod.hawkesgen.ai/Game/) |
| Live | [https://doseofdestruction.com/](https://doseofdestruction.com/), [https://doseofdestruction.com/Game/](https://doseofdestruction.com/Game/) |
| Deploys (GitHub Actions) | [github.com/jgriffith3433/doseofdestructionwebsite/actions](https://github.com/jgriffith3433/doseofdestructionwebsite/actions) |

**How it deploys:** Push beta: Studio builds and publishes the beta site and playtests it. Push main: its pages.yml builds and GitHub Pages publishes it live.

| Command (double-click, or run in a terminal here) | What it does |
|---|---|
| `dev.bat` | Switch to `dev`, bring it up to date, start the dev server (`auto-start.bat`), print the links |
| `deploy-beta.bat [patch\|minor\|major]` | Send `dev` to `beta` after `npm run typecheck`, tagged `vX.Y.Z-beta.N` |
| `deploy-prod.bat [patch\|minor\|major]` | Send `beta` to `main` (live), tagged `vX.Y.Z`; asks you to type DEPLOY |
| `status.bat` | What's waiting for beta and for live, the last tags |
| `links.bat [local\|beta\|prod]` | The addresses; with a lane, open them |
| `sync.bat` | Bring `beta`'s newer commits (agents' fixes) into `dev` |

Versions: live tags are `vX.Y.Z`; each beta deploy on the way is `vX.Y.Z-beta.N`. The default step is minor; pass
`patch` or `major` to choose. `deploy-prod` gives beta's commit the version its beta tag was heading to.
