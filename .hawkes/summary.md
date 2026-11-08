Beta's build failed with "Gen is restarting, try again in a few seconds". That is a temporary Gen outage, not a code error. No code change was needed. The rotate prompt, pause/resume and landscape lock from #94 are already on this branch.

What I ran here:
- `npm run typecheck` passes.
- `npm run build` passes.
- `npm test` has 33 failures. All of them are missing `characters/head/*.webp` files (run `node tools/heads.mjs`). That folder isn't in this checkout, so they aren't caused by the rotate change. Nothing else fails.
- I didn't run the playtest or the site-build recipe here.

The playtest scenario for the three criteria is `rotate`; it's named in `.hawkes/scenario.txt`. Beta needs a rebuild now that Gen is back.

GPU: none needed.
