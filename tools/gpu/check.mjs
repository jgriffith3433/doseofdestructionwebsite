// Read-only account check for the GPU service. Creates nothing.
//
//   node tools/gpu/check.mjs
//
// Prints who the AWS keys belong to, the GPU instance quotas, which GPU types
// the region offers, any GPU servers this project already runs, and whether
// the Docker Hub token works.

import { EC2Client, DescribeInstanceTypeOfferingsCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { awsConfig, readEnv } from './env.mjs';

// Quota codes for EC2 GPU capacity, counted in vCPUs.
const QUOTAS = {
  'L-DB2E81BA': 'On-Demand G and VT instances (vCPUs)',
  'L-3819A6DF': 'Spot G and VT instances (vCPUs)',
};
const TYPES = ['g6e.xlarge', 'g6e.2xlarge', 'g6e.4xlarge', 'g5.2xlarge', 'g6.2xlarge', 'g4dn.xlarge'];

export async function checkAccount() {
  const env = readEnv();
  const cfg = awsConfig(env);
  const out = { region: cfg.region };

  const id = await new STSClient(cfg).send(new GetCallerIdentityCommand({}));
  out.account = id.Account;
  out.arn = id.Arn;

  const sq = new ServiceQuotasClient(cfg);
  out.quotas = {};
  for (const [code, label] of Object.entries(QUOTAS)) {
    try {
      const q = await sq.send(new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: code }));
      out.quotas[label] = q.Quota?.Value ?? null;
    } catch (e) {
      out.quotas[label] = `unreadable (${e.name})`;
    }
  }

  const ec2 = new EC2Client(cfg);
  const offered = await ec2.send(new DescribeInstanceTypeOfferingsCommand({
    LocationType: 'availability-zone',
    Filters: [{ Name: 'instance-type', Values: TYPES }],
  }));
  out.offered = {};
  for (const o of offered.InstanceTypeOfferings ?? []) (out.offered[o.InstanceType] ??= []).push(o.Location);

  const mine = await ec2.send(new DescribeInstancesCommand({
    Filters: [{ Name: 'tag:Project', Values: ['dose-of-destruction'] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }],
  }));
  out.servers = (mine.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => ({ id: i.InstanceId, type: i.InstanceType, state: i.State?.Name }));

  out.dockerHub = await dockerHubLogin(env);
  return out;
}

/** Logs in to the Docker Hub API with the token (no local side effects). */
async function dockerHubLogin(env) {
  if (!env.DOCKER_HUB_USERNAME || !env.DOCKER_HUB_TOKEN) return 'not configured';
  const r = await fetch('https://hub.docker.com/v2/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.DOCKER_HUB_USERNAME, password: env.DOCKER_HUB_TOKEN }),
  });
  return r.ok ? `ok (${env.DOCKER_HUB_USERNAME})` : `failed (${r.status})`;
}

// Run directly (node tools/gpu/check.mjs), not when imported by the dev server.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/gpu/check.mjs')) {
  checkAccount()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(`${e.name}: ${e.message}`);
      process.exit(1);
    });
}
