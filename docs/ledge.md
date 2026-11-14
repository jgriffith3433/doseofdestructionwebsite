# The ledge

Grabbing a ledge (walking or falling past a solid platform's top corner, or a recovery move that can grab) no longer climbs by
itself, and no button climbs it by default. The fighter hangs (invincible for the first 30 frames, as before) and, from frame 8,
reads one option. The code is `sim/step.ts` ("The ledge is a choice"); every number is an exported constant there and all of it
is integers in the fighter's own state (`action`, `frame`, `ledge`), so it is deterministic and rolls back.

| Option | Input | Action | Length | Invincible | What it does |
|---|---|---|---|---|---|
| Getup | stick up, or toward the stage | `LEDGE_CLIMB` | 22 | 22 (all) | climbs up and stands just inside the edge |
| Roll | Shield | `LEDGE_ROLL` | 34 | 28 | rises over the edge, then rolls a body-length further in than the getup (never past the middle of a small platform) |
| Attack | Attack (or the smash stick) | `LEDGE_ATTACK` | 12, then the move | 14 | climbs, then swings the fighter's own down tilt from the top: a low sweep (every fighter's has a hitbox) |
| Jump | Jump | `LEDGE_JUMP` | 16 | 14 | a hop 15% higher than a normal jump, a little toward the stage; air jump and aerials open at frame 6 |
| Drop | stick down or away, or 240 frames (4 s) of hanging | back to `AIR` | | | lets go; the same ledge can't be grabbed for 30 frames (90 after the hang ran out) |

Special does nothing on the ledge. Touch uses the same four inputs as everywhere (stick, Attack, Shield, Jump) with no new
button; a quick flick up on the touch stick is a Jump press, a held stick up is the getup.

**Animation and sound** reuse what exists: `climb` for the getup, the rise of the roll and the attack, then `roll` or the down
tilt's clip (`render/anims.ts`); the ledge jump plays `jump` and carries on into `fall`. The sim reports `ledge-option`
(`getup|roll|attack|jump|drop`); `main.ts` plays a cue for each (and `dod:ledge` for playtests), on top of the dodge sound the
roll already makes, the swing the sweep makes and the jump sound.

**Tests:** `test/ledge.test.ts` (each option's action, invincibility window, landing spot, the sweep hitting a fighter at the
edge for every roster fighter, the hang limit, a cloned-state replay to the same hash); playtest scenario `ledge-options`
(keyboard and a 390x844 phone); the All controls page and How to play list the options (`input/devices.ts` `On the ledge`).
