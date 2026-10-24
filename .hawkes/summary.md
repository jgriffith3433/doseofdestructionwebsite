**Wrong:** The earlier fix preloaded the announcer clips, but the splash still fired "A", "versus", "B" on fixed timers (650 ms apart). The clips run 0.8–2.1 s, so each call cut into the next and it sounded rushed or out of order.

**Changed:**
- `src/game/audio.ts`: `lineMs(id)` returns a line's decoded length.
- `src/game/ui/views.ts` (`playVersus`): after preload, each call is cued when the previous clip ends (plus 150 ms). The splash is held long enough for the last call (never shorter than before).

**Checked:** `npm run typecheck` and `npm test` pass. Not run in a browser; a playtest of the splash would confirm it.

**Look at:** VS splashes with long names (Crystalline Intelligences) now last a bit longer than 2.6 s.
