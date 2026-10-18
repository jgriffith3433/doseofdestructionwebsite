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
- **Poses**: every fighter's stills (side view, facing right) that their
  clips start and end on: Standing, Striding, Crouching, Airborne, Guarding,
  Hanging, Hurt, Helpless, Dizzy. A grid of fighters by poses; click a cell to
  make candidates, pick one, and write how that fighter does the pose (their
  personality). **Make missing poses** queues Standing for everyone without
  one, and the rest for fighters whose Standing is picked. See
  `animation.md`.
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
  `stages/<id>/`. See `maps.md`. **Variant** makes a special version of a
  map (its own stage, sharing the art) to change for one mode.
- **Modes**: where every stage is used. A table of every stage (variants
  under the map they come from) with a tick per mode (Versus, Training) and
  the story chapters that fight on it; "not used" marks stages players can't
  reach. Under it, each mode's list in stage-select order: reorder, remove,
  or open one to give it a name or rules for that mode only (stage events
  off, gravity, damage). Saves `content/modes.json`; the game's stage select
  reads it. A newly saved map is in no mode until you tick it in.
- **Story**: the campaign, chapter by chapter. Title, tagline and hint; the
  lines before and after the fight (speaker, text, voiced or out of date,
  reorder, add, delete); and the fight: stage, stocks, goal (win or survive),
  time limit, gravity, damage, stage events, and up to four fighters (who
  plays them, team, stocks, size, starting damage). Add, duplicate, reorder
  and delete chapters. **Play chapter** opens it in the game
  (`/Game/?chapter=<id>`). Saves `content/campaign.json`; voice the lines in
  the Voice tab.
- **Sounds**: every effect and music loop the game plays, by id. Write a
  description and generate it, or upload a file. An entry turns "out of date"
  when its description changes after it was generated. Saves
  `content/sounds.json`; files go in `audio/sfx/`.
- **Voice**: every spoken line: announcer calls, fighter names, KO yells,
  victory lines and all campaign dialogue (editable here). Pick a voice for
  each speaker, then generate or upload takes. Saves `content/voice.json` and
  `content/campaign.json`; files go in `audio/voice/`.
- **GPU**: the AWS GPU servers that generate side views, clips and stage
  art, the regions and quota they can use, scaling, and the job queue. See
  "Generating animations" below.
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
images and home lineup, then `node tools/heads.mjs --only <id>` for the profile-picture face crop. To set up `.venv` on a new machine:

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

Sound and voice generation use ElevenLabs through Hawkes Gen (its `audio.sfx`
and `audio.voice` tools), which holds the key in `hawkesgen\.env`. Start
Hawkes Gen and the Sounds and Voice tabs work; every take is also kept in
Hawkes Gen's library with what made it.

Without Hawkes Gen running, everything else still works and you can upload
audio files.

## Generating animations

