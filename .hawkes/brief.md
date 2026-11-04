# Work for Dose of Destruction

You are fixing a problem Hawkes Studio's automated playtest found in Dose of Destruction (Dose of Destruction: a Vite/TypeScript web fighting game (dist/Game) with its site (characters, stages, audio), published to GitHub Pages (doseofdestruction.com).).


## What J asked for

In Dose of Destruction write Season 8 as four episodes, same pattern: docs/story.md first, then campaign.json chapters, heading and end line in story.ts. Continue from Season 7's end line. Avoid the Mechanic (candidate canon).

Work out what that means in this project (read the story doc and AGENTS.md), make it well, and keep it consistent with
the product's tone and style. If it's too big for one change, do a solid first part and say what's left in the summary.

## GPU budget: none

Nothing here was approved for GPU generation (images, video, music, 3D on the fleet). Do everything that needs no GPU
(design, data, specs, Claude-only steps, voice and sound effects are fine: cents each), price the GPU part with
`hawkesgen_estimate`, and end with that estimate in your summary so J can approve it. Never start a GPU server.

## Acceptance criteria (how this is judged)

The change is ready once your checks pass and its pull request is open; after it is merged into beta, beta's playtest
judges these, and the work is done only when every one of them passes there:
1. Campaign map shows Season 8 with four chapters, locked until Season 7 is cleared.
2. Each Season 8 chapter plays from intro to result.
3. Season 8 end line shows on clearing the last chapter.

Where the game implements the playtest contract (`window.hawkesPlaytest`: see this project's AGENTS.md, and the spec
at `hawkesstudio/docs/playtest.md` next to this repository), add or extend a scenario that plays to what the criteria
describe (through real input, no teleporting; named setup shortcuts are fine) and logs events or checks that show each
one, so the review can judge them from the footage and the timeline. Write that scenario's name (one line, e.g.
`checkout`) in `.hawkes/scenario.txt`: beta's playtest plays it (and this change's, when J asks for one). To play specific content
(a new stage, level or enemy), add a second line with the scenario's options as JSON, e.g. `{"stage":"neon-pit"}`. Without a contract, make
sure each criterion can be seen when the page is played.





## Studio's tools, and Talk

