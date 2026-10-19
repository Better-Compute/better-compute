import {
  canonicalGpuModel,
  defaultMeterGpuModels,
  knownGpuFamilies,
  newId,
  type ExternalMachine,
  type Migration,
  type PoolPolicy,
  type SqlTx,
} from '@better-compute/core';
import { billingModeOf, type BillableShape, type BillingMode } from './billing.js';
import type { InstanceRow } from './instances.js';

// Lifecycle usage intervals (platform compute billing, D3): a provider instance's exact running and
// stopped spans, written in the same transactions as the lifecycle changes that start and end them.
// The `vps.provider-usage` reconciler (Task 7) turns them into hourly usage windows and advances
// `metered_until`. Only provider-pool instances have intervals; hosted instances keep allocation
// metering. The database referees: an exclusion constraint refuses two overlapping intervals of one
// instance, so a restarted or racing reconciler can never bill the same span twice.

export const instanceUsageMigration: Migration = {
  name: 'vps/0030_instance_usage',
  sql: `
CREATE TABLE instance_usage_intervals (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES instances,
  tenant_id text NOT NULL, project_id text, identity_id text,
  pool_id text NOT NULL, region text, provider text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('running', 'stopped')),
  mode text NOT NULL CHECK (mode IN ('metered', 'platform-fee', 'none')),
  -- BillableShape, captured when the interval opened.
  shape jsonb NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz,
  -- How far the usage reconciler has written windows (= started_at initially).
  metered_until timestamptz NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  EXCLUDE USING gist (instance_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity')) WITH &&)
);
CREATE INDEX instance_usage_open ON instance_usage_intervals (metered_until) WHERE ended_at IS NULL OR metered_until < ended_at;
-- D6: an attached instance's billing; NULL = the pool's default.
ALTER TABLE instances ADD COLUMN billing text CHECK (billing IN ('metered', 'none'));
`,
};

export type IntervalPhase = 'running' | 'stopped';

/** What the provider reported about the machine when the interval opens (its GPU model and region). */
export type ObservedMachine = Pick<ExternalMachine, 'gpus' | 'region'>;

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

/** Milliseconds to `timestamptz`, as the rest of vps writes them. */
const at$ = (index: number) => `to_timestamp($${index}::float8 / 1000)`;

/**
 * Closes the instance's open interval at `at` (never before it started). A no-op when none is open.
 * Called inside the lifecycle transaction that loses, fails, deletes or detaches the instance.
 */
export async function closeOpenInterval(tx: SqlTx, instanceId: string, at: number): Promise<void> {
  await tx.query(
    `UPDATE instance_usage_intervals SET ended_at = GREATEST(started_at, ${at$(2)})
      WHERE instance_id = $1 AND ended_at IS NULL`,
    [instanceId, at],
  );
}

/** What opening an interval needs beyond its transaction. */
export interface IntervalDeps {
  /** The IAM root tenant: a provider pool it owns is the platform's (metered); unknown fails closed. */
  rootTenantId?: string | undefined;
  /** The GPU models the deployment's meter catalog names (`vps({ billing: { gpuModels } })`), beside the known families. */
  meterGpuModels?: readonly string[] | undefined;
}

/**
 * The interval's GPU model (ruling F6-4), always as `canonicalGpuModel` names it, from the most stable source: the
 * instance's latest interval (unless it could only say `other`), then what the provider reported now, then the
 * pool's `gpu_model`. A provider read that omits the GPUs therefore never flaps an interval between a model and
 * `other`; one that names a model upgrades an `other` once.
 */
function gpuModelOf(
  stored: string | null,
  observed: ObservedMachine | undefined,
  poolModel: string | null,
  deps: IntervalDeps,
): string {
  const families = [...knownGpuFamilies, ...defaultMeterGpuModels, ...(deps.meterGpuModels ?? [])];
  for (const raw of [stored, observed?.gpus?.model, poolModel]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const model = canonicalGpuModel(raw, families);
    if (model !== 'other') return model;
  }
  return 'other';
}

interface Billing {
  tenantId: string;
  projectId: string | null;
  identityId: string;
  poolId: string;
  region: string | null;
  provider: string;
  mode: BillingMode;
  shape: BillableShape;
}

/**
 * What the instance is billed as right now, from its row, pool and account in this transaction;
 * `undefined` when it is not billed through intervals (not a provider pool, or attached with
 * `billing: 'none'`).
 */
