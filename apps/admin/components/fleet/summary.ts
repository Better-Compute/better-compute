'use client';

import { useMemo } from 'react';
import { useConnection } from '@/components/shell/connection';
import { useNow, useWorkspaceSettings, useScope } from '@/components/shell/workspace';
import { liveHealth } from '@/lib/data/fleet-live';
import { fleetPulse } from '@/lib/data/platform';
import { useLiveFleet } from './live';

// Node counts for other modules (the Overview's KPIs, fleet wall, sites): the live API's nodes when the
// workspace is live, poolPulse otherwise. Same buckets as fleet-health.ts.

export interface NodeCounts {
  total: number;
  ready: number;
  degraded: number;
  offline: number;
  provisioning: number;
}
export interface FleetSummary {
  nodes: NodeCounts;
  byPool: Record<string, NodeCounts>;
  source: 'simulated' | 'live';
  /** Live only: the nodes API failed, so the counts are empty rather than zero. */
  unavailable?: boolean;
}

const empty = (): NodeCounts => ({ total: 0, ready: 0, degraded: 0, offline: 0, provisioning: 0 });

export function useFleetSummary(): FleetSummary {
  const now = useNow(10_000);
  const { source } = useWorkspaceSettings();
  const scope = useScope();
  const connection = useConnection();
  const live = source === 'live';
  const liveState = useLiveFleet(live, connection.status?.tenantId);
  const bucket = Math.floor(now / 10_000) * 10_000;
  return useMemo(() => {
    if (live) {
      const nodes = empty();
      const byPool: Record<string, NodeCounts> = {};
      for (const node of liveState.parts?.nodes ?? []) {
        if (scope.siteId && node.siteId !== scope.siteId) continue;
        const health = liveHealth(node);
        const pool = (byPool[node.poolId ?? 'unpooled'] ??= empty());
        for (const counts of [nodes, pool]) {
          counts.total += 1;
          counts[health] += 1;
        }
      }
      return { nodes, byPool, source: 'live', ...(liveState.errors.nodes || !liveState.parts ? { unavailable: true } : {}) };
    }
    const pulse = fleetPulse(bucket, scope);
    const byPool: Record<string, NodeCounts> = {};
    for (const pool of pulse.pools) byPool[pool.pool.id] = { total: pool.pool.nodes, ...pool.nodes };
    return { nodes: { ...pulse.nodes }, byPool, source: 'simulated' };
  }, [live, liveState.parts, liveState.errors.nodes, bucket, scope]);
}
