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
  point, the blast zone and (in Art mode) art layers. Set motion, colors,
  layers, effects and notes in the inspector; mirror platforms and layers;
  undo with Ctrl+Z. The Checks list catches spawns in midair, platforms past
  the blast zone, art still to paint, and so on. Concepts lists the folders in
  `C:\Projects\AllTheMaps` with **Generate Map Idea**. 3D preview shows the
  unsaved stage in the game renderer. Saves `content/stages.json`; art goes in
  `stages/<id>/`. See `maps.md`.
- **Sounds**: every effect and music loop the game plays, by id. Write a
  description and generate it, or upload a file. An entry turns "out of date"
  when its description changes after it was generated. Saves
  `content/sounds.json`; files go in `audio/sfx/`.
- **Voice**: every spoken line: announcer calls, fighter names, KO yells,
  victory lines and all campaign dialogue (editable here). Pick a voice for
  each speaker, then generate or upload takes. Saves `content/voice.json` and
  `content/campaign.json`; files go in `audio/voice/`.
- **GPU**: the AWS GPU server that generates side views and clips, the
  regions and quota it can use, and the job queue. See "Generating
  animations" below.
- **AI Settings**: every prompt and sampler setting for generation, with
  per-fighter overrides and a live preview.
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

## Generating animations

The GPU tab runs ComfyUI on a g6e machine (an NVIDIA L40S, 48 GB) in your
AWS account with Wan 2.2 Animate, Wan 2.2 image-to-video and
Qwen-Image-Edit 2511. It needs these in `.env`:

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-1
```

`node tools/gpu/check.mjs` and `node tools/gpu/regions.mjs` show what the
keys can see, without creating anything.

**Cost.** About $1.86 an hour for a `g6e.xlarge` while it runs (bigger sizes
are listed with their prices), and about $27 a month for its 250 GB disk
until you terminate it. It stops itself after the idle time set at launch
(30 minutes by default; the tab shows the cost so far). Launch, Start and
Terminate all ask first.

**Regions and quota.** The server can live in us-east-1, us-east-2 or
us-west-2. "Region: any" launches in the first one with enough GPU quota and
a free machine. GPU quota is how many GPU vCPUs the account may run in a
region (a `g6e.xlarge` needs 4); the Regions card shows it, with open
requests, and can request more (free; AWS reviews it, usually within a day).
`node tools/gpu/quota.mjs` does the same from a terminal.

**When AWS is full.** Quota doesn't reserve machines, so a launch or start
can fail with "capacity": AWS has none free right now. Nothing is charged.
Tick "keep trying" and the dev server retries every 3 minutes until it
works or the time runs out (charges start when it succeeds). A failed try
shows what kind of problem it was (capacity, quota, keys) and every zone it
tried.

**First launch** installs itself: about 30 to 45 minutes, mostly downloading
90 GB of models (listed in `comfy/models.json`, set up by
`comfy/server/bootstrap.sh`). The tab shows each stage. Later starts take a
couple of minutes. Only this computer's IP can reach the server, through a
password-protected proxy on port 8189; if your IP changes, use Refresh access.
The password and SSH keys are in `.cache/gpu/` (gitignored); the tab shows
the SSH command.

### AI Settings

Every prompt and setting the workflows use is in the AI Settings tab, saved
to `content/generation.json` (anything not set there uses the defaults in
`tools/gpu/settings.mjs`):

- **Every job:** clip size, frame rate, takes per job, the background, and
  the negative prompt.
- **Side view, From a prompt, Copy the motion library:** each workflow's
  prompt and its sampler settings (steps, CFG, shift, LoRA strengths, sampler,
  scheduler, framing). Hints explain each one; Reset puts a section back.
- **Per fighter:** a description of how they look, how their clips are made
  (prompt or motion library), extra things to avoid, their own side view
  prompt, their own action for any clip, and their own sampler settings.
- **Clips:** what each clip shows and how long it is (`content/anim-clips.json`).

Prompts can use `{name}`, `{description}`, `{action}` and `{background}`.
A job's own settings win over the fighter's, which win over the defaults.
The preview at the top shows exactly what a job would send, unsaved edits
included.

### Making clips

1. **Side view.** In Fighters, "Generate side views" makes candidates in the
   fighter's `anims/` folder (`_side-<seed>.png`); you can give them their own
   prompt. "Use this" copies one to `_side.png`, which every clip animates from.
2. **One clip.** In Animations, **Generate** on a clip card queues it with the
   AI Settings defaults. **AI…** opens the clip editor, where you can set this
   job's prompt, things to avoid, seed, number of takes, any sampler setting,
   and what happens when it's done. "Will send" shows the final prompt.
3. **Takes.** Generated clips land in `anims/_takes/<clip>-<seed>.mp4`, each with
   a `.json` recipe (prompt, seed, settings). A clip with no video yet uses
   the first take straight away; otherwise takes wait in the clip editor.
   There: **Use** makes a take the clip (the old video moves to `anims/_old/`,
   and it builds), **More like this** queues two more with the same prompt and
   settings, **Discard** moves it to `anims/_old/`.
4. **The motion library.** When a clip looks right, "Add to motion library"
   in its editor copies it to `<art root>/_motions/<clip>.mp4`. Other
   people-shaped fighters can then copy it with Wan Animate, so every
   fighter's jab has the same timing. Bots and creatures default to prompts,
   since a human skeleton won't drive them.
5. **In bulk.** In Clips, "Generate with AI" queues every missing clip (or
   one, or all) for a fighter, with a takes count and what to do when done.

Jobs run one at a time and wait in the queue until the server is ready. In
the GPU tab, **Details** on a job shows its exact prompt, settings, seeds and
log, and downloads its ComfyUI workflow (drag the file into ComfyUI to open
and tweak it there). **Rerun** queues it again with a new seed; **Same seed**
repeats it exactly, which is how to test one setting at a time. A job left
running when the dev server stops is marked interrupted; rerun it.

## Content files

The game reads its data from `content/`:

| File | What | Edited in |
|---|---|---|
| `fighters.json` | Names, roles and stats for all fighters | Fighters |
| `stages.json` | Every stage's geometry, blast zone and look | Maps |
| `campaign.json` | Chapters, fights and dialogue | Voice (lines) |
| `sounds.json` | Sound effects and music | Sounds |
| `voice.json` | Voices and non-campaign lines | Voice |
| `anim-clips.json` | The clip names animation slots use, and each clip's action and length | AI Settings (actions) |
| `generation.json` | AI prompts and sampler settings, per fighter too | AI Settings |

Stage numbers must be integers; the Maps tab rounds them when it saves.
