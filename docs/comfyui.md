# ComfyUI on the GPU server: what we learned

Notes from getting the GPU server (tools/gpu, comfy/) to work reliably. Read
this before changing server flags, models or workflows.

## The machine

- **g6e.xlarge:** NVIDIA L40S with 46 GB usable VRAM, 4 vCPUs, **30 GB RAM**.
  The RAM, not the GPU, is the tight resource.
- **Disk:** 250 GB gp3. After setup about 45 GB is the OS, 48 GB swap and 90 GB
  models, leaving about 50 GB free.
- **First setup:** takes about 12 minutes in practice (the 90 GB of models
  download fast from Hugging Face). Later starts take a couple of minutes.
- **Capacity:** g6e machines are often unavailable. AWS's own error says to
  let it choose the zone, so `launchServer` tries without a zone first, then
  each zone, then each 48 GB type, then each region with quota.
  `node tools/gpu/capacity.mjs` prints AWS's capacity hints.

## ComfyUI memory flags (v0.40.0)

ComfyUI's default is **dynamic VRAM**: it stages model weights in host memory
and streams them to the GPU, keeping fp8 weights fp8.

| Flags | Result on a g6e.xlarge |
|---|---|
| defaults | **Hangs the server.** Weights are staged in *pinned* (locked) RAM: Qwen-Image-Edit 19.6 GB + its text encoder 7.9 GB = 27.5 GB of 30 GB, unswappable. SSH, nginx's upstream and ComfyUI all stop answering. No OOM in the kernel log, because pinned memory never triggers one. |
| `--highvram --disable-dynamic-vram --disable-pinned-memory` | Painting works, but **Wan runs out of GPU memory**. Without dynamic VRAM, fp8 weights load as 16-bit (a 14B fp8 model takes ~28 GB instead of 14), and highvram keeps Wan's high-noise model loaded while the low-noise one loads. |
| `--disable-dynamic-vram --disable-pinned-memory` | Wan still runs out of memory (the 16-bit problem). |
| **`--disable-pinned-memory`** | **Works for everything.** Qwen paint: 28 GB VRAM, RAM ~4 GB. Wan i2v (33 frames at 640): 34 GB VRAM, RAM ~4 GB, 70 s. |

So the server runs `main.py ... --disable-pinned-memory` on machines with
less than 100 GB RAM (bootstrap.sh decides by hardware). To check a running
server: GPU tab → Server log, or
`ssh -i .cache/gpu/<key>.pem ubuntu@<ip> 'systemctl cat comfyui; journalctl -u comfyui -n 50'`.

**Switching model families:** image (Qwen) and video (Wan) models don't fit on
the GPU together, so the job queue calls ComfyUI's `POST /free` whenever the
next job uses a different family (`FAMILY` in tools/gpu/jobs.mjs), and on its
first job after a restart. A switch costs about a minute of loading; jobs of
one kind back to back don't reload.

## Timings (L40S, models loaded)

| Job | Time |
|---|---|
| Backdrop take (1568×672, one pass) | ~14 s |
| Stage piece take (~1100×950, two passes) | ~25 s |
| First job after a family switch | +60–90 s (loading from disk) |
| Wan 2.2 i2v, 33 frames at 640×640 | ~70 s |
| Cutout on the dev PC (BiRefNet, CPU) | ~60 s; the white key used for clean backgrounds takes ~1 s |

## Painting stages with Qwen-Image-Edit 2511

What failed, and what works (tools/maps/paint.mjs, tools/gpu/workflows.mjs
`paintOver`):

1. **Giving it the concept image copies the concept.** Image 2 is treated as
   content, not style. The backdrop came back as the concept photo with small
   changes. **Fix:** pass a *mood board* (the concept shrunk to 40 px wide and
   blurred back up: palette and light, no layout), and describe the scene in
   words.
2. **The words "fighting game" paint fighters.** At cfg 1 (the 4-step
   Lightning LoRA) the negative prompt does nothing, so the prompt itself must
   not invite people: say "game environment art" and "an empty scene: nobody
   in it". Don't draw a dark band at the bottom of a backdrop blockout either;
   it gets painted as a floor with people on it.
