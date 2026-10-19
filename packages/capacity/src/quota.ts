import { ComputeError, type DeviceRequest, type SqlTx } from '@better-compute/core';

// Quotas (PLAN.md §10.3, §10.4 point 5): guarded `used + n <= max` updates on `quota_usage`, whose
// rows `pools.offer` and `pools.create` create. A missing row grants 0. D9 (conservative): a
// reservation holds its charge from admission until it is terminal, `pending` included, so charges
// belong to the reservation lifecycle, not to individual placement attempts.
//
// (U-02) Two kinds of rows limit nothing when they are missing: tenant-level rows (`pool_id = '*'`,
// the tenant's total over every pool) and counted resources (`instances`, `sandboxes`). A row may
// carry a flavor allowlist (`quota_usage.flavors`), checked at admission (`assertFlavorEntitled`).
//
// Lock order, everywhere in capacity: quota_usage → pools → nodes → devices → node_resources →
// pool_capacity_rollup. Charges precede placement and refunds precede releases, so concurrent
// reserve and release transactions never wait on each other in a cycle. Among quota rows: counted
// resources first, the tenant row before the pool's, then by resource (`lockRank`).

/**
 * What a scalar counts against quota as (§3.8): hugepages are memory, so hugepage-backed memory
 * charges `memoryGiB` (1 GiB pages one each, 2 MiB pages 512 to the GiB, rounded up) and offers need
 * no hugepage quota rows.
 */
export function quotaScalar(resource: string, amount: number): [string, number] {
  if (resource === 'hugepages1Gi') return ['memoryGiB', amount];
  if (resource === 'hugepages2Mi') return ['memoryGiB', Math.ceil(amount / 512)];
  return [resource, amount];
}

/**
 * What a request counts against quota, per resource: device classes by count, then scalars
 * (`quotaScalar`); a gang counts once for all its nodes (`size` × the per-node request).
 */
export function quotaDemand(request: {
  devices: readonly DeviceRequest[];
  resources?: Readonly<Record<string, number>>;
  gang?: { size: number };
}): Record<string, number> {
  const demand: Record<string, number> = {};
  const nodes = request.gang?.size ?? 1;
  for (const device of request.devices)
    if (device.count > 0) demand[device.class] = (demand[device.class] ?? 0) + device.count * nodes;
  for (const [name, count] of Object.entries(request.resources ?? {})) {
    if (!(count > 0)) continue;
    const [resource, amount] = quotaScalar(name, count);
    demand[resource] = (demand[resource] ?? 0) + amount * nodes;
  }
  return demand;
}

let savepoints = 0;

/**
 * The pool id of a tenant-level (cross-pool) quota row: `(tenant, '*', resource)` limits the tenant's
 * total over every pool. Such a row is optional (a missing one limits nothing) and moves with the
 * pool rows: every charge and refund of `resource` on any of the tenant's pools also charges or
 * refunds the tenant row when it exists, and a `gpu` charge on a pool with a `gpuModel` also charges
 * `gpu.<gpuModel>` there. A tenant row set later starts at the tenant's current total
 * (`setQuota`), so it stays the sum of the pool rows.
 */
export const tenantQuotaScope = '*';

/**
 * Counted resources: one per instance, one per sandbox. Unlike scalars, a missing row limits
 * nothing, on a pool or on the tenant, and the holder records what a charge took (`chargeQuota`
 * returns it) to refund exactly that: a row set later counts the work admitted from then on.
 */
export const countQuotaResources: readonly string[] = Object.freeze(['sandboxes', 'instances']);

/** The key a recorded charge of a tenant-level counted row uses (`*:instances`). */
export const tenantQuotaKey = (resource: string): string => `${tenantQuotaScope}:${resource}`;

/** Lock order of quota rows: counted resources first (in `countQuotaResources` order), then scalars. */
function lockRank(resource: string): number {
  const index = countQuotaResources.indexOf(resource);
  return index === -1 ? countQuotaResources.length : index;
}

interface QuotaTarget {
  poolId: string;
  resource: string;
  amount: number;
  /** A missing row limits nothing (tenant rows, counted resources). */
  optional: boolean;
  /** The key the holder records a counted charge under; scalars are not recorded (refunds recompute them). */
  record?: string;
}

function compareTargets(a: QuotaTarget, b: QuotaTarget): number {
  const rank = lockRank(a.resource) - lockRank(b.resource);
  if (rank !== 0) return rank;
  if (a.poolId !== b.poolId) {
    if (a.poolId === tenantQuotaScope) return -1;
    if (b.poolId === tenantQuotaScope) return 1;
    return a.poolId < b.poolId ? -1 : 1;
  }
  return a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0;
}

