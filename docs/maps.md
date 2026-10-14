# Making a map

Each stage starts as a folder in `C:\Projects\AllTheMaps` (or `DOD_MAPS_ROOT`):

```
AllTheMaps/
  CityTop/
    reference.txt        what the stage is, how it plays, what happens on it
    <any images>.png     concept art; the first (by name) becomes the backdrop
```

The folder name becomes the stage: `CityTop` is "City Top", id `city-top`.

## Generate Map Idea

In devtools, Maps → Concepts lists every folder. Under **How you imagine it**
you can add anything `reference.txt` doesn't say. **Generate Map Idea** asks
Claude (`claude-opus-5-5`, about 15¢ a design) for 1 to 4 designs, each a
different take (close to the concept, more vertical, bolder, more compact),
and shows a blockout of each. **Use this** opens one unsaved; **Revise…**
asks for revisions of a design with your feedback ("the fire escape higher,
more height between rooftops"), and so does **Revise…** on a stage that
already came from the folder.

A design has:

- the layout (platforms, spawns, respawn, blast zone), sized for how high
  fighters jump;
- art direction: one style every piece is painted in;
- every piece of art as a silhouette (a few rectangles: a water tower's tank,
  legs and deck), with a description for the painter, and which platforms it
  draws;
- a description of the backdrop to paint;
- effects the reference asks for, and design notes.

The concept images are references, not the art: nothing is copied from them.
The first one is kept as `stages/<id>/reference.webp` to paint from. Without
`ANTHROPIC_API_KEY` you get one plain draft.

## Painting

Save the stage, then use the **Paint** card (it needs the GPU server; see the
GPU tab). A stage is painted in pieces:

- **backdrop:** painted fresh, inspired by the concept, a new composition;
- **stage:** every piece that draws platforms, painted as one picture over a
  blockout of their silhouettes and the walkable tops, so the art lands on the
  collision; it becomes the `stage-art` layer (the placeholders stay, hidden);
- **each other piece:** scenery behind and pieces in front, cut out.

Qwen-Image-Edit paints each piece in two passes: one over a blockout drawn in
the stage's colors, which keeps the shapes flat and on the collision, then a
lighter pass that adds detail. The concept reaches it only as a blurred mood
board (its palette and light), and the look comes from the art direction. A
white background keys out instantly; anything else is cut out with BiRefNet.

The stage piece makes four takes and the others two. Takes that draw
platforms show **fits %**: how well their walkable tops land on the platforms
(below about 60% they look off in the game), with the best first. **Use** one
(it lands exactly where it was painted for), **×** discards it, **Paint more**
makes more. Takes live in `stages/<id>/_takes/` with a recipe beside each.

While painting runs, each piece shows its place in line or its progress, the
pieces glow on the canvas, and the top bar shows it on every tab. It runs on
the dev server, so refreshing, playtesting or closing devtools is fine. See
`comfyui.md` for what the server settings and models do, and why.

## Art director

**Review this stage** (about 5¢) shows Claude the stage as the default camera
sees it, next to the concept and the reference. It scores it, says what
works, and lists what to fix by piece. **Repaint with this** queues that
piece again with its suggested description; a style note can become the art
direction.

## Layers

A stage is drawn with picture layers. Each has a center (x, y) and a width,
in world units as the default camera sees them, so they sit in the editor
where they show in the game. Its **depth (z)** places it:

| z | Where | Use |
|---|---|---|
| 12 to 30 | far behind | the backdrop, distant skyline |
| 3 to 12 | behind the stage | scenery nobody stands on |
| 0.3 | the fighters' own depth | art that draws a platform: rooftops, catwalks, landings |
| −1.5 to −5 | in front of the fighters | railings, chimneys, foliage |

The camera's perspective gives every layer parallax, which is why art that
draws a platform must sit at 0.3: anywhere else it slides off the collision
as the camera moves (Checks warns, and generated ideas place it there). Other
layers between −1.2 and 3 cut through the default platform blocks.

- **Occluder:** a layer in front that hides fighters behind it. The game draws
  a silhouette of anyone behind it in their player color, so no one gets
  lost. Only its solid pixels count, so leave transparent gaps.
- **Glow:** adds light instead of covering (neon, windows).
- **Collision only** (on a platform): the art draws that platform, so the game
  doesn't paint its default block.

Art mode (toolbar) lets you click, drag and resize layers in the editor.
**Upload image…** puts a PNG, JPG or WebP into `stages/<id>/` as WebP,
keeping transparency. "See through front" fades front layers while you work
behind them.

## Effects

Effects react to the match: **On a KO**, **At the end** (the finale, spread
over the two seconds before the results), **At the start**, or **Every few
seconds**. They can be fireworks (rise and burst in the sky), bursts (at the
KO or in the sky), camera shake, or embers. Each can play a sound from
`content/sounds.json`.

## 3D preview

**3D preview** shows the stage, unsaved changes included, in the game's own
renderer, with two fighters. Move fighter 1 with the sliders to check depth,
parallax and silhouettes, and try **KO**, **Match start** and **Finale**.
**Playtest** opens the saved stage in the game.
