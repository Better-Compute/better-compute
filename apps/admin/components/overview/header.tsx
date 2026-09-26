'use client';

import { RiDashboard3Line } from 'react-icons/ri';
import { capacityTotals, fmtNum, fmtPct, siteById, topologyTotals } from '@/lib/data';
import { collectAttention } from '@/lib/modules';
import { useLive, useWorkspace, RANGES } from '@/components/shell/workspace';
import { PageHeader } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';

/** The Overview's header: one sentence that says whether the fleet is fine, then the dashboards below. */
export function OverviewHeader() {
  const { siteId, range, source } = useWorkspace();
  const capacity = useLive((now, scope) => capacityTotals(now, scope), { bucketMs: 15_000 });
  const pulse = { gpuUtilization: capacity.gpus.utilization, gpus: { available: capacity.gpus.freeNow } };
  const items = useLive((now, scope) => collectAttention(now, scope), { bucketMs: 10_000 });
  const totals = topologyTotals(siteId ? { siteId } : undefined);
  const critical = items.filter((i) => i.severity === 'critical').length;
  const site = siteId ? siteById(siteId) : undefined;
  return (
    <PageHeader
      icon={RiDashboard3Line}
      title={site ? `${site.name}` : 'Fleet overview'}
      description={
        critical
          ? `${critical} critical ${critical === 1 ? 'item needs' : 'items need'} an operator. GPU utilization is ${fmtPct(pulse.gpuUtilization, 0)} with ${fmtNum(pulse.gpus.available)} GPUs free.`
          : `Nominal. GPU utilization is ${fmtPct(pulse.gpuUtilization, 0)} with ${fmtNum(pulse.gpus.available)} GPUs free across ${totals.pools} pools.`
      }
      meta={
        <>
          <Tag status={source === 'simulated' ? 'pending' : 'live'}>{source === 'simulated' ? 'simulated fleet' : 'live'}</Tag>
          <Tag status="ok" led={false}>
            {totals.sites} sites · {totals.pools} pools · {fmtNum(totals.nodes)} nodes · {fmtNum(totals.gpus)} GPUs
          </Tag>
          <Tag status="ok" led={false}>
            {RANGES[range].label.toLowerCase()}
          </Tag>
          {critical > 0 && <Tag status="crit">{critical} critical</Tag>}
        </>
      }
    />
  );
}
