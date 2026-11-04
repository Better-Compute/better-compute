import type { PoolPolicy, SqlTx } from '@better-compute/core';
import { meterSource, type UsageTags } from '@better-compute/capacity';
import { billingModeOf, poolAccountTenantSql } from '@better-compute/vps';
import { json } from './store.js';

// Cluster metering: `kubernetes.cluster.hours`, one per cluster per hour while it exists at the provider, from the
// moment the provider first accepted it (`provisioned_at`) until it is deleted (`deleted_at`), billed to the
// cluster's tenant. Windows are `kubernetes` sources (`cmp:kubernetes:<clusterId>:<windowStartMs>:<meter>`) written
// with `meterSource`'s retention contract: the watermark `metered_until` advances in the same transaction as the
// windows it covers, and an hour already written is never derived again.
//
// The meter is the managed-cluster fee, so it is recorded for `metered` (platform-hosted) and `platform-fee`
// (BYO: the tenant's own cloud account) pools alike; a pool whose billing mode is `none` records nothing, though
// its watermark still advances. The nodes are not metered here: the provider bills them to the account, and a
// hosted cluster's node costs reach the tenant through the account's cost pass-through rules.

/** The meter of a managed cluster's lifetime. */
export const clusterHoursMeter = 'kubernetes.cluster.hours';

const hourMs = 3_600_000;
/** The default grace after an hour ends before it is written (as the vps metering reconcilers). */
export const defaultClusterMeterGraceMs = 5 * 60_000;

interface DueCluster {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  mode: string;
  region: string;
  pool_class: string | null;
  pool_owner: string | null;
  policy: PoolPolicy | string | null;
  account_tenant: string | null;
  provider: string | null;
  metered: number;
  ended: number | null;
}

/**
 * One pass over the clusters with unbilled whole hours, at most `limit`, oldest first. Tags: `pool`, `provider`,
 * `region` (the cluster's), `project`, and `source` `kubernetes-<mode>` (the usage tag set has no mode key).
 */
export async function meterClusters(
  tx: SqlTx,
  now: number,
  deps: { rootTenantId?: string | undefined; meterGraceMs?: number | undefined } = {},
  options: { limit?: number } = {},
): Promise<{ clusters: number; windows: number }> {
  const grace = Math.max(0, deps.meterGraceMs ?? defaultClusterMeterGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  const { rows } = await tx.query<DueCluster>(
    `SELECT k.id, k.tenant_id, k.project_id, k.pool_id, k.mode, k.region, p.class AS pool_class,
            p.owner_tenant_id AS pool_owner, p.policy, ${poolAccountTenantSql} AS account_tenant, a.provider,
            (extract(epoch FROM coalesce(k.metered_until, k.provisioned_at)) * 1000)::float8 AS metered,
            (extract(epoch FROM k.deleted_at) * 1000)::float8 AS ended
       FROM kubernetes_clusters k
       LEFT JOIN pools p ON p.id = k.pool_id
       LEFT JOIN provider_accounts a ON a.id = k.provider_account_id
      WHERE k.provisioned_at IS NOT NULL
        AND (k.deleted_at IS NULL OR k.metered_until IS DISTINCT FROM k.deleted_at)
        AND coalesce(k.metered_until, k.provisioned_at) < to_timestamp($1::float8 / 1000)
        AND (k.deleted_at IS NULL OR coalesce(k.metered_until, k.provisioned_at) < k.deleted_at)
      ORDER BY coalesce(k.metered_until, k.provisioned_at), k.id
      LIMIT $2
        FOR UPDATE OF k`,
    [floorNow, options.limit ?? 5000],
  );
  const advance: { id: string; until: number }[] = [];
  let windows = 0;
  for (const row of rows) {
    const from = Math.round(Number(row.metered));
    const ended = row.ended === null ? null : Math.round(Number(row.ended));
    const until = Math.min(ended ?? floorNow, floorNow);
    advance.push({ id: row.id, until });
    if (!(until > from)) continue;
    // A pool that is gone has no policy to say otherwise: the cluster still existed, so it bills.
    if (
      row.pool_class !== null &&
      billingModeOf(
        { ownerTenantId: row.pool_owner!, class: row.pool_class, policy: json(row.policy) ?? {} },
        row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
        deps.rootTenantId ?? '',
      ) === 'none'
    )
      continue;
    const tags: UsageTags = {
      pool: row.pool_id,
      region: row.region,
      source: `kubernetes-${row.mode}`,
    };
    if (row.provider) tags.provider = row.provider;
    if (row.project_id) tags.project = row.project_id;
    windows += await meterSource(
      tx,
      {
        sourceKind: 'kubernetes',
        sourceId: row.id,
        tenantId: row.tenant_id,
        lines: [{ meter: clusterHoursMeter, perHour: 1 }],
        from,
        to: until,
        tags,
      },
      now,
    );
  }
  if (advance.length > 0)
    await tx.query(
      `UPDATE kubernetes_clusters k SET metered_until = to_timestamp(v.until / 1000)
         FROM unnest($1::text[], $2::float8[]) AS v(id, until)
        WHERE k.id = v.id`,
      [advance.map((entry) => entry.id), advance.map((entry) => entry.until)],
    );
  return { clusters: rows.length, windows };
}
