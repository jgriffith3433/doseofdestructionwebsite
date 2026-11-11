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
