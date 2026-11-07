import type { PoolPolicy, SqlTx } from '@better-compute/core';
import { meterSource, type UsageSourceKind, type UsageTags } from '@better-compute/capacity';
import type { AncillaryDeps } from './ancillary-usage.js';
import { billingModeOf, poolAccountTenantSql } from './billing.js';

// Metering of provider volumes, snapshots and reserved addresses (DO P2), with the retention contract of
// `meterSource` (as networks in ancillary-usage.ts): each row bills from `ready_at` until `deleted_at` (stamped by
// the database when it becomes `deleted`), a watermark (`metered_until`) advances in the same transaction as the
// windows it covers, and an hour already written is never derived again. One that failed or was deleted before it
// was ready never bills; one in `error` or `deleting` after it was ready still exists at the provider and bills.
//
// | Resource | Source kind | Meter                  | Per hour                                    |
// | -------- | ----------- | ---------------------- | ------------------------------------------- |
// | volume   | `volume`    | vps.volume.gib.hours   | its GiB (what the provider reports, else asked) |
// | share    | `volume`    | vps.share.gib.hours    | its GiB (a `kind: 'shared'` volume, DO P6)     |
// | snapshot | `snapshot`  | vps.snapshot.gib.hours | its GiB (what the provider reported)        |
// | address  | `address`   | vps.address.hours      | 1                                           |
//
// `usage_windows.source_kind` accepts `volume` and `address` from core/0044 on (the kubernetes module's rewrite of
// that CHECK lists them too), so every kind is metered by default. A network file share (a `kind: 'shared'` volume)
// is priced unlike a block volume, so it bills on a meter of its own; its tags are a block volume's (the D19 tag keys
// `meterSource` keeps have no kind).

/** The provider resources metered by default. */
export const defaultProviderResourceKinds: readonly ProviderResourceKind[] = Object.freeze([
  'volume',
  'snapshot',
  'address',
]);

export type ProviderResourceKind = 'volume' | 'snapshot' | 'address';

interface Metered {
  table: 'provider_volumes' | 'provider_snapshots' | 'provider_addresses';
  sourceKind: Exclude<UsageSourceKind, 'allocation' | 'cost'>;
  meter: string;
  /** SQL for one hour's quantity of row `r`. */
  quantity: string;
  tag: string;
  /** SQL for row `r`'s kind; `sharedMeter` bills a `shared` one. */
  kind?: string;
  sharedMeter?: string;
}

const metered: Record<ProviderResourceKind, Metered> = {
  volume: {
    table: 'provider_volumes',
    sourceKind: 'volume',
    meter: 'vps.volume.gib.hours',
    quantity: 'coalesce(r.observed_size_gib, r.size_gib)',
    tag: 'provider-volume',
    kind: 'r.kind',
    sharedMeter: 'vps.share.gib.hours',
  },
  snapshot: {
    table: 'provider_snapshots',
    sourceKind: 'snapshot',
    meter: 'vps.snapshot.gib.hours',
    quantity: 'coalesce(r.size_gib, 0)',
    tag: 'provider-snapshot',
  },
  address: {
    table: 'provider_addresses',
    sourceKind: 'address',
    meter: 'vps.address.hours',
    quantity: '1',
    tag: 'provider-address',
  },
};

interface Due {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  pool_class: string;
  pool_owner: string;
  policy: PoolPolicy | string;
  account_tenant: string | null;
  provider: string | null;
  region: string;
  quantity: string;
  kind: string | null;
  metered: number;
  ended: number | null;
}

const hourMs = 3_600_000;
/** As `defaultAncillaryGraceMs` (not imported: ancillary-usage.ts imports this module). */
const defaultGraceMs = 5 * 60_000;
const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

