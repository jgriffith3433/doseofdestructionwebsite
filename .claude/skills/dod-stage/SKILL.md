---
name: dod-stage
description: Make a new Dose Of Destruction stage end to end from a concept (an AllTheMaps folder, or a brief like "a stage for the Encore chapter"): design, painted layers, stage data, music, checks, playtest. Use for any "add/redo a DoD stage or map" request.
---

# A Dose Of Destruction stage, end to end

A stage is data (`content/stages.json` + `stages/<id>/` art + `content/sounds.json` music) made by the Maps
pipeline in `docs/maps.md`. `tools/maps/make.mjs` runs that pipeline headless, through the dev server's own API, so
you never hand-place layers. Read `docs/maps.md` once (layers, depths, dynamics) before you change anything by hand.

## 0. Where the concept comes from

- `C:\Projects\AllTheMaps\<Folder>\` (or `DOD_MAPS_ROOT`): `reference.txt` + concept images. The folder name is the
  stage (`CityTop` → `city-top`). Every folder there already has a stage: a request for one of them means a
  **redesign** (`--replace`) or a **second stage** (`--id city-top-2`), so say which you're doing.
- No folder yet (e.g. "a stage for the Encore chapter"): make one. Write `reference.txt` from the campaign
  (`content/campaign.json`: the chapter's text, its fights, the show framing) and the canon in your brief; then make
  2 concept images with Hawkes Gen (`hawkesgen_run`, project `doseofdestruction`, `image.generate`, a wide 16:9
  painterly establishing shot; about 1¢ each on a running server). Concept images are references only; nothing is
  copied from them.
- Canon: stages are places on the TV show's tour (Open Mic → Encore). The corporate secret (B3, the vat) never
  appears. Characters on a stage are scenery, not fighters, unless they're in `fighters.json`.

## 1. Design (Claude only, about 15¢, no GPU)

```bash
auto-start.bat                       # the dev server on :8089 (or npm run dev); Hawkes Gen must answer
node tools/maps/make.mjs <Folder> --design --direction "what the request stresses"
```

Claude writes 3 designs (layout sized for fighter jumps, art direction, silhouettes, dynamics: events, zones,
hazards), picks the one that plays best, and saves it. The report has `estimate`: what painting will cost.
Look at `.cache/maps/<id>/pick-*.png` (the blockouts) and check the saved stage: spawns on solid ground, a blast
zone around everything, platform art at z 0.3, no layer between -1.2 and 3 except platform art.

## 2. Paint (GPU: ask first)

Painting is about 20 to 40 image.edit passes (the stage piece 4 takes in two passes, others 2): `--estimate` prints
the GPU minutes and dollars from Hawkes Gen's job history. **If your brief doesn't carry J's OK for that GPU cost,
stop here**: finish with the design saved, the estimate in your summary, and the question for J. Batch: one
stage's pieces are queued together (one model load); several stages in one task, paint them in one run.

```bash
node tools/maps/make.mjs <Folder> --paint      # paint every piece, use the best takes, art-director review, music recipe
```

- Takes that draw platforms are chosen by **fit** (how well their walkable tops land on the collision). Under 0.6
  looks off in game: `node tools/maps/make.mjs <Folder> --paint --takes 4` paints more, only for what's missing.
- The review (Claude, about 5¢) scores it and lists fixes by piece. Repaint a piece with its suggested description
  through the devtools Paint card, or edit the layer's `prompt` and paint again; don't hand-edit the webp files.
- Music: the script adds `music-<id>` to `content/sounds.json` and a recipe to `hawkes.assets.json`. Make it with
  `studio_make_assets` (doseofdestruction, ids `["music-<id>"]`) or `studio.cmd assets doseofdestruction make`
  (ACE-Step, about 2 GPU-minutes).

## 3. Wire it in

- Versus and Training offer only the stages in `content/modes.json`: `make.mjs` adds the new one to both. A campaign fight on it: set `"stage": "<id>"` on that fight in
  `content/campaign.json`, and keep the chapter's story text consistent with the place.
- Generated assets the stage needs beyond its painted layers (a texture, a sign) go in `hawkes.assets.json` with a
  `note`, never as loose files: Studio tracks missing / out of date and reuses what Gen already made.

## 4. Check, then playtest

```bash
npm test                 # the sim (stages load, spawns, events)
npm run typecheck
```

Then `studio_playtest` (doseofdestruction, scenario `match`, `options: {"stage": "<id>"}`) with acceptance criteria,
at least:
- the match starts on the new stage and both fighters spawn standing;
- painted platforms line up with where fighters stand (no floating, no sinking);
- no "unpainted stage layers" or "no stage music" problems in the report;
- every stage event warns, runs and ends (if it has dynamics);
- fps doesn't drop more than 20% against another stage.

For the verification playtest Studio runs on your change (and again on beta), write `.hawkes/scenario.txt` as two lines:
`match` and `{"stage":"<id>"}`. To watch it yourself: `http://localhost:8089/Game/?play&stage=<id>&vs=break` (a quick
match), or in the console `hawkesPlaytest.start('match', { seed: 1, speed: 1, stage: '<id>' })`.

## Cost and what to report

Design ~$0.15 · paint ~$0.60–1.20 GPU on a running server (+ ~$0.12 boot if it was stopped, + the idle tail if
left on) · review ~$0.05 · music ~$0.10. Report the real numbers: the make report's `paint`, `takes` (fit per
piece), `review.score`, and `hawkesgen_jobs` / Studio's costs for the task.
