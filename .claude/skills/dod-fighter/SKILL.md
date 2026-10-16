---
name: dod-fighter
description: Add or re-animate a Dose Of Destruction fighter end to end: source art, side view, poses, animation clips, fighter data, voice lines, playtest. Use for "add <character> to DoD", "new moves/clips for <fighter>", or "<fighter> looks off-model".
---

# A Dose Of Destruction fighter, end to end

Every fighter is one of the IP characters in `C:\Projects\AllTheCharacters\<Folder>\` (33 so far). Their stats,
name and role are `content/fighters.json`; the art pipeline is `docs/animation.md` (read it: poses, clip rules,
trimming). Everything is generated through the dev server's GPU jobs, which go through Hawkes Gen.

## 0. Who they are (canon first)

- The character must exist in canon (your brief's canon section, `memory_search` kind canon). Never invent a new
  IP character for a fighter request: ask. Pierce Hawkes and the board are corporate canon, not fighters.
- Their look is fixed by the source image in their folder (`content/art-sources.json` says which file). Write one
  **character description** (colors, body, outfit, signature item) and reuse it word for word in every prompt.

## 1. On-model art

- Side view: `POST /api/dev/gpu/jobs {"jobs":[{"type":"side","fighter":"<id>"}]}`, then pick the best take
  (`/gpu/side/choose {fighter, file}`). Look at every take yourself (Read the png) against the source image.
- **Character LoRA** (when the fighter has one: `hawkesgen_library` search "<name> LoRA"): `image.character` keeps
  them on-model in any pose; use it for poses that image.edit drifts on. The current LoRAs (Susan, Exit Punk) are
  weak (9 images, one caption): retrain proposal in `hawkesgen/docs/lora-retrain.md`.

## 2. Poses, then clips (GPU: ask first)

Order: Standing (pick it) → the other poses → clips. Clips are Wan 2.2 first-last-frame between poses.

```http
POST /api/dev/gpu/jobs {"jobs":[
  {"type":"pose","fighter":"<id>","pose":"crouch"}, {"type":"pose","fighter":"<id>","pose":"air"}, ...]}
POST /api/dev/gpu/pose/choose {"fighter":"<id>","pose":"crouch","file":"crouch-<seed>.png"}
POST /api/dev/gpu/jobs {"jobs":[{"type":"i2v","fighter":"<id>","clip":"idle"}, {"type":"i2v","fighter":"<id>","clip":"jab"}, ...]}
```

- Queue all of one kind together (all poses, then all clips): one model load each, and every free server helps.
- Price it first with `hawkesgen_estimate` (project doseofdestruction: `image.edit` × poses × takes, `video.i2v` ×
  clips × takes). A full fighter (9 poses, ~20 clips, 2 takes) is about 1.5 to 2 GPU-hours, about $3–4. **Without J's
  OK for that in your brief, stop after the side view and ask** with the number.
- Clips with `use: "auto"` build into sheets as they land (`characters/anim/<id>/`); check
  `_anim_preview/<id>.png` (same size every row, feet on one line, no green fringe) and fix with `clips.json`
  (docs/animation.md "Trimming and fixes") rather than regenerating.

## 3. Data

- `content/fighters.json`: id, name, role, blurb, size (`w`, `h`), weight, speeds, jumps, `frames`, `kb`, `reach`.
  Balance against fighters of the same role; don't make a new one the best at everything.
- Voice lines: `content/voice.json`, generated with the `dod-voice-music` skill.
- Campaign appearances: `content/campaign.json` (only where the story wants them).

## 4. Check and playtest

`npm test` and `npm run typecheck`, then `studio_playtest` (doseofdestruction, scenario `roster`, then `match` with `options: {"fighter": "<id>"}`) with criteria:
every move of the new fighter comes out from its input, no "stand-in clips" or "no clips" problems for it, it stays
on-model (same face, outfit and colors in every clip), and a `match` with it finishes. Report cost per stage of the
pipeline (side, poses, clips) from the jobs.
