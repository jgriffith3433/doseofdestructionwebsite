# Open Mic v5: blocked on a Gen bug (video.scene portrait)
Answers Studio's v4 review (5-16 s as one rooftop scene instead of black-background portraits). Not done: the v4 cut is unchanged.
Done: the 3 reference images are judged and pass (empty rooftop a_1c0fddb80dcbdf63; Exit Punk a_cc6edf127e15980e; Shutup Bot a_e019bfe381e8a943, on-model, same 3D style), and the 14 s voice track with all five of J's lines is built.
Blocker: `video.scene` in portrait fails. j_4012fdf8139e was rejected by ComfyUI (no GPU spent): the H3 workflow only accepts '9:16 (Portrait Widescreen)', but Gen's param list only allows '9:16 (Portrait)' and refuses the right value up front. Fix is in Gen's video.scene aspect enum (not changed here, outside this task).
I did not fall back to 16:9: a centre-crop to 9:16 at 0.5 MP would be about 300x540 and lose one of the two characters.
Left: once Gen is fixed, one scene (~$0.65; GPU spent so far ~$1.90 of $2.67) then judge it and re-cut 5-16 s, walk-off with the dented bot, a "...Yes." caption, a bigger end card. Listed in .hawkes/pending-gpu.txt so Studio re-runs it.

## Re-checked (later pass)
Gen's video.scene `aspect` enum is still only `16:9 (Widescreen)` / `9:16 (Portrait)`, and `9:16 (Portrait Widescreen)` is refused up front, so the portrait scene still can't run. No GPU spent this pass; v4/v5 cut unchanged. Still listed in .hawkes/pending-gpu.txt for a re-run once Gen's enum is fixed (~$0.65 for the scene; ~$0.77 of the $2.67 budget left).
