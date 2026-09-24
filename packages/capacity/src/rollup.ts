import type { DeviceClass, SqlTx } from '@better-compute/core';
import { nodeBucket, type CapacityBucket, type EligibilityPool } from './eligibility.js';
import { readDevices, readNodeResources, readPoolNodes } from './store.js';

// pool_capacity_rollup (PLAN.md §10.2, §10.6): kept current by deltas in the booking transaction and
// rebuilt from the tables by the Rollup job, so reads never aggregate devices.

/** The rollup resource a device class books against: `gpu` for whole GPUs, else the class. */
export function rollupResource(deviceClass: DeviceClass | string): string {
  return deviceClass;
}

/** One pool's capacity for one resource. */
export interface PoolCapacity {
  poolId: string;
  /** `gpu` (and other device classes) or a scalar such as `vcpu`. */
  resource: string;
  /** Everything that counts toward the pool, in any bucket. */
  total: number;
  /** Schedulable and healthy (scalars: `floor(allocatable × ratio)` of schedulable nodes). */
  allocatable: number;
  /** Booked now (`during ∋ compute_now()`). */
  allocated: number;
  /** Booked for later (`lower(during) > compute_now()`). */
  reserved: number;
  /**
   * `max(0, allocatable − allocated − reserved)`: conservative, since an atom booked now and later
   * counts twice. Exact free capacity for a window comes from the placer's view, not the rollup.
   */
  available: number;
  provisioning: number;
  unhealthy: number;
  maintenance: number;
  unreachable: number;
  updatedAt: number;
}

type Counters = Omit<PoolCapacity, 'poolId' | 'resource' | 'available' | 'updatedAt'>;
const zero = (): Counters => ({
  total: 0,
  allocatable: 0,
  allocated: 0,
  reserved: 0,
  provisioning: 0,
  unhealthy: 0,
  maintenance: 0,
  unreachable: 0,
});

function addToBucket(counters: Counters, bucket: CapacityBucket, amount: number): void {
  if (bucket === 'excluded') return;
  counters.total += amount;
  if (bucket === 'schedulable') counters.allocatable += amount;
  else counters[bucket] += amount;
}

