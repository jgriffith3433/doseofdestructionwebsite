Season 8, *Awards Season*, four episodes. Season 7 ended on "The champion was never recast", and the network now gives itself prizes.
- `docs/story.md`: Season 8 section (table, beats, rules) and the map end line. The "Seasons 8 to 10 not written" note now reads 9 and 10.
- `content/campaign.json`: Red Carpet (Kaelen, no hazards), Best Supporting (Break + Small Weather, gravity 90%), Lifetime Achievement (Slice, quota 250% in 90 s), Best in Show (Susan, clean streak 4 in 90 s). Intro and outro each, Blog Man hosting, Exit Punk dry.
- `src/game/campaign/story.ts`: heading "Awards Season", end line "Four nominees. Four envelopes. The speech was four words." (the last line of Best in Show's outro).
- `site/playtest-bridge.js`: regenerated, so it has the new chapter ids and `season-8`.
- Season 7 used every fighter except the Mechanic, which stays unused as asked. The nominees are therefore returning walk-ons, and no chapter has an `unlock`, because the unlock test allows one chapter per fighter.
- Checks: typecheck, every `src/game/test/*.test.ts` and the bridge check pass. I did not run the browser playtest.
- For J: pacing is not sim-tuned. The lines are text only; voicing them costs cents. GPU estimate: none, no new art.
- Scenario: `campaign` with `{"season":8}`. It checks the map's Season 8 heading, four chapters and lock, plays each chapter, and checks the end line.
