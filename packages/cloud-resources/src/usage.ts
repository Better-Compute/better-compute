import type { PoolPolicy, SqlTx } from '@better-compute/core';
import { meterSource, type MeterLine, type UsageTags } from '@better-compute/capacity';
import { billingModeOf, poolAccountTenantSql } from '@better-compute/vps';
import { cloudResourceSourceKind } from './migrations.js';
import { json } from './store.js';

// Cloud resource metering, by the `cloud.resources.usage` reconciler. Windows are `cloud-resource` sources
// (`cmp:cloud-resource:<resourceId>:<windowStartMs>:<meter>`), billed to the resource's tenant, written with
// `meterSource`'s retention contract: the watermark `metered_until` advances in the same transaction as the windows
// it covers, and an hour already written is never derived again.
//
// - `cloud.resource.hours`: one per resource per hour while it exists at the provider, from the provider's first
//   acceptance (`provisioned_at`; an adopted resource from its first `ready`) until it is deleted or released
//   (`deleted_at`). It is better-compute's managed-resource fee, so it is recorded for `metered` (platform-hosted)
//   and `platform-fee` (BYO) pools alike; a pool whose billing mode is `none` records nothing, though its watermark
//   still advances. What the provider itself charges reaches a hosted tenant through the account's cost
//   pass-through rules, as for a managed Kubernetes cluster's nodes. A resource living in another (a database
//   user, a pool, a firewall, a replica: `parent_id` set) bills no fee of its own: it is part of the managed resource,
//   and the provider charges nothing for most; a replica's nodes bill through its kind meter.
// - The kind's own meters (`ProviderResourceKind.meters`): the rate the provider last reported for each
//   (`ProviderResourceState.usage`, kept in `meter_rates`) bills the hours being written. They are written only for
//   the meters the operator names in `cloudResources({ kindMeters })`: better-iam prices only meters it defines
//   (at most 100 per tenant), so each provider's per-kind meters are opt-in. A rate change applies from the next
//   unwritten hour (the pass runs every 5 minutes; an hour is written once it ended and its grace passed).

/** The managed-resource fee: one per resource per hour. */
export const resourceHoursMeter = 'cloud.resource.hours';

const hourMs = 3_600_000;
/** The default grace after an hour ends before it is written (as the vps and kubernetes metering passes). */
export const defaultResourceMeterGraceMs = 5 * 60_000;

interface DueResource {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider: string;
  kind: string;
  region: string | null;
  parent_id: string | null;
  meter_rates: Record<string, unknown> | string;
  pool_class: string | null;
  pool_owner: string | null;
  policy: PoolPolicy | string | null;
  account_tenant: string | null;
  metered: number;
  ended: number | null;
}

/** The rates a provider reported that may bill: declared by the kind, finite and not negative. */
export function meterRates(
  declared: readonly { meter: string }[] | undefined,
  usage: Readonly<Record<string, unknown>> | undefined,
): Record<string, number> {
  const names = new Set((declared ?? []).map((entry) => entry.meter));
  const rates: Record<string, number> = {};
  for (const [meter, rate] of Object.entries(usage ?? {}))
    if (names.has(meter) && typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)
      rates[meter] = rate;
  return rates;
}

export interface MeterResourcesDeps {
  rootTenantId?: string | undefined;
  meterGraceMs?: number | undefined;
  /** The kind meters the operator has defined in billing (`cloudResources({ kindMeters })`). */
  kindMeters?: ReadonlySet<string>;
}

/**
 * One pass over the resources with unbilled whole hours, at most `limit`, oldest first. Tags: `pool`, `provider`,
 * `region` (when the kind is regional), `project`, and `source` (the kind, e.g. `do.database.pg`).
 */
