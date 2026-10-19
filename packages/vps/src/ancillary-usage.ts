import type { Migration, PoolPolicy, SqlTx } from '@better-compute/core';
import { meterSource, type UsageTags } from '@better-compute/capacity';
import { billingModeOf, poolAccountTenantSql } from './billing.js';

// Ancillary metering (platform compute billing, D9): what a tenant holds beside its VMs. A provisioned tenant
// network bills `network.vpc.hours` from its first `ready` (`provisioned_at`) until it is deleted. These are
// `network` and `snapshot` sources of their own, metered by the `vps.ancillary-usage` reconciler
// with the retention contract of `meterSource`: a watermark (`metered_until`) advances in the same transaction as
// the windows it covers, and an hour already written is never derived again. A public address and a disk are not
// here: they are lines of the instance's own interval (`meterLinesFor`) under the instance source.

export const networkMeteringMigration: Migration = {
  name: 'vps/0032_network_metering',
  sql: `
-- When a network or snapshot stopped existing: the end of what it bills. Stamped by the database on the
-- transition, so no code path that deletes one can forget it.
CREATE FUNCTION vps_stamp_deleted_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'deleted' AND OLD.state IS DISTINCT FROM 'deleted' AND NEW.deleted_at IS NULL THEN
    NEW.deleted_at := compute_now();
  END IF;
  RETURN NEW;
END $$;

-- How far the ancillary reconciler has written windows. NULL until it first meters the network, from
-- provisioned_at; a network that is provisioned when this runs bills from the top of this hour (never back-billed).
ALTER TABLE networks ADD COLUMN metered_until timestamptz;
ALTER TABLE networks ADD COLUMN deleted_at timestamptz;
UPDATE networks SET metered_until = to_timestamp(floor(extract(epoch FROM compute_now()) / 3600) * 3600)
 WHERE provisioned_at IS NOT NULL;
CREATE TRIGGER networks_stamp_deleted BEFORE UPDATE ON networks
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();

-- Sandbox snapshots bill from ready_at (set when the upload settles) until they are deleted, the same way; the
-- ones that are ready when this runs bill from the top of this hour.
ALTER TABLE sandbox_snapshots ADD COLUMN metered_until timestamptz;
ALTER TABLE sandbox_snapshots ADD COLUMN deleted_at timestamptz;
UPDATE sandbox_snapshots SET metered_until = to_timestamp(floor(extract(epoch FROM compute_now()) / 3600) * 3600)
 WHERE state = 'ready';
CREATE TRIGGER sandbox_snapshots_stamp_deleted BEFORE UPDATE ON sandbox_snapshots
  FOR EACH ROW EXECUTE FUNCTION vps_stamp_deleted_at();
-- What the reconciler scans: snapshots that bill (or billed until a deletion it has not yet covered).
CREATE INDEX sandbox_snapshots_unmetered ON sandbox_snapshots ((coalesce(metered_until, ready_at)))
 WHERE ready_at IS NOT NULL AND (state <> 'deleted' OR (deleted_at IS NOT NULL AND metered_until IS DISTINCT FROM deleted_at));
`,
};

const hourMs = 3_600_000;

/** The default grace after an hour ends before it is written (the same 5 minutes as the instance reconciler). */
export const defaultAncillaryGraceMs = 5 * 60_000;

/** What the ancillary pass needs beyond its transaction. */
export interface AncillaryDeps {
  /** The IAM root tenant: a provider pool it owns is the platform's (metered); unknown fails closed. */
  rootTenantId?: string | undefined;
  /** An ended hour is written only this long after it ended (default 5 minutes, as `meterGraceMs`). */
  meterGraceMs?: number | undefined;
}

interface DueNetwork {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  pool_class: string;
  pool_owner: string;
  policy: PoolPolicy | string;
  account_tenant: string | null;
  provider: string | null;
  region: string | null;
  metered: number;
  ended: number | null;
}

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

