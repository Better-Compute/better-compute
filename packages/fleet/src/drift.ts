import { createHash } from 'node:crypto';
import {
  ComputeError,
  draftId,
  type Duration,
  type Migration,
  type ModuleContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { validateFleetConfig, type FleetConfig } from './config.js';
import { canonical, planFleet, type FleetChange, type FleetPlan } from './plan.js';
import { readFleetState, type NamedKind } from './state.js';

/**
 * The last document each tenant applied, and whether the fleet still matches it (GitOps drift):
 * `fleet.apply` records it in its transaction; the `fleet.drift` reconciler re-plans it periodically
 * and publishes `fleet.drifted` / `fleet.converged` when the answer changes.
 */
export const fleetAppliedMigration: Migration = {
  name: 'fleet/0002_applied',
  sql: `
CREATE TABLE fleet_applied (
  tenant_id text PRIMARY KEY,
  config jsonb NOT NULL,
  prune boolean NOT NULL,
  plan_hash text NOT NULL,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT compute_now(),
  checked_at timestamptz,
  drift_hash text,
  drift jsonb
);
`,
};

export const fleetDriftWork = 'fleet.drift';

const idPrefix: Record<NamedKind, 'site' | 'pool' | 'pacct'> = {
  site: 'site',
  pool: 'pool',
  providerAccount: 'pacct',
};

/** The hash of a call list, as `fleet.plan` returns it. */
export function planHash(calls: FleetPlan['calls']): string {
  return createHash('sha256')
    .update(canonical(calls.map(({ path, input }) => ({ path, input }))))
    .digest('hex');
}

/** Plans `config` for `tenantId` with the draft ids `identityId` would create. */
export async function planAs(
  tx: SqlTx,
  tenantId: string,
  identityId: string | undefined,
  config: FleetConfig,
  prune: boolean,
): Promise<FleetPlan & { planHash: string }> {
  const state = await readFleetState(tx, tenantId);
  const plan = await planFleet(config, state, {
    prune,
    async idFor(kind, key) {
      if (!identityId)
        throw new ComputeError('UNAUTHENTICATED', 'fleet needs an authenticated caller');
      return draftId(idPrefix[kind], tenantId, identityId, key);
    },
  });
  return { ...plan, planHash: planHash(plan.calls) };
}

/** Records what was applied (in the apply transaction); drift is re-checked from here. */
export async function recordApplied(
  tx: SqlTx,
  input: {
    tenantId: string;
    config: FleetConfig;
    prune: boolean;
    planHash: string;
    identityId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO fleet_applied (tenant_id, config, prune, plan_hash, applied_by, applied_at, checked_at,
                                drift_hash, drift)
     VALUES ($1, $2::jsonb, $3, $4, $5, compute_now(), compute_now(), NULL, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, prune = EXCLUDED.prune,
       plan_hash = EXCLUDED.plan_hash, applied_by = EXCLUDED.applied_by, applied_at = compute_now(),
       checked_at = compute_now(), drift_hash = NULL, drift = NULL`,
    [input.tenantId, JSON.stringify(input.config), input.prune, input.planHash, input.identityId],
  );
}

export interface FleetDrift {
  /** Changes that applying the recorded document again would make (unchanged ones left out). */
  changes: FleetChange[];
  summary: FleetPlan['summary'];
  blocked: boolean;
  planHash: string;
}

export interface FleetStatus {
  tenantId: string;
  /** Absent when this tenant never applied a document through fleet. */
  applied?: {
    planHash: string;
    appliedBy: string;
    appliedAt: number;
    prune: boolean;
    checkedAt?: number;
  };
  /** Set while the fleet differs from the applied document (as of `checkedAt`). */
  drift?: FleetDrift;
}

interface AppliedRow {
  tenant_id: string;
  config: unknown;
  prune: boolean;
  plan_hash: string;
  applied_by: string;
  applied_at: Date | string;
  checked_at: Date | string | null;
  drift_hash: string | null;
  drift: unknown;
}

const time = (value: Date | string) => new Date(value).getTime();
const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

export async function readFleetStatus(tx: SqlTx, tenantId: string): Promise<FleetStatus> {
  const { rows } = await tx.query<AppliedRow>('SELECT * FROM fleet_applied WHERE tenant_id = $1', [
    tenantId,
  ]);
  const row = rows[0];
  if (!row) return { tenantId };
  const status: FleetStatus = {
    tenantId,
    applied: {
      planHash: row.plan_hash,
      appliedBy: row.applied_by,
      appliedAt: time(row.applied_at),
      prune: row.prune,
      ...(row.checked_at ? { checkedAt: time(row.checked_at) } : {}),
    },
  };
  if (row.drift) status.drift = parse(row.drift) as FleetDrift;
  return status;
}

/**
 * Re-plans one tenant's applied document. Returns the drift (or undefined when converged) and
 * publishes `fleet.drifted` when a new drift appears or changes, `fleet.converged` when it clears.
 */
export async function checkDrift(
  context: Pick<ModuleContext, 'events'>,
  tx: SqlTx,
  tenantId: string,
): Promise<FleetDrift | undefined> {
  const { rows } = await tx.query<AppliedRow>(
    'SELECT * FROM fleet_applied WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  let config: FleetConfig;
  try {
    config = validateFleetConfig(parse(row.config));
  } catch {
    // A document stored by an older version that no longer validates: report, do not crash.
    config = { version: 1 };
  }
  const plan = await planAs(tx, tenantId, row.applied_by, config, row.prune);
  const drifted = plan.calls.length > 0 || plan.blocked;
  const drift: FleetDrift | undefined = drifted
    ? {
        changes: plan.changes.filter((change) => change.action !== 'unchanged' || change.blocked),
        summary: plan.summary,
        blocked: plan.blocked,
        planHash: plan.planHash,
      }
    : undefined;
  const hash = drift ? drift.planHash : null;
  if (hash !== row.drift_hash) {
    if (drift)
      await context.events.publish(tx, {
        type: 'fleet.drifted',
        tenantId,
        subject: `fleet/${tenantId}`,
        data: {
          appliedPlanHash: row.plan_hash,
          summary: drift.summary,
          blocked: drift.blocked,
          changes: drift.changes.slice(0, 50).map((change) => ({ ...change })),
        },
      });
    else if (row.drift_hash !== null)
      await context.events.publish(tx, {
        type: 'fleet.converged',
        tenantId,
        subject: `fleet/${tenantId}`,
        data: { appliedPlanHash: row.plan_hash },
      });
  }
  await tx.query(
    `UPDATE fleet_applied SET checked_at = compute_now(), drift_hash = $2, drift = $3::jsonb
      WHERE tenant_id = $1`,
    [tenantId, hash, drift ? JSON.stringify(drift) : null],
  );
  return drift;
}

/**
 * `fleet.drift`: key `all` (every 15 minutes by default) enqueues `tenant:<id>` for each tenant with
 * an applied document; a tenant key re-plans that tenant in its own transaction, so one tenant's
 * failure never blocks the others.
 */
export function fleetDriftReconciler(options: { every?: Duration } = {}): Reconciler {
  return {
    name: fleetDriftWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.every ?? '15m' }],
    async run(context, key) {
      if (key === 'all') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ tenant_id: string }>(
            'SELECT tenant_id FROM fleet_applied ORDER BY tenant_id',
          );
          for (const row of rows)
            await context.work.enqueue(tx, fleetDriftWork, `tenant:${row.tenant_id}`);
        });
        return 'DONE';
      }
      if (!key.startsWith('tenant:')) return 'DONE';
      const tenantId = key.slice('tenant:'.length);
      await context.sql.transaction((tx) => checkDrift(context, tx, tenantId));
      return 'DONE';
    },
  };
}
