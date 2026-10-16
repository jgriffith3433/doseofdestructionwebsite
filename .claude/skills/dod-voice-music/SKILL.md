---
name: dod-voice-music
description: Write and generate Dose Of Destruction voice lines (announcer, narrator, fighters, campaign dialogue), sound effects and music (stage themes, menu, results) through Hawkes Gen. Use for "new lines for <fighter>", "voice the Encore chapter", "a theme for <stage>", "a sound for <move>".
---

# Voice, sound and music for Dose Of Destruction

All audio is generated through Hawkes Gen (no ElevenLabs or AWS keys here). Text and recipes are data:

| What | Data | Made by |
|---|---|---|
| Voice lines | `content/voice.json` `lines[]` (`id`, `group`, `who`, `text`, `audio`, `take`); speakers in `cast` and `voices` (ElevenLabs voice ids) | `POST /api/dev/voice/generate {id, text, voice}` (dev server) → `audio.voice` (`eleven_v4`) |
| Sound effects | `content/sounds.json` (`group` ≠ music) | `POST /api/dev/sfx/generate {id, text, loop, duration}` → `audio.sfx` |
| Music | `content/sounds.json` `group: "music"` (`music-<stage id>`, `music-results`) + a recipe in `hawkes.assets.json` (preset `stage-theme`) | `studio_make_assets` / `studio.cmd assets doseofdestruction make` → `audio.music` (ACE-Step, GPU) |

## Writing lines

- Canon first: your brief's canon section and the fighter's `blurb`/`role` in `content/fighters.json`. The campaign is a
  TV show (Open Mic → Encore); the announcer is the show's voice. Never put the corporate secret (B3, the vat) in a line.
- Short and speakable: barks 1 to 6 words, dialogue one or two sentences. ElevenLabs v4 reads audio tags like
  `[laughs]`, `[whispers]`, `[shouting]` in the text: use them sparingly.
- A new speaker needs a voice: pick from `GET /api/dev/voice/voices`, or design one (`hawkesgen_run` `audio.voice-design`
  with a description, then `audio.voice-save`). Record why in `cast[<who>].why`.
- Ids are `<who>.<what>` (`susan.taunt`, `announcer.ready`); the game plays by id.

## Generating

- Voice and sfx are API calls (cents each, no GPU, no approval needed for a normal batch; say the count and cost in your
  summary: about $0.01–0.03 per line). Generate only lines whose `take` doesn't match their text and voice (that's
  "out of date"); the devtools Voice tab shows the same.
- Music is GPU (ACE-Step, about 1–2 GPU-minutes a 60 s loop). Price several with `hawkesgen_estimate` and batch them
  in one `studio_make_assets` call (one server start). Write the prompt like the existing ones in `hawkes.assets.json`:
  genre, instruments, energy, BPM, key, "instrumental", what the place feels like.
- Listen before you keep anything: `media.probe` for length, and check the loop point of music (it must loop: `loop: true`).

## Check

`npm test`, then `studio_playtest` (doseofdestruction): `smoke` reports missing voice files, unrecorded lines and
stages without music as problems; for a stage's music use `match` with `options: {"stage": "<id>"}`. Criteria to
state: the new lines play at their moments (the review hears the audio), no "unrecorded voice line" or "no stage
music" problems remain.