3. **Full repaints drift to a three-quarter view.** Asked for a building or
   rooftop, Qwen paints it from above at an angle, whatever the prompt says
   ("orthographic", "side elevation"). That breaks alignment with the
   collision. Low denoise keeps the flat shapes but stays a gray box at 0.65
   to 0.75, and above 0.85 it drifts again. **Fix: two passes:**
   - The blockout is drawn in the stage's own colors (theme body/under/edge),
     with shading, grain and window grids on facades (stage_art.py
     `paint_texture`, `paint_windows`), so the start is close to the answer.
   - **Pass 1** at denoise **0.80** paints it while keeping every edge. This
     is a cliff, not a slope: in a sweep over three seeds, 0.80 (and 0.78)
     gave fits of 0.86–0.97 every time and 0.82 gave about 0.5, with or
     without window grids or the detail pass. With 4 steps, 0.82 probably
     starts the sampler one step earlier, which repaints enough to tilt.
   - **Pass 2** at 0.6 over the result adds detail and light ("refine image 1
     without moving anything").

   The defaults (pass 0.80, detail 0.6) live in content/generation.json
   "paint" (AI Settings → Painting stages; tools/gpu/settings.mjs has the
   defaults). A job's own settings override them. The detail pass barely
   moves the fit (±0.03 in the sweep); the guard keeps pass 1 when it does.
4. **Backdrops** repaint fully (denoise 1, one pass) over a sky-colored
   gradient: there's no alignment to keep.
5. **Cutouts:** pieces are painted on plain white. When the border is clean
   white, alpha comes from distance-to-white (`white_key`), which is instant
   and keeps dark structures. Otherwise BiRefNet runs, and on dark subjects it
   can throw away a whole dark building.

6. **Grain:** hard per-pixel noise in the blockout comes back as blocky,
   pixel-art squares after the detail pass. Keep it faint (±4) and blurred.
7. **Takes vary a lot, so they're measured.** The same settings give anything
   from a flat, perfectly aligned piece to a tilted one with the roof 100
   units low. Every take of a piece that draws platforms gets a **fit score**
   (`fit_score` in stage_art.py): for sampled columns of each platform, is
   there a transparent-to-solid edge within about 14 units of its y? Flat,
   aligned takes score 0.85 to 0.97; tilted ones 0.1 to 0.4. The Paint card
   shows it on each take and sorts the best first, and the stage piece makes 4
   takes per job (others 2). Below about 0.6 it will look off in the game.

   The low scores on City Top's most detailed takes came from pass 1 at 0.82,
   not from the detail pass or the window grids (see the sweep in point 3).
   Takes below the fit target (0.75) are painted again with a new seed, up to
   2 times, and the one that lands better of pass 1 and pass 2 is kept.

Seeds: a take's file is `<piece>-<seed>.webp`, so two jobs with the same seed
overwrite each other. Leave the seed blank for experiments.

## Models

All fp8, listed in comfy/models.json, about 90 GB:

- **Wan 2.2 14B i2v:** high-noise and low-noise experts, plus their 4-step
  Lightx2v LoRAs.
- **Wan 2.2 Animate 14B:** Kijai fp8_scaled, plus the Lightx2v distill LoRA and
  clip_vision_h.
- **Qwen-Image-Edit 2511:** fp8mixed, plus the 4-step Lightning LoRA, the
  qwen_2.5_vl_7b text encoder and the Qwen VAE.
- **Shared:** umt5_xxl text encoder and the Wan 2.1 VAE.

Every workflow is checked against the server's `/object_info` before it runs
(`Comfy.prepare`), so a missing node, input or model file fails fast with a
clear message.

## Things to try next

- More detail at 0.80: richer blockouts (trim, signage, brick bands) and a
  third, gentler pass.
- Pass Claude's silhouettes as a separate line-art image (image 3) so pass 2
  has the edges to hold on to.

- More detail in blockouts: brick and trim patterns, signs, per-piece colors
  from Claude.
- A per-piece "detail" strength in AI Settings (pass 2), and per-stage
  overrides.
- GPU-side cutouts (rembg on the server) to drop the CPU minute for
  non-white backgrounds.
- Wan Animate needs a motion library clip; test it once one exists.
