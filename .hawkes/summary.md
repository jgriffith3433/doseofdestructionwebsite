# Show-branded transition system: part 2 (sound takes)

Already on beta (#172): `src/game/ui/stinger.ts` (0.58 s diagonal wipe, light streak, logo, hold loop, reduced-motion crossfade), ROUND START and GAME! slams (`main.ts` `slam()`), smoke scenario checks. No code changed this pass.

This pass: the Gen audio.sfx batches finished (j_4d886f934587 whoosh, j_47dcf4266f66 impact, 4 takes each). I judged them by measuring (duration, leading silence, level), since I can't listen:
- Whoosh: takes 1, 3 and 4 open with 1 s or more of near-silence and peak after the 0.58 s stinger is over, and take 1 peaks at -21 dB once trimmed, so they would land late. Takes 2 and 4 swell inside the first second. Both are trimmed to 1.1 s with a fade (take 4 +3 dB to match). They are `wipe.mp3` (take 2) and `wipe-1.mp3` (take 4), volume 0.5 -> 0.3 because they run about 5 dB hotter than the old stand-in. Takes 1 and 3 were not kept.
- Impact: all 4 kept, trimmed to 1.6 s with a fade (they ran 3-4 s). `vs-slam.mp3` is take 3 (punchiest), `vs-slam-1..3.mp3` are takes 4, 1 and 2. Volume 0.9 -> 0.4 because they run about 8 dB hotter than the old stand-in.
- Both are `takes` in `content/sounds.json`; the audio engine already picks among takes with no immediate repeat. `.hawkes/pending-gpu.txt` deleted. The old single-file stand-ins are replaced.

Checks: `npm test` runs, but 30 "line recorded: orchestrator.takeover.*" checks FAIL here only because this worktree is sparse (audio/voice isn't checked out; the files are tracked on main). Nothing I touched is involved. `npm run typecheck` could not run (typescript is not installed in this worktree); the change is JSON plus audio only.
GPU: the two batches (8 sfx takes) were within the $0.24 budget; see hawkesgen_jobs for the exact figure.
