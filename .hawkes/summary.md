# Phone layout for menu, select, stages, VS and results

**What was wrong:** the screens only had 900px/560px breakpoints and 800px/520px height rules built for desktop: buttons were 32–40 px, the ticker and VS name cards kept desktop sizes, and the landscape VS screen (overflow hidden) pushed cards off the bottom.

**Changed:**
- `src/game/game.css`: a "phone" block at the end, under `(max-width: 560px), (max-height: 520px)` (never matches 16:9 / 20:9 desktop windows). It sets 44 px minimums on all buttons (Back, rule +/- , slot tools, Fight, menu items, stage cards, results actions) with 8–12 px gaps; a slimmer ticker (30 px, smaller text, ellipsis) with the bottom safe area; smaller VS fighters, name cards, VS mark and stage line; a tighter results hero and strip. On its side (≤520 tall) the main menu goes to two columns and the VS stage blurb is dropped. Safe-area insets are kept on every screen. The ON AIR bug stays hidden ≤900 as before.
- `src/game/playtest/dod.ts`: `presentation` now also checks the character select and stage select screens. At phone size (≤560 wide or ≤520 tall) `checkClipping` also checks every button is ≥44 px tall and none overlap (`phone-targets` event, or a `bug` problem), and labels the shape "phone portrait/landscape".
- `src/game/playtest/scenarios.ts` description + regenerated `site/playtest-bridge.js`.

**Checked:** `npm run typecheck` passes. `npm test`: only the 33 known `characters/head/*.webp` failures (sparse checkout), none new. I did not run the scenario or view the layout in a browser here (none available), so the phone CSS is untested visually. The site build wasn't run.

**For J:** run `presentation` at 390x844 and 844x390 (the scenario reads the window size; it can't resize it). Any `phone-targets` or `no-clipping` problem names the element. Scope left: Campaign map, Profile, Leaderboard, How to play and Settings were not tuned. No GPU work, so no estimate.
