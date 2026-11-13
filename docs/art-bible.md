# Art bible: how a fighter is drawn

One game's cast, not 33 pasted-in pictures. The fighters are AI-made and arrive with very different weight, colour and
brightness (the darkest idle sheet has a brightest 5% at value 0.25, the brightest at 0.97). Every fighter is drawn
through the same three rules, and the numbers below are the ones the code uses (`src/game/artStyle.ts`; change both
together). Reference: Brawlhalla, 60-plus legends with one outline weight and one value range, so any two read as one game.

## The numbers

| Rule | Number |
|---|---|
| Outline width | **2 px at 1080p** (render height 1080), scaled with the screen, **never under 1 px**. 844x390 on a phone draws 1 px; 4K draws 4 px. `outlineWidthPx(renderHeight) = max(1, 2 * h / 1080)`. |
| Outline colour | The fighter's **main hue darkened**, never black: value **0.20**, saturation = the fighter's own mean saturation held to **0.35 - 0.70**. The main hue is the biggest outfit hue band (skin and tan excluded); a fighter with no colour takes the hue of what colour it has. Stored as `style.outline`. |
| Colour looks | The outline turns with the look (`recolorHex`): a Flip or Neon fighter gets a line in its new hue, still value 0.20. |
| Saturation range | Mean saturation of the coloured pixels (s > 0.12, v > 0.15): **0.32 - 0.82** after the remap. |
| Value range, dark end | Darkest 5% of the body: **0.08 - 0.30**. No pure-black holes; the outline is the darkest line on a fighter. |
| Value range, light end | Brightest 5%: **0.66 - 0.94**. Every fighter has a highlight, none burns out. |
| Mean value | **0.25 - 0.65**. |
| Remap targets | The remap aims inside the ranges with a margin (saturation 0.40 - 0.76, dark end 0.12 - 0.28, light end 0.72 - 0.88) and a fighter already inside barely moves. |
| Remap limits | Saturation gain 0.8 - 2.6, value gamma 0.55 - 1, value gain 0.7 - 2.6: it may not turn a fighter into someone else. |
| Rim | One rim per fighter: the player-colour rim behind the body (1.07x on High, 1.045x on Low and 1v1-only) plus the stage's far-side rim light (`content/stages.json` `light.rim`). The outline sits on top of both and is never tinted by them. |
| Shadow | One contact shadow per fighter on the platform below: full size and 0.55 alpha on the floor, shrinking and fading with height, gone at 300 units (`render/fighterLight.ts`). |
| Portrait framing | Full body, three-quarter front, feet at 6% from the bottom edge and head at 8% from the top, centred on the hips, 3:4. The same outline weight (2 px at 1080p-equivalent, i.e. 2/1080 of the picture height) and value range as the match sprite. Portraits are not remapped by shader: they are painted to these ranges. |

## How it is drawn (render order on the fighter's sprite material)

1. **Look** (`lookPlugin.ts`, priority 250): the colour look recolours the outfit hue band.
2. **Remap** (`stylePlugin.ts` `RemapPlugin`, 275): per fighter, `s' = s * sGain`, `v' = vOff + vGain * v^vGamma`, hue kept. Numbers are `style.remap` in `content/fighters.json`. Dark fighters get the gamma lift first (it keeps their shadows apart), then a gain and offset that put the two ends of the value range into the bands.
3. **Light** (`lightPlugin.ts`, 300): the stage's ambient, key and rim.
4. **Outline** (`stylePlugin.ts` `OutlinePlugin`, 350): from the sprite's alpha edge, last, so neither the look nor the light tints it. Transparent pixels within the width of an opaque one become the outline colour (8 taps at the width on Low, two rings on High). Taps outside a clip-sheet frame's own cell count as empty, so a frame never outlines its neighbour.

The width is set every frame (`Renderer.sizeOutline`) from how big the fighter is on screen, so zoom and window size never change the px.

## Making and checking it

- `node tools/derive-style.mjs [--write]` reads every fighter's idle sheet (from git HEAD, like `derive-looks.mjs`), measures it, solves the remap, simulates it on the same pixels and prints the **style report**: per fighter, before > after for each range, the outline colour, and "N of 33 outside". Exit 1 while any fighter is outside. `--write` stores `style` (outline, hue, remap, before, after) in `content/fighters.json`.
- A **new fighter** goes through the same tool after its idle sheet exists. Run it after any change to an idle clip.
- `node src/game/test/style.test.ts` (in `npm test`) lists the fighters outside the ranges (must be 0), that every stored remap reproduces its numbers, that outlines are dark and coloured on every look, and the width rule.
- Playtest scenario `art-style` (phone: 390x844 turned to 844x390): the style report, the remap and outline pass on both fighters of a match for colour looks 1 to 4, the outline width the bible gives for the render height, and at least 1 px at 844x390.

## Portraits and the key art

- **One painted style** for the 33 portraits on character select, the VS card and the results: a three-quarter bust, rim-lit, on a dark broadcast-studio backdrop (near-black navy, soft stage lights), eyes on the upper third (about 28 to 38% from the top), the same face, outfit and colours as the fighter's `characters/large/<id>.webp`. Hawkes Gen `image.edit` (project `org_eb0d5c82e8da8c2d.doseofdestruction`, 1024x1024, seed 11, the prompt in `tools/portraits.md`), one job per fighter; the 1024 picture stays in Gen's library, the game ships WebP at 512 and 256 px: `characters/portrait/<id>-512.webp` and `<id>-256.webp` (`ui/dom.ts` `portraitUrl`, `portraitSize`: a phone-sized window loads the 256 px file).
- **Where they show:** select tiles and slot buttons (256, square, name under it, 64 px or more at 844x390), the select preview (512; hidden on a phone landscape), the VS plate (`.vs-portrait`) and the results hero (`.results-portrait`). Colour looks tint the VS and results copies through `paintImage`.
- **Key art:** one painted 1920x1080 picture, the Season 1 cast mid-brawl on City Top (`site/img/key-art-1920.webp|.jpg`, 1280 and 720 webp too; Gen `image.generate`, four candidates, best picked). It sits behind the logo on the title and the Tap to play card, centre-cropped on a phone, and is the share card (`og:image`). The brand gradient stays behind it, so the title is never flat black while it loads.
- Scenario `portraits` checks all of it (events `title-key-art`, `select-portraits`, `select-framing`, `select-names`, `select-phone-size`, `vs-portraits`, `results-portrait`, `results-same`).

## Report at the time of writing

Before the remap 24 of 33 fighters were outside the ranges (the 11 darkest, e.g. Slice, Dj Won't Read, Orchestrator, at a light end of 0.25 - 0.46; and the dullest, e.g. Uh Me, Susan, at mean saturation 0.16 - 0.19). After it, 0 of 33.

## Not in this part

- The portrait framing (eyes on the upper third) is checked by eye at bake time, not enforced in code: the runtime scenario checks every tile draws its square portrait at one size.
- The remap is measured on the idle sheet; a few clips (special effects drawn into the sheet) may sit slightly outside.
