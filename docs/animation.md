# Animating a fighter

Each fighter starts as one still image. The game gives every fighter a little
procedural motion (squash, lean, spin), and replaces it clip by clip as real
animation arrives. A fighter can have one clip or all thirty; anything missing
falls back on its own.

## The loop

1. Generate a short clip of one move in your video tool.
2. Save it as `C:\Projects\AllTheCharacters\<Folder>\anims\<clip>.mp4`, using a
   clip name from the table below (for example `ExitPunk\anims\jab.mp4`).
3. Run `python _build_anims.py exit-punk`.
4. Check `_anim_preview\exit-punk.png`, then play the fighter in Training.
   Press **H** to see hitboxes and check the swing lines up with them.

The script keys out the background, lines every frame up on the feet, scales
the fighter to their in-game height, packs a sprite sheet into
`characters/anim/<id>/`, and adds the fighter to `characters/anim/index.json`
so the game loads it.

## Poses: what every clip starts and ends on

Each fighter has a set of stills, all side view facing right, that their
clips are made between (devtools **Poses** tab):

| Pose | What it is | Clips that use it |
|---|---|---|
| Standing | their fighting stance (the side view, made from the front art) | idle, ground attacks, roll, dodge; most clips end here |
| Striding | mid-step | walk |
| Crouching | low on bent knees | crouch, jump start, jump, down tilt |
| Airborne | feet off the ground, balanced | fall, jump, land, air dodge, aerials |
| Guarding | braced to block (the game draws the shield) | shield |
| Hanging | hands gripping a ledge above the head | ledge, climb |
| Hurt | knocked back by a hit | hurt |
| Helpless | spent and falling after a big move | helpless, up special |
| Dizzy | dazed on wobbly legs | dizzy |

Every clip has a start pose and usually an end pose (content/anim-clips.json
`frames`; AI Settings shows them as "Starts on" and "Ends on"). Clips are made
with Wan 2.2's first-last-frame mode, which takes both:

- **Loops start and end on the same pose**, so they loop: crouch starts and
  ends crouched, walk on the stride, idle on the stance. The builder drops a
  loop's last frame when it repeats the first, so the wrap is seamless.
- **One-shots go from one pose to the next:** jump start goes from Standing to
  Crouching, jump from Crouching to Airborne, land from Airborne to Standing,
  climb from Hanging to Standing.
- **Moves come back to their stance:** ground attacks from Standing to
  Standing, aerials from Airborne to Airborne, down tilt from Crouching to
  Crouching. Up special ends Helpless.

Poses are also where a fighter's personality goes. Each fighter can say how
*they* crouch, guard or get dizzy (the note in the Poses tab), and their clips
inherit it from the poses. Make Standing first (and pick one), since the other
poses are made from it and share its size and framing; then make the rest,
then the clips. A clip whose poses are missing waits ("needs poses"); a clip
made before a pose was redone shows as out of date.

## What a clip needs

- **Side view, facing right.** The game mirrors it for facing left. If a clip
  comes out facing left, set `"flip": true` for it (see Trimming below).
- **In place.** The character should not travel across the frame. The game
  moves them; the clip only animates the body. Feet stay planted on the same
  spot except in jumps and aerials.
- **Locked camera, full body in frame.** No zoom, pan or cut. Keep the camera
  distance the same across all of a fighter's clips so they stay the same size.
- **Flat plain background.** Pure green (#00ff00) is best. Flat black or white
  also work if the character doesn't wear that color. No floor, shadow,
  props or gradient.
- **Short.** Moves read best at 0.3 to 1 second. Trim longer clips (below).
  The game stretches a move's clip to fit its timing, so the wind-up, hit and
  recovery should all be in there.
- Start moves from the fighter's normal standing pose. The script measures the
  first frame to size the clip.

### A prompt that works

> Full-body side view of [character description], facing right, performing
> [move]. Stays in place. Locked camera, no camera movement. Plain flat pure
> green background, no floor, no shadow. Even studio lighting. 2 seconds.

Use the same character description every time. The descriptions on the
Characters page are a good start.

## Clips, in the order worth making

| Clip | What it shows | Notes |
|---|---|---|
| `idle` | Standing, breathing, ready | Loops. Make this first; it sets the fighter's size |
| `walk` | Walking forward | Loops |
| `jump` | Leaving the ground, rising | Plays once |
| `fall` | Falling, arms out | Loops |
| `jab` | A quick punch or poke | |
| `ftilt` | A stronger forward strike | |
| `fsmash` | Big wind-up, huge forward hit | |
| `nair` | Spin or flail in the air | Aerials can leave the ground |
| `fair` | Forward strike in the air | |
| `upb` | Rising recovery move | |
| `hurt` | Knocked back, reeling | Loops |
| `shield` | Guarding | Loops |
| `land` | Landing crouch | |
| `crouch` | Crouched | Loops |
| `utilt`, `dtilt` | Up and low ground strikes | |
| `usmash`, `dsmash` | Big upward hit, hit to both sides | |
| `bair`, `uair`, `dair` | Back, up and down aerials | `bair` hits behind them |
| `nspecial` | Lunging special | |
| `roll`, `dodge`, `airdodge` | Evasions | |
| `ledge`, `climb` | Hanging on a ledge, climbing up | |
| `jumpsquat`, `helpless`, `dizzy` | Small extras | |

Up to 24 frames are kept per clip.

## Trimming and fixes

Put an optional `clips.json` beside the clips:

```json
{
  "jab": { "start": 1.2, "end": 1.7 },
  "idle": { "flip": true },
  "fall": { "tolerance": 28 }
}
```

- `start`, `end`: the part of the clip to use, in seconds.
- `speed`: play the clip faster (2 is twice as fast) or slower than it was
  made. Wan moves at a real-life pace, which is slow for a game. The default
  per clip is in `content/anim-clips.json` "speed" (AI Settings, Speed column:
  walk and fall 1.25, jump 1.5, hurt 1.5, jump start 2, the rest 1). It
  matters for loops and for jump / jump start, which play at their own pace.
  Moves and the other one-shots are stretched to their timing in the game (a
  jab is 18 frames whatever the video), so for them speed only changes how
  much motion fits in the frames: if a move's hit lands late, trim the wind-up
  with `start` instead. Changing a speed marks the clip out of date, so
  "Generate missing / out of date" rebuilds it (no GPU).
- `flip`: the clip faces left.
- `fps`: frames to sample per second (15 for loops, 20 for the rest).
- `normalize`: size the clip by its own first frame (on for moves, off for
  clips that don't start standing, which use `idle`'s size).
- `size`: a multiplier on top of that (1.1 is 10% bigger), or `"auto"`: the
  builder compares the video's first frame with the pose image the clip
  started on, and that pose's framing with the Standing pose (`anims/_side.png`),
  so the fighter comes out as tall as Standing. The ⤢ Size button on each clip
  card previews a size live (the dashed line is Standing height) and saves it;
  "Auto-size all" sets every clip not sized by hand to `"auto"` and rebuilds.
  Stray specks the keying leaves far from the fighter are dropped before
  measuring, so a leftover corner pixel can't shrink a clip.
- `tolerance`: how close to the background color a pixel must be to be keyed
  out (default 40). Lower it if parts of the fighter disappear; raise it if
  background is left around the edges.

## Commands

```
python _build_anims.py                  # every fighter with an anims folder
python _build_anims.py exit-punk kaelen # just these
python _build_anims.py --src D:\clips   # a different art root
```

Rerunning a fighter rebuilds all of their clips from the source files.
