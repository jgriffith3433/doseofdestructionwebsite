# Story cards between matches: beta build

**What was wrong:** Beta's "build failure" (run r_02fdf16ba44a) was not a code error. Studio's `playtest.run` was refused because the studio was out of credits ("needs 9 and 1 is left"). Nothing in the repo broke.

**What I checked:** the story-card feature is already on this branch:
- `content/campaign.json` `card: {before, after}` on every chapter.
- `ui/views.ts` `playCard`: shows the episode title and a line, auto-advances, and can be skipped.
- The `story-cards` scenario.
- `npm run typecheck` passes. `npm test` passes the sim, net, ratings, unlocks, analytics, commentary, cards and playtest-bridge suites.
- `vite build` runs (see below).
- `tools/heads.test.mjs` shows 33 FAILs for `characters/head/*.webp`. These are missing only because this worktree is a sparse checkout without image files (git marks them skip-worktree); they are tracked in git and unrelated to this change.

**Changed:** no code. Added `.hawkes/scenario.txt` (`story-cards`) and these notes.

**For J:** beta needs credits (Settings → Plan and credits) before its playtest can run. Without a GPU budget there was nothing to price: this change has no generated assets.
