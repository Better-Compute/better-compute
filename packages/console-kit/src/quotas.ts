import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// The tenant's quotas (PLAN.md §10.2, `quotas.get`): per pool and resource, how much is used of the
// maximum, with a level a view colors (warning from 80 %), and a pre-check the reservation form uses
// to say "2 of 8 GPUs left in this pool" before the server refuses with QUOTA_EXCEEDED.

export interface QuotaRowInput {
  poolId: string;
  resource: string;
  max: number;
  used: number;
  available?: number;
}

export interface QuotaMeter {
  resource: string;
  max: number;
  used: number;
  available: number;
  /** used / max (1 when max is 0). */
  ratio: number;
  level: 'ok' | 'warning' | 'full';
}

export interface QuotaView {
  pools: { poolId: string; meters: QuotaMeter[] }[];
  /** Meters at warning or full, most used first. */
  alerts: (QuotaMeter & { poolId: string })[];
}

export function quotaView(
  rows: readonly QuotaRowInput[],
  options: { warnAt?: number } = {},
): QuotaView {
  const warnAt = options.warnAt ?? 0.8;
  const pools = new Map<string, QuotaMeter[]>();
  for (const row of rows) {
    const available = row.available ?? Math.max(0, row.max - row.used);
    const ratio = row.max > 0 ? Math.min(1, row.used / row.max) : 1;
    const meter: QuotaMeter = {
      resource: row.resource,
      max: row.max,
      used: row.used,
      available,
      ratio,
      level: available <= 0 ? 'full' : ratio >= warnAt ? 'warning' : 'ok',
    };
    pools.set(row.poolId, [...(pools.get(row.poolId) ?? []), meter]);
  }
  const grouped = [...pools]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([poolId, meters]) => ({
      poolId,
      meters: meters.sort((a, b) => a.resource.localeCompare(b.resource)),
    }));
  return {
    pools: grouped,
    alerts: grouped
      .flatMap((pool) => pool.meters.map((meter) => ({ ...meter, poolId: pool.poolId })))
      .filter((meter) => meter.level !== 'ok')
      .sort((a, b) => b.ratio - a.ratio || a.poolId.localeCompare(b.poolId)),
  };
}

/**
 * Whether `request` (resource → amount) fits the quota left in `poolId`. A resource without a quota
 * row is not limited here (the server has the last word either way).
 */
export function quotaHint(
  rows: readonly QuotaRowInput[],
  poolId: string,
  request: Readonly<Record<string, number>>,
): { fits: boolean; short: { resource: string; requested: number; available: number }[] } {
  const short = Object.entries(request).flatMap(([resource, requested]) => {
    const row = rows.find((entry) => entry.poolId === poolId && entry.resource === resource);
    if (!row) return [];
    const available = row.available ?? Math.max(0, row.max - row.used);
    return requested > available ? [{ resource, requested, available }] : [];
  });
  return { fits: short.length === 0, short };
}

export function createQuotaView(
  api: ComputeRequester,
  options: { tenantId: string; poolId?: string; warnAt?: number },
): ValueResource<QuotaView & { rows: QuotaRowInput[] }> {
  return createValueResource({
    load: async (signal) => {
      const { items } = await api.$request<{ items: QuotaRowInput[] }>(
        'quotas/get',
        { tenantId: options.tenantId, ...(options.poolId ? { poolId: options.poolId } : {}) },
        { signal },
      );
      return {
        ...quotaView(items, options.warnAt !== undefined ? { warnAt: options.warnAt } : {}),
        rows: items,
      };
    },
  });
}
