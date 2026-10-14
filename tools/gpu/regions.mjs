// Read-only: each region the GPU server may use, with its GPU quota, open
// quota requests and the zones offering each instance type.
//
//   node tools/gpu/regions.mjs

import { regionsInfo } from './aws.mjs';

for (const r of await regionsInfo({ force: true })) {
  const reqs = r.requests.map((q) => `${q.value} ${q.status}`).join('; ') || 'none';
  const zones = Object.entries(r.zones).map(([t, z]) => `${t}: ${z.length}`).join(', ') || 'none';
  console.log(`${r.region.padEnd(10)} quota ${String(r.quota ?? '?').padEnd(3)} requests ${reqs.padEnd(22)} zones ${zones}${r.error ? `  (${r.error})` : ''}`);
}
