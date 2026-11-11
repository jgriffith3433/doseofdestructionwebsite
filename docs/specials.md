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

## Season 1 kits, hitbox fit and character select

The 13 Season 1 fighters (`exit-punk`, `kaelen`, `break`, `dj-wont-read`, `shutup-bot`, `small-weather`, `blog-man`,
`evil-blue-bird`, `got-ur-back`, `slice`, `ss-boulder`, `stratabots`, `orchestrator`) each have their own `specials`, and no
two have the same four archetypes (`roster.test.ts` checks it; the `roster` playtest logs each `kit` and
`kits-distinct`). Names are in `docs/world-bible.md`.

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