/** Recomputes a pool's rollup rows from nodes, devices, bookings and scalars, and stores them. */
export async function rebuildPoolRollup(
  tx: SqlTx,
  pool: EligibilityPool & { id: string },
): Promise<PoolCapacity[]> {
  const nodes = await readPoolNodes(tx, pool.id);
  const ids = nodes.map((node) => node.id);
  const buckets = new Map(nodes.map((node) => [node.id, nodeBucket(node, pool)]));
  const counters = new Map<string, Counters>([['gpu', zero()]]);
  const of = (resource: string) => {
    let entry = counters.get(resource);
    if (!entry) counters.set(resource, (entry = zero()));
    return entry;
  };

  const devices = (await readDevices(tx, ids)).filter((device) => device.bookable);
  const counted = new Map<string, string>();
  for (const device of devices) {
    const bucket = buckets.get(device.nodeId)!;
    if (bucket === 'excluded') continue;
    const resource = rollupResource(device.class);
    counted.set(device.id, resource);
    addToBucket(
      of(resource),
      bucket === 'schedulable' && !device.healthy ? 'unhealthy' : bucket,
      1,
    );
  }
  if (counted.size > 0) {
    // Bookings, not devices, exactly as the booking-transaction deltas count them: an atom booked
    // now and again later adds to both `allocated` and `reserved`.
    const { rows } = await tx.query<{
      device_id: string;
      now: string | number;
      later: string | number;
    }>(
      `SELECT device_id, count(*) FILTER (WHERE during @> compute_now()) AS now,
              count(*) FILTER (WHERE lower(during) > compute_now()) AS later
         FROM device_bookings WHERE device_id = ANY($1::text[]) AND upper(during) > compute_now()
        GROUP BY device_id`,
      [[...counted.keys()]],
    );
    for (const row of rows) {
      const entry = of(counted.get(row.device_id)!);
      entry.allocated += Number(row.now);
      entry.reserved += Number(row.later);
    }
  }

  for (const [nodeId, resources] of await readNodeResources(tx, ids)) {
    const bucket = buckets.get(nodeId)!;
    for (const [resource, scalar] of Object.entries(resources)) {
      if (bucket === 'excluded') continue;
      const entry = of(resource);
      addToBucket(entry, bucket, Math.floor(scalar.allocatable * scalar.ratio));
      entry.allocated += scalar.allocated;
    }
  }

  await tx.query(`DELETE FROM pool_capacity_rollup WHERE pool_id = $1`, [pool.id]);
  const entries = [...counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [resource, entry] of entries)
    await tx.query(
      `INSERT INTO pool_capacity_rollup (pool_id, resource, total, allocatable, allocated, reserved,
                                         provisioning, unhealthy, maintenance, unreachable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        pool.id,
        resource,
        entry.total,
        entry.allocatable,
        entry.allocated,
        entry.reserved,
        entry.provisioning,
        entry.unhealthy,
        entry.maintenance,
        entry.unreachable,
      ],
    );
  return readPoolCapacity(tx, pool.id);
}

export interface RollupDelta {
  allocated?: number;
  reserved?: number;
}

/** Adjusts one rollup row in the booking transaction (creating it when missing). */
export async function applyRollupDelta(
  tx: SqlTx,
  poolId: string,
  resource: string,
  delta: RollupDelta,
): Promise<void> {
  const allocated = delta.allocated ?? 0;
  const reserved = delta.reserved ?? 0;
  if (allocated === 0 && reserved === 0) return;
  await tx.query(
    `INSERT INTO pool_capacity_rollup (pool_id, resource, allocated, reserved)
     VALUES ($1, $2, GREATEST(0, $3::bigint), GREATEST(0, $4::bigint))
     ON CONFLICT (pool_id, resource) DO UPDATE
       SET allocated = GREATEST(0, pool_capacity_rollup.allocated + $3::bigint),
           reserved = GREATEST(0, pool_capacity_rollup.reserved + $4::bigint),
           updated_at = compute_now()`,
    [poolId, resource, allocated, reserved],
  );
}

interface RawRollup {
  pool_id: string;
  resource: string;
  total: string | number;
  allocatable: string | number;
  allocated: string | number;
  reserved: string | number;
  provisioning: string | number;
  unhealthy: string | number;
  maintenance: string | number;
  unreachable: string | number;
  updated_at_ms: number;
}

function toCapacity(row: RawRollup): PoolCapacity {
  const allocatable = Number(row.allocatable);
  const allocated = Number(row.allocated);
  const reserved = Number(row.reserved);
  return {
    poolId: row.pool_id,
    resource: row.resource,
    total: Number(row.total),
    allocatable,
    allocated,
    reserved,
    available: Math.max(0, allocatable - allocated - reserved),
    provisioning: Number(row.provisioning),
    unhealthy: Number(row.unhealthy),
    maintenance: Number(row.maintenance),
    unreachable: Number(row.unreachable),
    updatedAt: Number(row.updated_at_ms),
  };
}

const rollupColumns = `pool_id, resource, total, allocatable, allocated, reserved, provisioning,
  unhealthy, maintenance, unreachable, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_at_ms`;

/** A pool's rollup rows, ordered by resource. */
export async function readPoolCapacity(tx: SqlTx, poolId: string): Promise<PoolCapacity[]> {
  const { rows } = await tx.query<RawRollup>(
    `SELECT ${rollupColumns} FROM pool_capacity_rollup WHERE pool_id = $1 ORDER BY resource`,
    [poolId],
  );
  return rows.map(toCapacity);
}

/** Rollup rows of several pools, ordered by pool then resource. */
export async function readPoolsCapacity(
  tx: SqlTx,
  poolIds: readonly string[],
): Promise<PoolCapacity[]> {
  if (poolIds.length === 0) return [];
  const { rows } = await tx.query<RawRollup>(
    `SELECT ${rollupColumns} FROM pool_capacity_rollup WHERE pool_id = ANY($1::text[])
      ORDER BY pool_id, resource`,
    [poolIds],
  );
  return rows.map(toCapacity);
}
