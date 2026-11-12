# Specials

Special with a direction does a different move: neutral (`MOVE.NSPECIAL`), side (`MOVE.SSPECIAL`), up (`MOVE.UPB`),
down (`MOVE.DSPECIAL`). The stick is read the frame Special is pressed (keyboard K + A/D/W/S, gamepad B + stick or
d-pad, touch: the stick plus the Special button, no extra button). Up wins over down, down over side (stick past 50
vertically, or 40 sideways).

A fighter without `specials` in `content/fighters.json` keeps today's moves: up is the shared Up special, every
other direction the shared Neutral special. With `specials`, a missing slot falls back to the shared move.

```json
"specials": {
  "neutral": { "type": "projectile", "speed": 13, "life": 70, "dmg": 70 },
  "side":    { "type": "dash", "speed": 12, "duration": 14 },
  "up":      { "type": "recovery", "variant": "angled", "rise": 17, "speed": 7 },
  "down":    { "type": "trap", "arm": 20, "life": 600 }
}
```

Frames are as played (60 per second; not scaled by the fighter's `frames`), distances in world units (scaled by
height), `dmg` in tenths of a percent, `angle` in degrees in the fighter's facing space. Every number has a default
(`SpecialSpec` in `src/game/sim/fighterDefs.ts`); `compileSpecial()` turns an entry into an ordinary `Move`.

| `type` | What it does | Main numbers |
|---|---|---|
| `projectile` | Spawns a shot at `startup` that flies (`speed`, `rise`, `gravity`) for `life` frames; hits the first fighter it touches and disappears (also on a solid block, a blast zone, a shield). One per fighter (`max`). | `speed life r dmg angle bkb kbg x y style` |
| `dash` | Drives forward at `speed` for `duration` frames with a hitbox riding along, leaving a trail; in the air only the first per jump moves. | `startup duration endlag speed dmg` |
| `counter` | From `startup` for `window` frames a hit on the fighter is turned back on the attacker (`mult` percent of its damage, at least `dmg`), the fighter takes nothing. | `startup window endlag mult dmg` |
| `grab` | A command grab: one short hitbox, goes through shields, hits only a fighter on the same floor, pulls them `pull` units in front and throws. Long recovery on a whiff. | `startup r pull dmg angle endlag` |
| `trap` | Places a trap on the floor ahead (needs a floor), armed after `arm` frames, for `life` frames; the first enemy to touch it takes the hit and it is gone. Placing another replaces it: **at most one per fighter**, whatever the data says. | `startup arm life r dmg x` |
| `flurry` | `hits` quick hits `interval` frames apart (each hits again), the fighter creeping forward, the last one a finisher. | `hits interval dmg finisherDmg finisherBkb advance(speed)` |
| `recovery` | `variant` `straight` (up, steer a little), `angled` (the stick aims it, forward when neutral) or `glide` (a short lift, then a slow glide that is not helpless). Straight and angled end helpless. | `startup duration rise speed glide life` |

`clip` names the stand-in clip when the fighter has no `sspecial` / `dspecial` clip of its own: `nspecial` (a
throw), `fsmash`, `dsmash`, `upb`, `roll`.

All of it is integers in the sim (`step.ts`: `attack`, `spawnShot`, `stepShots`, `applyHit`; `state.ts`: `shots` are
cloned and hashed with the rest, so rollback and the desync hash hold). The renderer draws a shot from the state
(`render/renderer.ts` `drawShots`): a spinning board, a trap on the floor, an orb; dashes leave a streak, a counter
flashes. `src/game/test/specials.test.ts` has a test and a rollback replay for each archetype; the `specials`
playtest scenario plays Exit Punk's kit with the keyboard or the touch overlay.

## Effect flipbooks

Each archetype has a painted flipbook (`render/flipbook.ts`, `content/flipbooks.json`): an additive white-on-transparent
grid atlas, tinted per fighter (the hue of its main outfit colour, `looks[].from`), drawn from a pool of 28 planes built
(with every texture) in the renderer's warm-up. High: 16 frames of 256 px cells (4x4); Low: 8 frames of 128 px cells
(4x2); both last 32 sim frames. Played on: a projectile's release (muzzle flash) with a short trail on the shot, a
trap's placement (glyph), a dash's and a recovery's drive, each flurry hit (slash), a throw (slam ring), and a counter
catching a hit (white-blue flash; the sim freezes both fighters `COUNTER_FREEZE` = 6 frames on that frame).
**The sheets are stand-ins drawn in code** until the Gen art (keyframe, video, sprite sheet) is made: add the PNGs under
`fx/flipbook/` and their `file` in `content/flipbooks.json` `sheets` and nothing else changes. Scenario `special-fx`.

## All 33 kits, hitbox fit and character select

