# Announcer and Blog Man commentary — attempt 2

**What was wrong:** nothing in the code. The earlier beta build failure was Studio's own "out of credits" error (playtest.run needs 6, 1 left), not a compile or test error. This branch starts from beta, which already has the work.

**What is already on this branch, unchanged:**
- `src/game/commentary.ts` turns sim events into announcer lines (`announcer.<kind>.<n>`), with 12 kinds: first-blood, ko, comeback, last-stock, showdown, self-destruct, big-hit, combo, danger, shield-break, hazard, stage-event, time-low, lull. It also holds Blog Man's per-season intros (`blog-man.intro.<chapter>`).
- `main.ts` `broadcast()` shows the caption, plays the voice if recorded, and fires `dod:commentary`. No line repeats back to back.
- The `commentary` playtest scenario in `src/game/playtest/` covers the three criteria. Part 1 plays a versus match and logs `call-<kind>`, `call-kinds` and `call-repeat` problems. Part 2 plays the first chapter of each season and logs `blog-intro` and `blog-intros`.
- `src/game/test/commentary.test.ts` (part of `npm test`).

**Checks run:** `npm ci`, `npm run typecheck` (pass), `node src/game/test/commentary.test.ts` (pass: 12 call kinds, 11 calls, 39 Blog Man intros across 10 seasons). `npm test` has 33 failures, all missing `characters/head/*.webp` (sparse checkout). No other failure. The site build was not run here.

**Change in this attempt:** `.hawkes/scenario.txt` = `commentary`, plus these notes. No game code changed.

**For J:** beta's playtest of `commentary` needs Studio credits (it needs 6). Top up in Settings → Plan and credits, then re-run. The voice lines are captions only for now (audio null; the Voice tab can record them). No GPU work was done, so there is no estimate.
