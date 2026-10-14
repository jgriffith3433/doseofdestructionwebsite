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
- `flip`: the clip faces left.
- `fps`: frames to sample per second (15 for loops, 20 for the rest).
- `normalize`: size the clip by its own first frame (on for moves, off for
  clips that don't start standing, which use `idle`'s size).
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