async function meterKind(
  tx: SqlTx,
  kind: Metered,
  floorNow: number,
  now: number,
  deps: AncillaryDeps,
  limit: number,
): Promise<{ rows: number; windows: number }> {
  const { rows } = await tx.query<Due>(
    `SELECT r.id, r.tenant_id, r.project_id, r.pool_id, p.class AS pool_class, p.owner_tenant_id AS pool_owner,
            p.policy, ${poolAccountTenantSql} AS account_tenant, a.provider, r.region,
            (${kind.quantity})::text AS quantity, ${kind.kind ?? 'NULL::text'} AS kind,
            (extract(epoch FROM coalesce(r.metered_until, r.ready_at)) * 1000)::float8 AS metered,
            (extract(epoch FROM r.deleted_at) * 1000)::float8 AS ended
       FROM ${kind.table} r
       JOIN pools p ON p.id = r.pool_id
       LEFT JOIN provider_accounts a ON a.id = r.provider_account_id
      WHERE r.ready_at IS NOT NULL
        AND (r.state <> 'deleted' OR r.deleted_at IS NOT NULL)
        AND coalesce(r.metered_until, r.ready_at) < to_timestamp($1::float8 / 1000)
        AND (r.deleted_at IS NULL OR coalesce(r.metered_until, r.ready_at) < r.deleted_at)
      ORDER BY coalesce(r.metered_until, r.ready_at), r.id
      LIMIT $2
        FOR UPDATE OF r`,
    [floorNow, limit],
  );
  const advance: { id: string; until: number }[] = [];
  let windows = 0;
  for (const row of rows) {
    const from = Math.round(Number(row.metered));
    const ended = row.ended === null ? null : Math.round(Number(row.ended));
    const until = Math.min(ended ?? floorNow, floorNow);
    advance.push({ id: row.id, until });
    const perHour = Number(row.quantity);
    if (!(until > from) || !(perHour > 0)) continue;
    // BYO accounts (platform-fee) and pools billed `none` advance the watermark and bill nothing.
    const mode = billingModeOf(
      { ownerTenantId: row.pool_owner, class: row.pool_class, policy: json(row.policy) ?? {} },
      row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
      deps.rootTenantId ?? '',
    );
    if (mode !== 'metered') continue;
    const tags: UsageTags = { pool: row.pool_id, source: kind.tag, region: row.region };
    if (row.provider) tags.provider = row.provider;
    if (row.project_id) tags.project = row.project_id;
    const meter = row.kind === 'shared' && kind.sharedMeter ? kind.sharedMeter : kind.meter;
    windows += await meterSource(
      tx,
      {
        sourceKind: kind.sourceKind,
        sourceId: row.id,
        tenantId: row.tenant_id,
        lines: [{ meter, perHour }],
        from,
        to: until,
        tags,
      },
      now,
    );
  }
  if (advance.length > 0)
    await tx.query(
      `UPDATE ${kind.table} r SET metered_until = to_timestamp(v.until / 1000)
         FROM unnest($1::text[], $2::float8[]) AS v(id, until)
        WHERE r.id = v.id`,
      [advance.map((a) => a.id), advance.map((a) => a.until)],
    );
  return { rows: rows.length, windows };
}

/**
 * One pass over the provider volumes, snapshots and addresses with unbilled whole hours (at most `limit` of each,
 * oldest first), for the hours that ended `meterGraceMs` ago. The bill goes to the resource's tenant. A volume bills
 * the size it has when the hour is written (a resize within an hour bills that hour at the new size).
 */
export async function meterProviderResources(
  tx: SqlTx,
  now: number,
  deps: AncillaryDeps = {},
  options: { kinds?: readonly ProviderResourceKind[]; limit?: number } = {},
): Promise<{ resources: number; windows: number }> {
  const grace = Math.max(0, deps.meterGraceMs ?? defaultGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  let resources = 0;
  let windows = 0;
  for (const kind of options.kinds ?? defaultProviderResourceKinds) {
    const pass = await meterKind(tx, metered[kind], floorNow, now, deps, options.limit ?? 5000);
    resources += pass.rows;
    windows += pass.windows;
  }
  return { resources, windows };
}
