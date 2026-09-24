// Chart models over `capacity.summary` (PLAN.md §10.6 rollups): one row per pool for a resource
// (GPUs by default), with the buckets a stacked bar needs, and totals per GPU model. Numbers only;
// colors and layout belong to the view.

/** One rollup row as `capacity.summary` returns it (capacity's `PoolCapacity`). */
export interface CapacityRollupRow {
  resource: string;
  total: number;
  allocatable: number;
  allocated: number;
  reserved: number;
  available: number;
  provisioning?: number;
  unhealthy?: number;
  maintenance?: number;
  unreachable?: number;
}

export interface CapacitySummaryInput {
  pools: { poolId: string; gpuModel: string; owned: boolean; capacity: CapacityRollupRow[] }[];
}

export interface CapacityBar {
  poolId: string;
  gpuModel: string;
  owned: boolean;
  /** The stacked buckets; they add up to `total`. */
  allocated: number;
  reserved: number;
  available: number;
  /** Counted in the pool but not schedulable now (provisioning, unhealthy, maintenance, unreachable). */
  unavailable: number;
  total: number;
  /** allocated / allocatable, 0 when nothing is allocatable. */
  utilization: number;
}

export interface CapacityChart {
  resource: string;
  bars: CapacityBar[];
  byGpuModel: {
    gpuModel: string;
    total: number;
    allocated: number;
    reserved: number;
    available: number;
    utilization: number;
  }[];
  totals: {
    total: number;
    allocated: number;
    reserved: number;
    available: number;
    utilization: number;
  };
}

const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);

export function capacityChart(
  summary: CapacitySummaryInput,
  options: { resource?: string; sort?: 'utilization' | 'total' | 'pool' } = {},
): CapacityChart {
  const resource = options.resource ?? 'gpu';
  const bars: CapacityBar[] = summary.pools.flatMap((pool) => {
    const row = pool.capacity.find((entry) => entry.resource === resource);
    if (!row) return [];
    // The buckets must add up to the total even when `available` is conservative (§10.6).
    const allocated = Math.min(row.allocated, row.total);
    const reserved = Math.min(row.reserved, row.total - allocated);
    const available = Math.min(row.available, row.total - allocated - reserved);
    return [
      {
        poolId: pool.poolId,
        gpuModel: pool.gpuModel,
        owned: pool.owned,
        allocated,
        reserved,
        available,
        unavailable: Math.max(0, row.total - allocated - reserved - available),
        total: row.total,
        utilization: ratio(row.allocated, row.allocatable),
      },
    ];
  });
  const sort = options.sort ?? 'utilization';
  bars.sort((a, b) =>
    sort === 'pool'
      ? a.poolId.localeCompare(b.poolId)
      : sort === 'total'
        ? b.total - a.total || a.poolId.localeCompare(b.poolId)
        : b.utilization - a.utilization || a.poolId.localeCompare(b.poolId),
  );
  const models = new Map<
    string,
    { total: number; allocated: number; reserved: number; available: number; allocatable: number }
  >();
  const totals = { total: 0, allocated: 0, reserved: 0, available: 0, allocatable: 0 };
  for (const pool of summary.pools) {
    const row = pool.capacity.find((entry) => entry.resource === resource);
    if (!row) continue;
    const model = models.get(pool.gpuModel) ?? {
      total: 0,
      allocated: 0,
      reserved: 0,
      available: 0,
      allocatable: 0,
    };
    for (const target of [model, totals]) {
      target.total += row.total;
      target.allocated += row.allocated;
      target.reserved += row.reserved;
      target.available += row.available;
      target.allocatable += row.allocatable;
    }
    models.set(pool.gpuModel, model);
  }
  return {
    resource,
    bars,
    byGpuModel: [...models]
      .map(([gpuModel, model]) => ({
        gpuModel,
        total: model.total,
        allocated: model.allocated,
        reserved: model.reserved,
        available: model.available,
        utilization: ratio(model.allocated, model.allocatable),
      }))
      .sort((a, b) => b.total - a.total || a.gpuModel.localeCompare(b.gpuModel)),
    totals: {
      total: totals.total,
      allocated: totals.allocated,
      reserved: totals.reserved,
      available: totals.available,
      utilization: ratio(totals.allocated, totals.allocatable),
    },
  };
}