async function billingOf(
  tx: SqlTx,
  instanceId: string,
  deps: IntervalDeps,
  observed: ObservedMachine | undefined,
): Promise<Billing | undefined> {
  const { rows } = await tx.query<{
    tenant_id: string;
    project_id: string | null;
    owner_identity_id: string;
    pool_id: string;
    flavor: Record<string, unknown> | string;
    origin: string;
    billing: string | null;
    reserved: boolean;
    pool_class: string;
    pool_owner: string;
    policy: PoolPolicy | string;
    site_region: string | null;
    provider: string | null;
    account_tenant: string | null;
    last_model: string | null;
    pool_gpu_model: string | null;
    machine_region: string | null;
    flavor_meter: string | null;
  }>(
    // The account resolves only when it is the pool owner's (ruling R1, as readPoolAccount); its
    // provider names the interval either way. The flavor row is read whole (to_jsonb), so its
    // `billing.meter` (Task 8) is picked up without naming a column that may not exist yet.
    `SELECT i.tenant_id, i.project_id, i.owner_identity_id, i.pool_id, i.flavor, i.origin, i.billing,
            i.provider_reservation IS NOT NULL AS reserved,
            p.class AS pool_class, p.owner_tenant_id AS pool_owner, p.policy, s.region AS site_region,
            a.provider, CASE WHEN a.tenant_id = p.owner_tenant_id THEN a.tenant_id END AS account_tenant,
            m.machine->>'region' AS machine_region, p.gpu_model AS pool_gpu_model,
            (SELECT u.shape->'gpus'->>'model' FROM instance_usage_intervals u
              WHERE u.instance_id = i.id ORDER BY u.started_at DESC LIMIT 1) AS last_model,
            to_jsonb(f)->'billing'->>'meter' AS flavor_meter
       FROM instances i
       JOIN pools p ON p.id = i.pool_id
       LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN provider_accounts a ON a.id = i.provider_account_id
       LEFT JOIN provider_machines m ON m.account_id = i.provider_account_id AND m.external_id = i.external_id
       LEFT JOIN flavors f ON f.id = i.flavor_id
      WHERE i.id = $1`,
    [instanceId],
  );
  const row = rows[0];
  if (!row || row.pool_class !== 'provider') return undefined;
  if (row.origin === 'attached' && row.billing === 'none') return undefined;
  const flavor = json(row.flavor) ?? {};
  const count = Number(flavor.gpus ?? 0);
  const model =
    count > 0 ? gpuModelOf(row.last_model, observed, row.pool_gpu_model, deps) : 'other';
  const billingMeter = (flavor.billing as { meter?: unknown } | undefined)?.meter;
  const flavorMeter =
    typeof billingMeter === 'string' ? billingMeter : (row.flavor_meter ?? undefined);
  const shape: BillableShape = {
    vcpu: Number(flavor.vcpu ?? 0),
    memoryGiB: Number(flavor.memoryGiB ?? 0),
    ...(count > 0 ? { gpus: { model, count } } : {}),
    // No offer reports spot yet: a flavor (or a later offer field) that says so is read here.
    spot: flavor.spot === true,
    reserved: row.reserved,
    // Task 10: reservation grants.
    granted: false,
    ...(flavorMeter !== undefined ? { flavorMeter } : {}),
  };
  // Without a known root tenant every provider pool reads as a tenant's own (BYO): fail closed (B8),
  // never charging compute for a pool not known to be the platform's.
  const mode = billingModeOf(
    { ownerTenantId: row.pool_owner, class: row.pool_class, policy: json(row.policy) ?? {} },
    row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
    deps.rootTenantId ?? '',
  );
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    identityId: row.owner_identity_id,
    poolId: row.pool_id,
    region: observed?.region ?? row.machine_region ?? row.site_region,
    provider: row.provider ?? 'unknown',
    mode,
    shape,
  };
}

/**
 * Opens a `phase` interval for a provider instance at `at`, inside the lifecycle transaction that
 * observed it (the provider reported the machine running or stopped). Idempotent: an open interval
 * of the same phase, mode and shape is kept, so steady polls and restarted reconcilers add nothing;
 * any other open interval (the other phase, a resize, a grant or mode change) is closed at `at`
 * first. A new interval never starts before the instance's last one ended, nor before an attached
 * instance's `attached_at`. Instances that are not billed through intervals get none (and any open
 * one closes).
 */
export async function openInterval(
  tx: SqlTx,
  row: InstanceRow,
  phase: IntervalPhase,
  at: number,
  deps: IntervalDeps,
  observed?: ObservedMachine,
): Promise<void> {
  if (row.poolClass !== 'provider') return;
  const billing = await billingOf(tx, row.id, deps, observed);
  if (!billing) {
    await closeOpenInterval(tx, row.id, at);
    return;
  }
  const shape = JSON.stringify(billing.shape);
  const { rows: open } = await tx.query<{ same: boolean }>(
    `SELECT (phase = $2 AND mode = $3 AND shape = $4::jsonb) AS same FROM instance_usage_intervals
      WHERE instance_id = $1 AND ended_at IS NULL`,
    [row.id, phase, billing.mode, shape],
  );
  if (open[0]?.same) return;
  if (open.length > 0) await closeOpenInterval(tx, row.id, at);
  await tx.query(
    `WITH start AS (
       SELECT GREATEST(${at$(12)},
                       (SELECT max(ended_at) FROM instance_usage_intervals WHERE instance_id = $2),
                       (SELECT attached_at FROM instances WHERE id = $2 AND origin = 'attached')) AS t
     )
     INSERT INTO instance_usage_intervals (id, instance_id, tenant_id, project_id, identity_id, pool_id,
                                           region, provider, phase, mode, shape, started_at, metered_until)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, t, t FROM start`,
    [
      newId('ivl'),
      row.id,
      billing.tenantId,
      billing.projectId,
      billing.identityId,
      billing.poolId,
      billing.region,
      billing.provider,
      phase,
      billing.mode,
      shape,
      at,
    ],
  );
}