You have Studio's own tools, the same ones Talk has (the `hawkesstudio` MCP server): the backlog, reports, playtests,
previews, the roadmap, the other projects, deploy plans. Read whatever helps. `studio_task` starts work in another
project (up to 3; work you start can't start more). Going live, rollbacks and Approve cards stay the owner's.
To tell the owner something while you work (a result, a question you can carry on without), use `studio_tell`: it goes
to Talk, which passes it on. A question you can't go on without still goes in `.hawkes/question.md` (see above).
GitHub: `studio_github_api` makes REST calls to any of this Studio's repos with Studio's own token (issues, pull
requests, Actions runs and logs, search, branches of your own). There is no GitHub token in your shell, so use it
instead of `gh` or `curl`. Merging and approving stay with Studio's gates.

## Files from Hawkes Gen

To put a file from Hawkes Gen into this repo (an image, a sound, a model), call `studio_gen_import` with its asset id
(`a_...`) and the path in the repo; give `width`/`height`/`format`/`quality` to resize or convert an image (Gen does it,
free). It writes the file for you: no download, key or converter needed. Then commit it.
It takes files from this Studio's own Gen library and from its owners' own hawkesgen.ai libraries.

## The Studio's other repositories (read-only)

Shallow clones of the other projects' repositories, to read (not to change: a change there is that project's own task):
- `jgriffith3433/YoobaLandGame`: `../c_035ed7cd9f50.repos/YoobaLandGame`
- `jgriffith3433/imaginelivetvwebsite`: `../c_035ed7cd9f50.repos/imaginelivetvwebsite`
- `jgriffith3433/hawkesbiomedical`: `../c_035ed7cd9f50.repos/hawkesbiomedical`
- `jgriffith3433/theplacedepartmentwebsite`: `../c_035ed7cd9f50.repos/theplacedepartmentwebsite`
- `jgriffith3433/hawkesgen`: `../c_035ed7cd9f50.repos/hawkesgen`
- `jgriffith3433/icanbeaiwebsite`: `../c_035ed7cd9f50.repos/icanbeaiwebsite`
- `jgriffith3433/hawkesgenwebsite`: `../c_035ed7cd9f50.repos/hawkesgenwebsite`
- `jgriffith3433/hawkes-analytics`: `../c_035ed7cd9f50.repos/hawkes-analytics`
- `jgriffith3433/phoriginswebsite`: `../c_035ed7cd9f50.repos/phoriginswebsite`
- `jgriffith3433/YoobaLand`: `../c_035ed7cd9f50.repos/YoobaLand`
- `jgriffith3433/hawkesstudio`: `../c_035ed7cd9f50.repos/hawkesstudio`
- `jgriffith3433/breakingthrough`: `../c_035ed7cd9f50.repos/breakingthrough`
- `jgriffith3433/sickofitgame-unity`: `../c_035ed7cd9f50.repos/sickofitgame-unity`
- `jgriffith3433/sickofitgamewebsite`: `../c_035ed7cd9f50.repos/sickofitgamewebsite`
- `jgriffith3433/hawkesnet-js`: `../c_035ed7cd9f50.repos/hawkesnet-js`
- `jgriffith3433/hawkesnet`: `../c_035ed7cd9f50.repos/hawkesnet`
- `jgriffith3433/hawkesnet-babylon`: `../c_035ed7cd9f50.repos/hawkesnet-babylon`
- `jgriffith3433/hawkesnet-unity`: `../c_035ed7cd9f50.repos/hawkesnet-unity`

## What the studio already knows (shared memory)

