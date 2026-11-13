# Portrait recipe (Hawkes Gen)

Project `org_eb0d5c82e8da8c2d.doseofdestruction`, tool `image.edit`, `width` 1024, `height` 1024, `seed` 11, image 1 =
`characters/large/<id>.webp`. Prompt:

> Repaint this fighting-game character as a character-select portrait: a three-quarter bust (head, shoulders and upper
> chest) in a single consistent painted illustration style, rich digital brush painting with clean confident shapes and
> soft detail. The head is turned slightly three-quarter toward the camera, centred, with the eyes on the upper third of
> the frame, the head filling the upper half of the picture and the shoulders and chest cropped by the bottom edge.
> Strong rim light in a cool accent colour on the edges of the head and shoulders. Dark broadcast-studio backdrop:
> near-black navy with faint out-of-focus stage lights. Keep exactly the same face, outfit, colours, markings and
> accessories as the reference character; do not redesign or recolour anything. No text, no logo, no border, no watermark.

Bake: `studio_gen_import` (square 512, webp q86) into `characters/portrait/<id>-512.webp`, then
`node tools/bake-portraits.mjs` writes the 256 px files with ffmpeg.
