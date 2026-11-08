**What was wrong:** the Babylon engine ran at the full device pixel ratio (`adaptToDeviceRatio` true) and the glow layer was always on, which is heavy on phones.

**What changed**
- `src/game/graphics.ts` (new): the settings (Quality High/Low, Glow, Show FPS), saved in localStorage `dod.gfx`, applied live through a listener. Touch devices default to Low with glow off. Desktop defaults to High with glow on, as before.
- `render/renderer.ts`: the engine now sets its own hardware scaling. The render is capped at 2x DPR on desktop and 1.5x on touch (Low: 1x). It updates on a setting change and on resize. Glow switches the glow layer on or off. Low halves the spark counts. The FPS readout is a small bottom-right box redrawn every 0.5 s from the engine's end-of-frame event, with no timers or polling.
- `Game/index.html`, `main.ts`: three Settings rows (Quality, Glow, Show FPS) that work from the main menu and from Pause. Analytics `settings.quality/glow/fps` events. The settings are also set as analytics context (`quality`, `glow`, `fps`).
- Playtest: new scenario `graphics` (`dod.ts`, `scenarios.ts`, bridge copy regenerated). It checks the device defaults, then flips Glow, Show FPS and Quality from Pause. It checks the render scale, the glow layer and the readout change with no reload, and that the choices are saved. It reports `fpsMatchHigh/Low` and `renderScale`. The playtest context (`hawkesPlaytest.state()`) isn't extended; the settings go in the scenario events and metrics instead.

**Checks:** `npm run typecheck` passes and `npm run build` ran. `npm test` has 33 failures, all missing `characters/head/*.webp`. They fail the same way on the untouched branch, so I left them. I did not run the scenarios here, since the instructions say not to start a browser.

**For J to look at**
- There are no shadows in this renderer, so "Low trims shadow work" only trims particles.
- The 45 fps criterion is judged by the playtest at phone size. I haven't measured it, so check `fpsMatchLow` in that run.
- Desktop with a device pixel ratio above 2 now renders at 2x, as asked.
- GPU: none needed (estimate $0).