/** The pool's GPU model, for the tenant's `gpu.<model>` row (an unlocked read). */
async function poolGpuModel(tx: SqlTx, poolId: string): Promise<string | undefined> {
  if (poolId === tenantQuotaScope) return undefined;
  const { rows } = await tx.query<{ gpu_model: string | null }>(
    `SELECT gpu_model FROM pools WHERE id = $1`,
    [poolId],
  );
  return rows[0]?.gpu_model ?? undefined;
}

/** The rows a charge (or the refund of a recorded charge) touches, in lock order. */
async function quotaTargets(
  tx: SqlTx,
  poolId: string,
  demand: Readonly<Record<string, number>>,
): Promise<QuotaTarget[]> {
  const targets: QuotaTarget[] = [];
  let model: string | undefined | null = null;
  for (const [resource, amount] of Object.entries(demand)) {
    if (!(amount > 0)) continue;
    if (resource.startsWith(`${tenantQuotaScope}:`)) {
      // A recorded tenant-level count (a refund of `chargeQuota`'s result).
      targets.push({
        poolId: tenantQuotaScope,
        resource: resource.slice(tenantQuotaScope.length + 1),
        amount,
        optional: true,
      });
      continue;
    }
    if (countQuotaResources.includes(resource)) {
      targets.push({ poolId, resource, amount, optional: true, record: resource });
      targets.push({
        poolId: tenantQuotaScope,
        resource,
        amount,
        optional: true,
        record: tenantQuotaKey(resource),
      });
      continue;
    }
    targets.push({ poolId, resource, amount, optional: false });
    targets.push({ poolId: tenantQuotaScope, resource, amount, optional: true });
    if (resource === 'gpu') {
      if (model === null) model = await poolGpuModel(tx, poolId);
      if (model !== undefined)
        targets.push({
          poolId: tenantQuotaScope,
          resource: `gpu.${model}`,
          amount,
          optional: true,
        });
    }
  }
  return targets.sort(compareTargets);
}

/**
 * Charges `demand` to `(tenant, pool)` all-or-nothing, with the tenant-level rows that exist
 * (`tenantQuotaScope`). Throws `QUOTA_EXCEEDED` (details name the resource, the pool or `*`, the
 * scope, the limit and what is in use) and leaves every counter as it was.
 *
 * Returns what was charged, for holders that record it: every scalar of `demand`, and each counted
 * resource (`countQuotaResources`) only where a row existed, the tenant's under `*:<resource>`.
 * `refundQuota` with that record takes back exactly the charge.
 */
export async function chargeQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  demand: Readonly<Record<string, number>>,
): Promise<Record<string, number>> {
  const charged: Record<string, number> = {};
  // A `*:` key is a record of an earlier charge, never something to charge.
  const fresh = Object.fromEntries(
    Object.entries(demand).filter(([resource]) => !resource.startsWith(`${tenantQuotaScope}:`)),
  );
  const targets = await quotaTargets(tx, poolId, fresh);
  if (targets.length === 0) return charged;
  const savepoint = `capacity_quota_${++savepoints}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    for (const target of targets) {
      const { rowCount } = await tx.query(
        `UPDATE quota_usage SET used = used + $4
          WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3 AND used + $4 <= max`,
        [tenantId, target.poolId, target.resource, target.amount],
      );
      if (rowCount === 0) {
        const { rows } = await tx.query<{ max: string | number; used: string | number }>(
          `SELECT max, used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
          [tenantId, target.poolId, target.resource],
        );
        if (!rows[0] && target.optional) continue;
        const max = rows[0] ? Number(rows[0].max) : 0;
        const used = rows[0] ? Number(rows[0].used) : 0;
        const tenantWide = target.poolId === tenantQuotaScope;
        throw new ComputeError(
          'QUOTA_EXCEEDED',
          `Quota exceeded for ${target.resource} ${tenantWide ? 'across the tenant' : `in pool ${target.poolId}`}: ${target.amount} requested, ${Math.max(0, max - used)} of ${max} left`,
          undefined,
          {
            resource: target.resource,
            poolId: target.poolId,
            scope: tenantWide ? 'tenant' : 'pool',
            requested: target.amount,
            max,
            used,
          },
        );
      }
      if (target.record !== undefined) charged[target.record] = target.amount;
    }
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
  for (const [resource, amount] of Object.entries(fresh))
    if (amount > 0 && !countQuotaResources.includes(resource)) charged[resource] = amount;
  return charged;
}

/**
 * Returns a charge: scalars on the pool and on the tenant rows that exist; counted resources only
 * as the charge recorded them (`chargeQuota`'s result: `instances` on the pool, `*:instances` on the
 * tenant). Never drives a counter below 0, so a double refund cannot corrupt it.
 */