/**
 * One pass over the networks with unbilled whole hours: at most `limit`, oldest first. Each writes `network` windows
 * (`cmp:network:<id>:<windowStartMs>:network.vpc.hours`, one unit per hour of the network's life) for the hours that
 * ended `meterGraceMs` ago, then advances `metered_until` to what it covered (to `deleted_at` once the network is gone).
 *
 * - Never provisioned (`provisioned_at` is null): nothing, and the row is not read.
 * - A network that is `deleting` or in `error` after it was provisioned still exists at the provider and still bills.
 * - A pool whose billing mode is `none` or `platform-fee` (BYO: the tenant pays its own cloud account) bills
 *   nothing, but the watermark still advances, so a later mode change never bills the hours before it.
 * - The bill goes to the network's tenant, not to a person.
 */
export async function meterNetworks(
  tx: SqlTx,
  now: number,
  deps: AncillaryDeps = {},
  options: { limit?: number } = {},
): Promise<{ networks: number; windows: number }> {
  const grace = Math.max(0, deps.meterGraceMs ?? defaultAncillaryGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  const { rows } = await tx.query<DueNetwork>(
    `SELECT n.id, n.tenant_id, n.project_id, n.pool_id, p.class AS pool_class, p.owner_tenant_id AS pool_owner,
            p.policy, ${poolAccountTenantSql} AS account_tenant,
            a.provider, s.region,
            (extract(epoch FROM coalesce(n.metered_until, n.provisioned_at)) * 1000)::float8 AS metered,
            (extract(epoch FROM n.deleted_at) * 1000)::float8 AS ended
       FROM networks n
       JOIN pools p ON p.id = n.pool_id
       LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN provider_accounts a ON a.id = n.provider_account_id
      WHERE n.provisioned_at IS NOT NULL
        AND (n.state <> 'deleted' OR n.deleted_at IS NOT NULL)
        AND coalesce(n.metered_until, n.provisioned_at) < to_timestamp($1::float8 / 1000)
        AND (n.deleted_at IS NULL OR coalesce(n.metered_until, n.provisioned_at) < n.deleted_at)
      ORDER BY coalesce(n.metered_until, n.provisioned_at), n.id
      LIMIT $2
        FOR UPDATE OF n`,
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
    const mode = billingModeOf(
      { ownerTenantId: row.pool_owner, class: row.pool_class, policy: json(row.policy) ?? {} },
      row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
      deps.rootTenantId ?? '',
    );
    if (mode !== 'metered') continue;
    const tags: UsageTags = { pool: row.pool_id, source: 'network' };
    if (row.provider) tags.provider = row.provider;
    if (row.region) tags.region = row.region;
    if (row.project_id) tags.project = row.project_id;
    windows += await meterSource(
      tx,
      {
        sourceKind: 'network',
        sourceId: row.id,
        tenantId: row.tenant_id,
        lines: [{ meter: 'network.vpc.hours', perHour: 1 }],
        from,
        to: until,
        tags,
      },
      now,
    );
  }
  if (advance.length > 0)
    await tx.query(
      `UPDATE networks n SET metered_until = to_timestamp(v.until / 1000)
         FROM unnest($1::text[], $2::float8[]) AS v(id, until)
        WHERE n.id = v.id`,
      [advance.map((a) => a.id), advance.map((a) => a.until)],
    );
  return { networks: rows.length, windows };
}

interface DueSnapshot {
  id: string;
  tenant_id: string;
  size_bytes: string | null;
  pool_id: string | null;
  pool_class: string | null;
  pool_owner: string | null;
  policy: PoolPolicy | string | null;
  account_tenant: string | null;
  provider: string | null;
  region: string | null;
  metered: number;
  ended: number | null;
}

const bytesPerGiB = 2 ** 30;

/**
 * One pass over the sandbox snapshots with unbilled whole hours (Task 13): at most `limit`, oldest first. A snapshot
 * bills `snapshot.gib.hours` x `size_bytes / 2^30` from the moment it was `ready` (`ready_at`) until it is deleted
 * (`deleted_at`); one that failed or was deleted before it was ready never bills. The mode is that of the pool the
 * snapshot's instance runs in (a hosted pool is metered unless its policy says otherwise); `none` and
 * `platform-fee` advance the watermark and bill nothing. The bill goes to the snapshot's tenant.
 */
export async function meterSnapshots(
  tx: SqlTx,
  now: number,
  deps: AncillaryDeps = {},
  options: { limit?: number } = {},
): Promise<{ snapshots: number; windows: number }> {
  const grace = Math.max(0, deps.meterGraceMs ?? defaultAncillaryGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  const { rows } = await tx.query<DueSnapshot>(
    `SELECT s.id, s.tenant_id, s.size_bytes::text AS size_bytes, p.id AS pool_id, p.class AS pool_class,
            p.owner_tenant_id AS pool_owner, p.policy,
            ${poolAccountTenantSql} AS account_tenant,
            a.provider, st.region,
            (extract(epoch FROM coalesce(s.metered_until, s.ready_at)) * 1000)::float8 AS metered,
            (extract(epoch FROM s.deleted_at) * 1000)::float8 AS ended
       FROM sandbox_snapshots s
       LEFT JOIN instances i ON i.id = s.instance_id
       LEFT JOIN pools p ON p.id = i.pool_id
       LEFT JOIN sites st ON st.id = p.site_id
       LEFT JOIN provider_accounts a ON a.id = i.provider_account_id
      WHERE s.ready_at IS NOT NULL
        AND (s.state <> 'deleted' OR (s.deleted_at IS NOT NULL AND s.metered_until IS DISTINCT FROM s.deleted_at))
        AND coalesce(s.metered_until, s.ready_at) < to_timestamp($1::float8 / 1000)
        AND (s.deleted_at IS NULL OR coalesce(s.metered_until, s.ready_at) < s.deleted_at)
      ORDER BY coalesce(s.metered_until, s.ready_at), s.id
      LIMIT $2
        FOR UPDATE OF s`,
    [floorNow, options.limit ?? 5000],
  );
  const advance: { id: string; until: number }[] = [];
  let windows = 0;
  for (const row of rows) {
    const from = Math.round(Number(row.metered));
    const ended = row.ended === null ? null : Math.round(Number(row.ended));
    const until = Math.min(ended ?? floorNow, floorNow);
    advance.push({ id: row.id, until });
    const gib = row.size_bytes === null ? 0 : Number(row.size_bytes) / bytesPerGiB;
    if (!(until > from) || !(gib > 0)) continue;
    // A snapshot whose instance or pool is gone has no pool to say otherwise: a hosted pool's default, metered.
    if (
      row.pool_id !== null &&
      billingModeOf(
        { ownerTenantId: row.pool_owner!, class: row.pool_class!, policy: json(row.policy) ?? {} },
        row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
        deps.rootTenantId ?? '',
      ) !== 'metered'
    )
      continue;
    const tags: UsageTags = { source: 'snapshot' };
    if (row.pool_id) tags.pool = row.pool_id;
    if (row.provider) tags.provider = row.provider;
    if (row.region) tags.region = row.region;
    windows += await meterSource(
      tx,
      {
        sourceKind: 'snapshot',
        sourceId: row.id,
        tenantId: row.tenant_id,
        lines: [{ meter: 'snapshot.gib.hours', perHour: gib }],
        from,
        to: until,
        tags,
      },
      now,
    );
  }
  if (advance.length > 0)
    await tx.query(
      `UPDATE sandbox_snapshots s SET metered_until = to_timestamp(v.until / 1000)
         FROM unnest($1::text[], $2::float8[]) AS v(id, until)
        WHERE s.id = v.id`,
      [advance.map((a) => a.id), advance.map((a) => a.until)],
    );
  return { snapshots: rows.length, windows };
}

/** The `vps.ancillary-usage` pass: networks (Task 12) and sandbox snapshots (Task 13). */
export async function meterAncillaries(
  tx: SqlTx,
  now: number,
  deps: AncillaryDeps = {},
): Promise<{ networks: number; snapshots: number; windows: number }> {
  const networks = await meterNetworks(tx, now, deps);
  const snapshots = await meterSnapshots(tx, now, deps);
  return {
    networks: networks.networks,
    snapshots: snapshots.snapshots,
    windows: networks.windows + snapshots.windows,
  };
}