All 33 fighters in `content/fighters.json` (the 13 of Season 1 and the 20 newer: `ball-person`, `cel`, `chooser`,
`crosser`, `crystalline-intelligences`, `future-man`, `lapis-man`, `not-an-old-man-yet`, `pyro-singer`, `shark-dude`,
`slow-rider`, `spider-bot`, `susan`, `the-mechanic`, `try-belt`, `tt`, `uh-me`, `wallit`, `yo-bot`, `yooba`) each have their
own `specials`, and no two have the same four archetypes (`roster.test.ts` checks it, up recovery variants counted
in the report and the other three kinds required to differ; the `roster` playtest logs each `special`, each `kit`
and `kits-distinct`). Names are in `docs/world-bible.md`.

**`hitboxes`** in a fighter's entry (written by `node tools/fit-hitboxes.mjs`, read by `applyHitboxFit` in
`fighterDefs.ts`): for each of fsmash, usmash, dsmash, nspecial, sspecial, upb and dspecial, one `{ x, y }` per hitbox in
the move's order (a projectile's one entry is where it spawns). They replace the authored offsets, in world units for
that fighter. The tool reads the move's clip sheet (`anims.json`: frame size and feet anchor), the sheet frames that play
during the move's active frames (the same mapping as `render/anims.ts` `clipFrame`), takes the furthest opaque pixels
in the direction the box points, and sits the box on them. Counters and traps have nothing drawn to hit with and are
skipped. A box "misses" when no opaque pixel of the active frames is inside it; the tool reports 0 misses or exits 1.
`--check` writes nothing and exits 1 on a miss or a stale fit; run it after a clip changes. It needs ffmpeg and the
sheets (in git when a checkout is sparse). The art stands 1.18x the hurtbox, so drawn fists are higher and nearer than
the old shared boxes assumed: that is what the fit corrects.

**Character select** (`ui/specialsPreview.ts`): the hovered, focused or tapped fighter's four specials by name with
their kind, and a looping clip of one of them on a canvas (its own sheet, or the stand-in the game plays); tapping a row
pins it, otherwise the preview walks through the four. On a phone on its side (844x390) the preview is a column beside
the tiles and nothing scrolls it away. The `select-specials` playtest taps all 13 and checks names, fit and motion.

**Bot** (`ai/bot.ts`): uses its kit by archetype: a projectile at range down the lane, a trap on the way in, a dash to
close distance, a counter when the opponent commits to a swing, a grab or flurry up close.

**Bot levels** (`ai/bot.ts`): every chance below grows with the level. A thrown special at range down the lane (also in
the air), a trap on the way in and one laid at the ledge when the target is off stage, hanging or standing at an
edge, a dash to close distance, a counter the moment the opponent commits, a grab or flurry up close (and stepping in
with one), and the recovery: an angled up special is aimed at the ledge, a straight or gliding one leans toward the
stage. `roster.test.ts` plays every fighter's bot at levels 2, 7 and 8: at level 7 a match uses at least three
different specials on average, a level 8 bot presses them more often than a level 2 one, and across all 33 fighters
bot-vs-bot win rates stay between 35% and 65% (balanced with each fighter's `dmg` and `kb`).

**On a phone:** all four specials are the stick plus the one Special button, nothing else. The `roster` playtest with
`input: "touch"` (390x844, turned to 844x390) has the 20 newer fighters fire all four from the on-screen controls
(`touch-special`) and the command grab where the kit has one (`touch-grab`: 12 of the 20), and reports
`specialsOutsideTouch` (0). There is no separate Grab button in the layout; a grab is a special.

## The shared grab and throws

Every fighter has one grab (separate from a command-grab special): **Shield + Attack together** (keyboard L + J, pad
trigger + A, touch Shield + Attack touched at once; Attack out of a held shield is the same thing). It reaches as far as
the fighter's jab (`CharacterDef.grabReach`, the furthest jab hitbox edge), plays the jab clip, and has the triangle
built in: it **beats shield** (the shield is left whole), and **loses to attacks** (a hit that lands on the grabber
while it reaches, applied before grabs in `resolveHits`/`applyGrabs`, ends it). A whiff is a 30-frame recovery.

The held fighter plays hurt, pinned in front. The hold lasts `holdFrames(percent)`: 40 frames at 0%, 100 at 100%
(max 240); each mash (a fresh button press or stick flick) takes 4 frames off it. The holder throws with the stick
(or Attack, which is forward): forward, back, up or down (`CharacterDef.throws`, from `buildThrows` in `fighterDefs.ts`:
own damage, angle, base and growth knockback, scaled by the fighter's `dmg`/`kb` tuning). Up is the kill throw off
the top, back sends them behind, down is weak and leaves them close for a follow-up. Throws reuse the clips ftilt,
bair, utilt and dtilt. Events: `grab`, `throw`, `grab-break`; sound `grab` (synth) and the grab flash in the renderer.