export async function meterResources(
  tx: SqlTx,
  now: number,
  deps: MeterResourcesDeps = {},
  options: { limit?: number } = {},
): Promise<{ resources: number; windows: number }> {
  const grace = Math.max(0, deps.meterGraceMs ?? defaultResourceMeterGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  const start = 'coalesce(r.metered_until, r.provisioned_at, r.ready_at)';
  const { rows } = await tx.query<DueResource>(
    `SELECT r.id, r.tenant_id, r.project_id, r.pool_id, r.provider, r.kind, r.region, r.parent_id, r.meter_rates,
            p.class AS pool_class, p.owner_tenant_id AS pool_owner, p.policy,
            ${poolAccountTenantSql} AS account_tenant,
            (extract(epoch FROM ${start}) * 1000)::float8 AS metered,
            (extract(epoch FROM r.deleted_at) * 1000)::float8 AS ended
       FROM cloud_resources r
       LEFT JOIN pools p ON p.id = r.pool_id
       LEFT JOIN provider_accounts a ON a.id = r.provider_account_id
      WHERE coalesce(r.provisioned_at, r.ready_at) IS NOT NULL
        AND (r.deleted_at IS NULL OR r.metered_until IS DISTINCT FROM r.deleted_at)
        AND ${start} < to_timestamp($1::float8 / 1000)
        AND (r.deleted_at IS NULL OR ${start} < r.deleted_at)
      ORDER BY ${start}, r.id
      LIMIT $2
        FOR UPDATE OF r`,
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
    // A pool that is gone has no policy to say otherwise: the resource still existed, so it bills.
    if (
      row.pool_class !== null &&
      billingModeOf(
        { ownerTenantId: row.pool_owner!, class: row.pool_class, policy: json(row.policy) ?? {} },
        row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
        deps.rootTenantId ?? '',
      ) === 'none'
    )
      continue;
    // The fee is the managed resource's: what lives in it bills only its kind meters.
    const lines: MeterLine[] =
      row.parent_id === null ? [{ meter: resourceHoursMeter, perHour: 1 }] : [];
    for (const [meter, rate] of Object.entries(json(row.meter_rates) ?? {}))
      if (
        deps.kindMeters?.has(meter) &&
        meter !== resourceHoursMeter &&
        typeof rate === 'number' &&
        Number.isFinite(rate) &&
        rate > 0
      )
        lines.push({ meter, perHour: rate });
    if (lines.length === 0) continue;
    const tags: UsageTags = { pool: row.pool_id, provider: row.provider, source: row.kind };
    if (row.region) tags.region = row.region;
    if (row.project_id) tags.project = row.project_id;
    windows += await meterSource(
      tx,
      {
        sourceKind: cloudResourceSourceKind,
        sourceId: row.id,
        tenantId: row.tenant_id,
        lines,
        from,
        to: until,
        tags,
      },
      now,
    );
  }
  if (advance.length > 0)
    await tx.query(
      `UPDATE cloud_resources r SET metered_until = CASE
             -- The end itself, not its millisecond rounding: a deleted resource is then never scanned again.
             WHEN r.deleted_at IS NOT NULL AND to_timestamp(v.until / 1000) >= r.deleted_at - interval '1 millisecond'
               THEN r.deleted_at
             ELSE to_timestamp(v.until / 1000) END
         FROM unnest($1::text[], $2::float8[]) AS v(id, until)
        WHERE r.id = v.id`,
      [advance.map((entry) => entry.id), advance.map((entry) => entry.until)],
    );
  return { resources: rows.length, windows };
}

/** Whether `usage_windows` still accepts `cloud-resource` windows (a later migration may have replaced its CHECK). */
export async function usageSourceAccepted(sql: Pick<SqlTx, 'query'>): Promise<boolean> {
  const { rows } = await sql.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conname = 'usage_windows_source_kind_ck' AND c.conrelid = 'usage_windows'::regclass`,
  );
  // As PostgreSQL renders the values: ARRAY['a'::text, …] or '{a,b}'::text[].
  const value = new RegExp(`['{,]${cloudResourceSourceKind}['},]`);
  return rows.length === 0 || rows.some((row) => value.test(row.def));
}
