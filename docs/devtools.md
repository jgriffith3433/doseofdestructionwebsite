# Dev tools

`http://localhost:8089/devtools.html`, on the dev server only (`npm run dev` or
`auto-start.bat`). It is never built or deployed. Its API lives in
`tools/devApi.mjs` and can only touch this project and the fighter art folder
(`C:\Projects\AllTheCharacters`, or set `DOD_ART_ROOT`).

Saving in dev tools reloads any open game tab, so a change shows up as soon
as you switch over. Dev tools itself does not reload, so unsaved work in
other tabs stays put.

## Tabs

- **Fighters**: the cutout, thumbnail and large image for each fighter.
  Recut a fighter with AI (see below), replace the cutout from a file, or
  "Use as cutout" on any source image in their art folder. Rebuild their
  images or the whole home lineup; edit name, role, blurb and every stat, with
  roster comparison bars. Saves `content/fighters.json`.
- **Animations**: every clip slot for a fighter. Import a video into a slot
  (button or drag and drop) and only that clip builds. **Edit** a clip to trim
  it against the source video, flip it, adjust background keying and size,
  then preview it at game speed with the hurtbox and the move's hitboxes on
  top. See `animation.md` for making clips.
- **Clips**: every animation video in every fighter's `anims` folder in one
  list, like Sounds. Each shows waiting (not built yet), out of date (the
  video or its options changed since it was built), or current. Process one,
  everything shown, or all waiting; preview and edit a clip in place. Videos
  with a name the game doesn't know get a Rename control.
- **Maps**: drag platforms, their ends, depth, spawn points, the respawn
  point and the blast zone. Set motion, colors and backdrop in the inspector.
  The Checks list catches spawns in midair, platforms past the blast zone, and
  so on. Saves `content/stages.json`; Playtest opens the saved stage.
- **Sounds**: every effect and music loop the game plays, by id. Write a
  description and generate it, or upload a file. An entry turns "out of date"
  when its description changes after it was generated. Saves
  `content/sounds.json`; files go in `audio/sfx/`.
- **Voice**: every spoken line: announcer calls, fighter names, KO yells,
  victory lines and all campaign dialogue (editable here). Pick a voice for
  each speaker, then generate or upload takes. Saves `content/voice.json` and
  `content/campaign.json`; files go in `audio/voice/`.
- **Scripts**: buttons for the sim tests, typecheck, production build,
  animation builds, the lineup and image build, and `_recut.py`.

## Cutouts

Fighter cutouts are made with a segmentation model, because a brightness key
can't tell a black coat from a black backdrop. `tools/cutout.py` runs in the
project's `.venv` (which has `rembg`), reads which source image to use from
`content/art-sources.json`, and backs up the old cutout to `_backup/art/`:

```
.venv\Scripts\python tools\cutout.py            # every fighter
.venv\Scripts\python tools\cutout.py susan --mode union
```

Modes: `birefnet` (default, cleanest), `union` (both models combined, keeps
smoke and tendrils that fade into the backdrop), `isnet`. Masks are cached in
`.cache/cutout/`. Afterwards run `_build_lineup.py` for the thumbnails, large
images and home lineup. To set up `.venv` on a new machine:

```
python -m venv .venv
.venv\Scripts\pip install "rembg[cpu]"
```

## Animation folders

`python tools/make_anim_folders.py` (or Scripts > Set up anims folders) makes
`<art root>\<Fighter>\anims\` for every fighter with `_reference.png`,
`_reference-green.png` (a first frame for image-to-video) and a `CLIPS.txt`
checklist. It never touches videos.

## Generating audio

Sound and voice generation use ElevenLabs. Put your key in a `.env` file in
the project root (it is gitignored), then restart the dev server:

```
ELEVENLABS_API_KEY=your-key-here
```

Without a key, everything else still works and you can upload audio files.

## Content files

The game reads its data from `content/`:

| File | What | Edited in |
|---|---|---|
| `fighters.json` | Names, roles and stats for all fighters | Fighters |
| `stages.json` | Every stage's geometry, blast zone and look | Maps |
| `campaign.json` | Chapters, fights and dialogue | Voice (lines) |
| `sounds.json` | Sound effects and music | Sounds |
| `voice.json` | Voices and non-campaign lines | Voice |
| `anim-clips.json` | The clip names animation slots use | (by hand) |

Stage numbers must be integers; the Maps tab rounds them when it saves.
