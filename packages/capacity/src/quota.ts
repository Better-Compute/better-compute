import { ComputeError, type DeviceRequest, type SqlTx } from '@better-compute/core';

// Quotas (PLAN.md §10.3, §10.4 point 5): guarded `used + n <= max` updates on `quota_usage`, whose
// rows `pools.offer` and `pools.create` create. A missing row grants 0. D9 (conservative): a
// reservation holds its charge from admission until it is terminal, `pending` included, so charges
// belong to the reservation lifecycle, not to individual placement attempts.
//
// Lock order, everywhere in capacity: quota_usage → pools → nodes → devices → node_resources →
// pool_capacity_rollup. Charges precede placement and refunds precede releases, so concurrent
// reserve and release transactions never wait on each other in a cycle.

/** What a request counts against quota, per resource: device classes by count, then scalars. */
export function quotaDemand(request: {
  devices: readonly DeviceRequest[];
  resources?: Readonly<Record<string, number>>;
}): Record<string, number> {
  const demand: Record<string, number> = {};
  for (const device of request.devices)
    if (device.count > 0) demand[device.class] = (demand[device.class] ?? 0) + device.count;
  for (const [resource, amount] of Object.entries(request.resources ?? {}))
    if (amount > 0) demand[resource] = (demand[resource] ?? 0) + amount;
  return demand;
}

let savepoints = 0;

/**
 * Charges `demand` to `(tenant, pool)` all-or-nothing. Throws `QUOTA_EXCEEDED` (details name the
 * resource, the limit and what is in use) and leaves every counter as it was.
 */
export async function chargeQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  demand: Readonly<Record<string, number>>,
): Promise<void> {
  const entries = Object.entries(demand).filter(([, amount]) => amount > 0);
  if (entries.length === 0) return;
  const savepoint = `capacity_quota_${++savepoints}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    for (const [resource, amount] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const { rowCount } = await tx.query(
        `UPDATE quota_usage SET used = used + $4
          WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3 AND used + $4 <= max`,
        [tenantId, poolId, resource, amount],
      );
      if (rowCount === 0) {
        const { rows } = await tx.query<{ max: string | number; used: string | number }>(
          `SELECT max, used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
          [tenantId, poolId, resource],
        );
        const max = rows[0] ? Number(rows[0].max) : 0;
        const used = rows[0] ? Number(rows[0].used) : 0;
        throw new ComputeError(
          'QUOTA_EXCEEDED',
          `Quota exceeded for ${resource} in pool ${poolId}: ${amount} requested, ${Math.max(0, max - used)} of ${max} left`,
          undefined,
          { resource, poolId, requested: amount, max, used },
        );
      }
    }
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

/** Returns a charge. Never drives a counter below 0, so a double refund cannot corrupt it. */
export async function refundQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  demand: Readonly<Record<string, number>>,
): Promise<void> {
  for (const [resource, amount] of Object.entries(demand)) {
    if (amount <= 0) continue;
    await tx.query(
      `UPDATE quota_usage SET used = GREATEST(0, used - $4)
        WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
      [tenantId, poolId, resource, amount],
    );
  }
}

/** One `quota_usage` row. */
export interface QuotaRow {
  tenantId: string;
  poolId: string;
  resource: string;
  max: number;
  used: number;
  available: number;
}

/**
 * Creates or resizes a quota row and returns the effective maximum. `used` is kept; a maximum below
 * it is raised to `used` (the table's `CHECK (used BETWEEN 0 AND max)`), so lowering a quota under
 * live reservations needs another `setQuota` once they release.
 */
export async function setQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  resource: string,
  max: number,
): Promise<number> {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new ComputeError('INVALID_INPUT', 'A quota must be a non-negative integer');
  const { rows } = await tx.query<{ max: string | number }>(
    `INSERT INTO quota_usage (tenant_id, pool_id, resource, max, used) VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (tenant_id, pool_id, resource) DO UPDATE SET max = GREATEST($4, quota_usage.used)
     RETURNING max`,
    [tenantId, poolId, resource, max],
  );
  return Number(rows[0]!.max);
}

/** A tenant's quota rows, optionally for one pool. */
export async function readQuotas(
  tx: SqlTx,
  tenantId: string,
  poolId?: string,
): Promise<QuotaRow[]> {
  const { rows } = await tx.query<{
    tenant_id: string;
    pool_id: string;
    resource: string;
    max: string | number;
    used: string | number;
  }>(
    `SELECT tenant_id, pool_id, resource, max, used FROM quota_usage
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) ORDER BY pool_id, resource`,
    [tenantId, poolId ?? null],
  );
  return rows.map((row) => {
    const max = Number(row.max);
    const used = Number(row.used);
    return {
      tenantId: row.tenant_id,
      poolId: row.pool_id,
      resource: row.resource,
      max,
      used,
      available: Math.max(0, max - used),
    };
  });
}