The GPU work runs in **Hawkes Gen** (`C:\Projects\hawkesgen`), the service
every Hawkes game shares: it owns the AWS GPU servers (g6e, an NVIDIA L40S,
48 GB) running ComfyUI with Wan 2.2 Animate, Wan 2.2 image-to-video and
Qwen-Image-Edit 2511, the AWS keys (in `hawkesgen\.env`), and one queue for
every project. **Start it first** (`hawkesgen\auto-start.bat`, dashboard at
http://127.0.0.1:8790). The GPU tab here talks to it through
`tools/gpu/gen.mjs`, and every job step (side view, pose, clip, stage piece)
is a Hawkes Gen job labelled with the fighter, clip or stage; the takes still
land in the same folders as before, and Hawkes Gen's library keeps a copy.

`hawkesgen.cmd fleet status` shows the servers from a terminal. The map
designer and art-director review (Maps tab) ask Claude through Hawkes Gen too.

**Cost.** About $1.86 an hour for a `g6e.xlarge` while it runs (bigger sizes
are listed with their prices), and about $27 a month for its 250 GB disk
until you terminate it. It stops itself after the idle time set at launch
(30 minutes by default; the tab shows the cost so far). Launch, Start and
Terminate all ask first.

**Regions and quota.** Servers can live in us-east-1, us-east-2,
us-west-2, eu-north-1, eu-central-1 or ap-northeast-1. "Region: any" launches in the first one with enough GPU quota and
a free machine. GPU quota is how many GPU vCPUs the account may run in a
region (a `g6e.xlarge` needs 4); the Regions card shows it, with open
requests, and can request more (free; AWS reviews it, usually within a day).
(Hawkes Gen's API does the same: `POST /v1/fleet/quota`.)

**Several servers.** Each ready server runs one job at a time, so with more
servers a batch (painting every piece of a stage, a fighter's clips) runs
side by side. The Scaling card sets **Servers to use** (default 4, up to 8):
how many servers there may be and how many jobs run at once. It's saved in
Hawkes Gen (its settings apply to every game). **Add a server** launches another (it sets itself up
once, then keeps its own disk, about $27 a month each); **Start N more**
starts the stopped ones; **Stop all** stops every one. With "start stopped
servers by themselves" on, waiting jobs start stopped servers (never new
ones) up to the limit. Servers stop themselves when idle, which is how the
fleet scales back down. New servers go wherever quota is free: 8 vCPUs fits
two `g6e.xlarge` in a region, so four servers spread over two regions or
more. Each server card shows the job it's running; the queue shows where
each job ran.

**Machine types.** g6e (NVIDIA L40S, 48 GB, from $1.86/h) is the cheapest
that fits, and the one AWS most often runs out of. g7e (NVIDIA RTX PRO 6000
Blackwell, 96 GB, from $3.36/h for a `g7e.2xlarge`, 8 vCPUs) is a newer,
separate pool in every region we use: AWS quotes up to 2.3x g6e's speed, so a
job costs about the same and finishes sooner. "Any" launches try the cheapest
first. Both count against the same GPU quota (8 vCPUs: two g6e.xlarge or one
g7e.2xlarge per region).

**When AWS is full.** A stopped server can only start again in its own zone,
so a start fails more often than a launch (which can try every zone and
region). "Keep trying" on a start tries every stopped server each round; tick
"then launch a new one where machines are free" (or press "Also launch a new
one if needed" while it tries) and, once no stopped server could start twice
in a row, it launches a fresh server of any type wherever one is free.
Servers stop after 60 idle minutes by default (Scaling card), so you give
machines back less often.
Quota doesn't reserve machines, so a launch or start
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
4. **Driving videos (optional).** Clips come from prompts by default, so
   each fighter moves their own way. To copy a motion exactly (Wan Animate),
   pick a **Driving video** in the clip editor: the shared motion library's
   clip, or the fighter's own (**Upload a driving video…**: a phone video of
   you acting it is fine; it's kept in their `anims/_motion/<clip>.*` and only
   used when picked). "Add to motion library" copies a good clip to
   `<art root>/_motions/<clip>.mp4` for any fighter to pick. A fighter can
   opt into the library for every clip with "Make clips by" in AI Settings.
   A human skeleton drives the motion, so it suits people-shaped fighters.
5. **Bring a fighter up to date.** In Animations, **Generate missing / out of
   date** (its label counts what's to do) queues every clip with no
   animation, regenerates AI-made clips whose prompt AI Settings would no
   longer send (you changed their description or a clip's action), and
   builds videos that changed since they were built. Out-of-date clips are
   remade the way they were made (their own prompt, their driving video) and
   replace the clip (the old one moves to `anims/_old/`). Videos you
   imported yourself are never touched. Each used take's recipe is kept in
   `anims/_recipes/<clip>.json` so this can tell.
6. **In bulk.** In Clips, "Generate with AI" queues every missing clip (or
   one, or all) for a fighter, with a takes count and what to do when done.

Each ready server runs one job at a time (several servers run several), and
jobs wait in the queue until a server is ready. In
the GPU tab, **Details** on a job shows its exact prompt, settings, seeds and
log, and downloads its ComfyUI workflow (drag the file into ComfyUI to open
and tweak it there). **Rerun** queues it again with a new seed; **Same seed**
repeats it exactly, which is how to test one setting at a time. A job left
running when the dev server stops goes back in the queue and keeps the takes
it already made.

## Content files

The game reads its data from `content/`:

| File | What | Edited in |
|---|---|---|
| `fighters.json` | Names, roles and stats for all fighters | Fighters |
| `stages.json` | Every stage's geometry, blast zone and look | Maps |
| `campaign.json` | Chapters, fights and dialogue | Story (and Voice for takes) |
| `modes.json` | Which stages each mode offers, in order, with per-mode names and rules | Modes |
| `sounds.json` | Sound effects and music | Sounds |
| `voice.json` | Voices and non-campaign lines | Voice |
| `anim-clips.json` | The clip names animation slots use, and each clip's action and length | AI Settings (actions) |
| `generation.json` | AI prompts and sampler settings, per fighter too | AI Settings |

Stage numbers must be integers; the Maps tab rounds them when it saves.
