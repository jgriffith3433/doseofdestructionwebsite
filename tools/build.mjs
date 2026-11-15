// `npm run build`. Studio's build cell is small (about 512 MB for the whole process tree, npm included), so:
//   - Babylon is a checked-in file (vendor/babylon, tools/babylonVendor.mjs; `npm run vendor` rebuilds it, `npm test`
//     checks it matches the imports). Only when it is stale does pass 1 (tools/build-vendor.mjs) run first, as its own process.
//   - the game and site (vite.config.js) is one process. Where Node has process.execve (22.15+/23.11+), this script
//     becomes that process, so no orchestrator sits in memory beside it; else it is spawned with stdio inherited.
//   - one heap cap, no retry with a bigger one: a bigger cap goes over the cell's limit, which only turns a slow build into a kill.
import { spawnSync } from 'node:child_process';
import { vendorFresh } from './babylonVendor.mjs';

const HEAP_MB = 230; // pass 2 holds ~190 MB of syntax trees at its peak
const env = {
  ...process.env,
  // Go's GC (esbuild, a child of Vite) collects sooner: ~40 MB less at its peak, no measurable time cost.
  GOGC: process.env.GOGC ?? '25',
  GOMEMLIMIT: process.env.GOMEMLIMIT ?? '30MiB',
  // glibc hands freed memory back sooner (a few MB less at the peak).
  MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? '1',
  MALLOC_TRIM_THRESHOLD_: process.env.MALLOC_TRIM_THRESHOLD_ ?? '32768',
  MALLOC_MMAP_THRESHOLD_: process.env.MALLOC_MMAP_THRESHOLD_ ?? '32768',
};
const heap = (mb) => [`--max-old-space-size=${mb}`, '--max-semi-space-size=1', '--min-semi-space-size=1'];

if (!vendorFresh(process.cwd())) {
  console.log('[build] vendor/babylon is stale or missing: running the vendor pass first (npm run vendor, then commit vendor/)');
  const r = spawnSync(process.execPath, [...heap(240), 'tools/build-vendor.mjs'], { stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const args = [...heap(HEAP_MB), 'node_modules/vite/bin/vite.js', 'build'];
if (typeof process.execve === 'function') {
  process.execve(process.execPath, [process.execPath, ...args], env);
} else {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}