export async function refundQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  demand: Readonly<Record<string, number>>,
): Promise<void> {
  for (const target of await quotaTargets(tx, poolId, demand)) {
    // A recorded pool count says nothing about the tenant row: that has its own `*:` key when charged.
    if (target.record !== undefined && target.poolId === tenantQuotaScope) continue;
    await tx.query(
      `UPDATE quota_usage SET used = GREATEST(0, used - $4)
        WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
      [tenantId, target.poolId, target.resource, target.amount],
    );
  }
}

/** One `quota_usage` row. `poolId` is `*` for a tenant-level row. */
export interface QuotaRow {
  tenantId: string;
  poolId: string;
  resource: string;
  max: number;
  used: number;
  available: number;
  /** (U-02) The flavors that may consume this row; absent: every flavor. */
  flavors?: string[];
}

/**
 * What a new tenant-level row starts at: the tenant's current total of the resource over its pool
 * rows (`gpu.<model>`: its `gpu` on pools of that model), read under lock so that charges in flight
 * on those rows are counted once they commit. Counted resources start at 0 (they count from now).
 */
async function tenantTotal(tx: SqlTx, tenantId: string, resource: string): Promise<number> {
  if (countQuotaResources.includes(resource)) return 0;
  const model = resource.startsWith('gpu.') ? resource.slice(4) : undefined;
  const { rows } =
    model !== undefined
      ? await tx.query<{ used: string | number }>(
          `SELECT q.used FROM quota_usage q JOIN pools p ON p.id = q.pool_id
            WHERE q.tenant_id = $1 AND q.resource = 'gpu' AND p.gpu_model = $2
            ORDER BY q.pool_id FOR UPDATE OF q`,
          [tenantId, model],
        )
      : await tx.query<{ used: string | number }>(
          `SELECT used FROM quota_usage
            WHERE tenant_id = $1 AND resource = $2 AND pool_id <> $3
            ORDER BY pool_id FOR UPDATE`,
          [tenantId, resource, tenantQuotaScope],
        );
  return rows.reduce((sum, row) => sum + Number(row.used), 0);
}

/**
 * Creates or resizes a quota row and returns the effective maximum. `used` is kept; a maximum below
 * it is raised to `used` (the table's `CHECK (used BETWEEN 0 AND max)`), so lowering a quota under
 * live reservations needs another `setQuota` once they release. A new tenant-level row
 * (`poolId: '*'`) starts at the tenant's current total.
 *
 * `options.flavors`: the row's flavor allowlist; `null` clears it, omitted keeps it.
 */
export async function setQuota(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  resource: string,
  max: number,
  options: { flavors?: readonly string[] | null } = {},
): Promise<number> {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new ComputeError('INVALID_INPUT', 'A quota must be a non-negative integer');
  let used = 0;
  if (poolId === tenantQuotaScope) {
    const { rows: present } = await tx.query(
      `SELECT 1 FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
      [tenantId, poolId, resource],
    );
    if (present.length === 0) used = await tenantTotal(tx, tenantId, resource);
  }
  const flavors = options.flavors === undefined ? undefined : options.flavors;
  const { rows } = await tx.query<{ max: string | number }>(
    `INSERT INTO quota_usage (tenant_id, pool_id, resource, max, used, flavors)
     VALUES ($1, $2, $3, GREATEST($4::bigint, $5::bigint), $5, $7::text[])
     ON CONFLICT (tenant_id, pool_id, resource) DO UPDATE SET max = GREATEST($4, quota_usage.used),
       flavors = CASE WHEN $6 THEN EXCLUDED.flavors ELSE quota_usage.flavors END
     RETURNING max`,
    [tenantId, poolId, resource, max, used, flavors !== undefined, flavors ? [...flavors] : null],
  );
  return Number(rows[0]!.max);
}

/** A tenant's quota rows, optionally for one pool (`*`: the tenant-level rows). */
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
    flavors: string[] | null;
  }>(
    `SELECT tenant_id, pool_id, resource, max, used, flavors FROM quota_usage
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) ORDER BY pool_id, resource`,
    [tenantId, poolId ?? null],
  );
  return rows.map((row) => {
    const max = Number(row.max);
    const used = Number(row.used);
    const quota: QuotaRow = {
      tenantId: row.tenant_id,
      poolId: row.pool_id,
      resource: row.resource,
      max,
      used,
      available: Math.max(0, max - used),
    };
    if (row.flavors !== null && row.flavors !== undefined) quota.flavors = [...row.flavors];
    return quota;
  });
}