Earlier agents, J and Talk learned these; follow decisions and preferences, respect canon, and use the lessons
(unconfirmed ones are an earlier agent's notes: check them). More: memory_search, if you have the tool.
- [decision] No polling: use server push or on-demand fetches: In every product (Studio, Gen, sites, games): never add setInterval/setTimeout loops that fetch. Use a server push stream (SSE: Studio's /api/stream, Gen's /v1/events) or fetch on page open, user action or event. An idle page makes zero requests. Polling through the Cloudflare edge workers burned 100k requests on 2026-11-01. A poll that truly can't be avoided needs a written reason in the PR. (m_4f6d1382b804)
- [convention] campaign seasons: a season exists once content/campaign.json has a chapter with "season": N; names/end lines are SEASON_TEXT in story.ts; run node tools/playtest-bridge.mjs after changing scenarios (start ids include season-N). (item i_f9f095e07d5e) (m_9a5b62786fa9)
- [convention] hero unlocks: chapter `unlock` in content/campaign.json; one rule `fighterOpen` in campaign/story.ts is used by select, Profile and online; store is localStorage `dod-unlocks`. (item i_f9f095e07d5e) (m_1ae61be4ff9f)
- [convention] new objectives follow quota's pattern: `MatchSetup` field + Match getters, `objectiveMet()`, HUD chip in main.ts `updateHud`, results line in ui/views.ts, a playtest scenario + `node tools/playtest-bridge.mjs`; keep counters in `FighterStats` so rollback snapshots restore them. (item i_f9f095e07d5e) (m_573fb0d7dbd0, unconfirmed)
- [convention] a chapter's `unlock` must be one fighter per chapter, no repeats (unlocks.test.ts), so a 2-fighter finale unlocks only the new one. (item i_f9f095e07d5e) (m_981b0db63dc9)
- [convention] Agent changes go to beta first: An agent works on its own branch and opens a pull request into the game's beta branch. Nothing reaches the live game until the owner goes live. (m_988b8d55f022)
- [lesson] `tools/heads.test.mjs` fails on a clean checkout (missing head webps), so `npm test` stops there; run the other test files individually. (item i_f9f095e07d5e) (m_41751b19b35d, unconfirmed)
- [lesson] npm test fails at heads.test.mjs on a fresh checkout: generated characters/head/*.webp are missing (pre-existing); run the other tests individually. (item i_f9f095e07d5e) (m_f9ba3b22bca9)
- [lesson] Sparse checkout hides images: characters/*.webp are in git but absent here, so npm test fails on head images regardless of your change; compare against git stash. (m_18ba4d836017)
- [state] Build shift Nov 1 9 AM PT: Hawkes Games preview fix started; Studio Google sign-in blocker confirmed: Shift log folder (/mnt/project-files/hawkes) not mounted again, so logging here. Inbox empty, no changes running. Started c_c0b6e2ea4c48 (hawkes-games): fix f_4805be4acade (community previews 401 for signed-out visitors) and f_32c8793e7b8d (legal page pale text), into beta. Re-ran live playtest r_0d8a8e1a89c7 on hawkes-studio: Google sign-in still broken (GSI origin not allowed for the client ID,… (m_b3783961d128)
- [state] Build shift Nov 4 9am PT: Gen beta playtest, Place Dept campaign build, Yooba fixes started: Project-files map/log not mounted again; logging here. Landed on beta overnight: Biomedical Gen medical images (c_d95a4e4b200b), Hawkes Net P2P resend fix (c_95fe333794d1), Gen signed-out 401 fix (c_49c069807aa8), DoD showcase caption fix (c_3a9da27873e2). Place Dept Campaign fix went live 03:57 UTC by J. Did: beta playtest of Gen 8d97a05 (r_31ec9804c373) so it can go to J's Approve card; built P… (m_46b5cf4f6957)

## How to work

1. Read `AGENTS.md` (and any docs it points to) before changing anything. Follow its rules.
2. Look at the screenshots to see the problem. Find the cause in the code or data; prefer the smallest correct fix.
3. Keep to this finding. Don't refactor unrelated code, don't touch generated output or build folders, don't change
   secrets, CI, or deploy scripts.
4. Run the project's checks:
- `npm ci && npm run typecheck && npm test` (in the repo root)
5. Commit your change with a clear message (`Fix: ...`). Don't push; Studio does. Studio stops a pass after
   180 minutes: commit as you go (after each working piece or finished batch), so a stop loses nothing.
   A third-party error from a Gen job (ElevenLabs payment_issue, a 401 or 402) is not yours to retry: test ONE line
   first for voice work, and on that error stop at once, write `.hawkes/stuck.md` naming the service, and end.
6. Write `.hawkes/summary.md`: what was wrong, what you changed (files), how you checked it, and anything J should
   look at. If you couldn't fix it, explain why there instead, and don't commit.
   Two approaches, then stop: when two different approaches haven't worked (the checks still fail, or you can't find
   the cause), don't keep iterating. Write `.hawkes/stuck.md` (what you tried, what happened, where you think the cause
   is) and commit nothing that doesn't work: Studio gives the next attempt a bigger model, with your notes.
7. Write `.hawkes/try.md`: how J tries it on the beta site, in two to five short steps a player would follow (where to
   go, what to press, what he should see).
8. If you can't go on without a decision that the request, the criteria and the thread don't settle (a real direction
   choice, not a detail you can decide well yourself), write ONE clear question to `.hawkes/question.md` (the options
   you see and the one you'd pick), commit nothing, and stop. Studio gets you the answer and you continue in this same
   session.
9. Before you finish, write `.hawkes/learned.md`: what the next agent working on this project should know that
   isn't obvious from the code (at most 5 lines, only real knowledge: a trap you hit and how you got past it, how a part of
   the codebase really works, a check that matters). One per line, in this form:
   - lesson: <short title> — <what broke or misled you, and the fix>
   - convention: <short title> — <how this codebase does it>
   Write nothing there if you learned nothing new. Studio keeps these in the shared memory for the next agent.

## The product's story (for tone and intent)


