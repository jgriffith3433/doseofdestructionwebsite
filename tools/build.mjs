// `npm run build`: two small passes instead of one big one, so Studio's small build cell never holds the whole graph
// (one pass peaked at ~600 MB, with the heap capped at 460 MB; see tools/babylonVendor.mjs). Each pass is its own process:
//   1. tools/build-vendor.mjs  Babylon's used names in one file (needs a ~200 MB heap)
//   2. vite.config.js          the game and site, reading that file (needs a ~220 MB heap)
// A pass that runs out of heap (a bigger game, a slower machine) is run again with a bigger cap, up to the old 460 MB,
// so a growing bundle slows the build before it ever fails it.
import { spawnSync } from 'node:child_process';

const CAPS = [240, 330, 460]; // --max-old-space-size, MB
// esbuild (a Go child of Vite) collects garbage sooner: ~40 MB less at its peak, no measurable time cost.
const env = { ...process.env, GOGC: process.env.GOGC ?? '25' };

for (const args of [['tools/build-vendor.mjs'], ['node_modules/vite/bin/vite.js', 'build']]) {
  let status = 1;
  for (const cap of CAPS) {
    const heap = [`--max-old-space-size=${cap}`, '--max-semi-space-size=1', '--min-semi-space-size=1'];
    const r = spawnSync(process.execPath, [...heap, ...args], { stdio: 'inherit', env });
    status = r.status ?? 1;
    if (status === 0) break;
    console.log(`[build] ${args[0]} failed with the heap at ${cap} MB (${r.signal ?? `exit ${status}`})${cap === CAPS.at(-1) ? '' : ': again with more'}`);
  }
  if (status !== 0) process.exit(status);
}
