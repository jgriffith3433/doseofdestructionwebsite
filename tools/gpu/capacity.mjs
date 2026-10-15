// Read-only: AWS's own guess at where GPU machines are free. Spot placement
// scores (1 to 10, per region) measure spare capacity for each type; on-demand
// launches tend to succeed where they are high. Creates nothing.
//
//   node tools/gpu/capacity.mjs [type...]

import { EC2Client, GetSpotPlacementScoresCommand } from '@aws-sdk/client-ec2';
import { awsConfig } from './env.mjs';
import { REGIONS } from './aws.mjs';

export const CANDIDATES = ['g6e.xlarge', 'g6e.2xlarge', 'g7e.2xlarge'];

const cache = new Map();

/** One type's scores by region, cached for 10 minutes (launches use it to pick where to try first). */
export async function scoresFor(type) {
  const hit = cache.get(type);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = (await capacityScores([type], REGIONS))[type] ?? {};
  cache.set(type, { at: Date.now(), value });
  return value;
}

/** { type: { region: score } } for the regions the server may use (and a few more). */
export async function capacityScores(types = CANDIDATES, regions = [...REGIONS, 'us-west-1', 'ca-central-1']) {
  const ec2 = new EC2Client(awsConfig());
  const out = {};
  for (const type of types) {
    const r = await ec2.send(new GetSpotPlacementScoresCommand({
      InstanceTypes: [type],
      TargetCapacity: 1,
      TargetCapacityUnitType: 'units',
      RegionNames: regions,
    }));
    out[type] = Object.fromEntries((r.SpotPlacementScores ?? []).map((s) => [s.Region, s.Score]));
  }
  return out;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/gpu/capacity.mjs')) {
  const types = process.argv.slice(2);
  capacityScores(types.length ? types : undefined)
    .then((scores) => {
      for (const [type, regions] of Object.entries(scores)) {
        console.log(type.padEnd(12), Object.entries(regions).map(([r, s]) => `${r} ${s}`).join('   ') || '(no scores)');
      }
    })
    .catch((e) => {
      console.error(`${e.name}: ${e.message}`);
      process.exit(1);
    });
}
