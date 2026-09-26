'use client';

import { RiDashboard3Line } from 'react-icons/ri';
import { fmtNum, fmtPct, siteById, topologyTotals } from '@/lib/data';
import { collectAttention } from '@/lib/modules';
import { useCapacityTotals } from '@/components/capacity/data';
import { useFleetSummary } from '@/components/fleet/summary';
import { useLive, useWorkspaceSettings, RANGES } from '@/components/shell/workspace';
import { PageHeader } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';

/** The Overview's header: one sentence that says whether the fleet is fine, then the dashboards below. */
export function OverviewHeader() {
  const { siteId, range, source } = useWorkspaceSettings();
  // The same numbers /capacity and /nodes show, from whichever source the workspace reads.
  const capacity = useCapacityTotals();
  const fleet = useFleetSummary();
  const items = useLive((now, scope) => collectAttention(now, scope, { source }), { bucketMs: 10_000, deps: [source] });
  const topology = topologyTotals(siteId ? { siteId } : undefined);
  const critical = items.filter((i) => i.severity === 'critical').length;
  const site = siteId ? siteById(siteId) : undefined;
  const util = fmtPct(capacity.gpus.utilization, 0);
  const free = fmtNum(capacity.gpus.freeNow);
  const pools = Object.keys(capacity.pools).length || topology.pools;
  return (
    <PageHeader
      icon={RiDashboard3Line}
      title={site ? `${site.name}` : 'Fleet overview'}
      description={
        critical
          ? `${critical} critical ${critical === 1 ? 'item needs' : 'items need'} an operator. GPU utilization is ${util} with ${free} GPUs free.`
          : `Nominal. GPU utilization is ${util} with ${free} GPUs free across ${pools} pools.`
      }
      meta={
        <>
          <Tag status={source === 'simulated' ? 'pending' : 'live'}>{source === 'simulated' ? 'simulated fleet' : 'live API'}</Tag>
          <Tag status="ok" led={false}>
            {source === 'live'
              ? `${fleet.unavailable ? '—' : fmtNum(fleet.nodes.total)} nodes · ${fmtNum(capacity.gpus.total)} GPUs`
              : `${topology.sites} sites · ${topology.pools} pools · ${fmtNum(topology.nodes)} nodes · ${fmtNum(topology.gpus)} GPUs`}
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
