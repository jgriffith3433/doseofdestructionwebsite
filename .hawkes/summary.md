**Wrong:** On the A-versus-B splash the announcer lines ("A", "versus", "B") were played on fixed timers. The lines were fetched and decoded on first use, so they sat in the download queue while the match assets loaded. When they landed they played late, all at once, or out of order.

**Changed:**
- `src/game/audio.ts`: new `preloadLines(ids)` that fetches and decodes just those catalog lines (capped at 4 s).
- `src/game/ui/views.ts` (`playVersus`): waits for the announcer lines (the two fighter names and "versus"), then starts the slam, the calls and the splash timer. Clicking or pressing a key to skip works from the same point, and the old early-skip timing is otherwise unchanged.

**Checked:** `npm run typecheck` and `npm test` both pass. I did not run it in a browser; a playtest of the splash on a cold cache would confirm it.

**Look at:** if the lines take a while on a slow connection, the splash now waits for them (up to 4 s) before the announcer starts.
