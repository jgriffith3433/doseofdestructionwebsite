// Ask AWS for more on-demand GPU quota (free; AWS reviews it, usually within a day).
//
//   node tools/gpu/quota.mjs <vcpus> <region> [region...]   request
//   node tools/gpu/quota.mjs status <region> [region...]    open requests

import { ServiceQuotasClient, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryByQuotaCommand } from '@aws-sdk/client-service-quotas';
import { awsConfig, readEnv } from './env.mjs';

const QUOTA = { ServiceCode: 'ec2', QuotaCode: 'L-DB2E81BA' }; // Running On-Demand G and VT instances (vCPUs)

const [first, ...regions] = process.argv.slice(2);
if (!first || !regions.length) {
  console.error('usage: node tools/gpu/quota.mjs <vcpus|status> <region> [region...]');
  process.exit(1);
}
const { credentials } = awsConfig(readEnv());
for (const region of regions) {
  const sq = new ServiceQuotasClient({ region, credentials });
  try {
    if (first === 'status') {
      const r = await sq.send(new ListRequestedServiceQuotaChangeHistoryByQuotaCommand(QUOTA));
      const list = (r.RequestedQuotas ?? []).map((q) => `${q.DesiredValue} ${q.Status} (${q.Created?.toISOString().slice(0, 10)}${q.CaseId ? `, case ${q.CaseId}` : ''})`);
      console.log(`${region}: ${list.join('; ') || 'no requests'}`);
    } else {
      const r = await sq.send(new RequestServiceQuotaIncreaseCommand({ ...QUOTA, DesiredValue: Number(first) }));
      console.log(`${region}: requested ${r.RequestedQuota?.DesiredValue}, status ${r.RequestedQuota?.Status}`);
    }
  } catch (e) {
    console.log(`${region}: ${e.name}: ${e.message}`);
  }
}
