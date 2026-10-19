// A suspended offer (D16, `onBudgetExceeded: 'suspend'`): capacity sets `pool_offers.suspended_at` and publishes
// `quota.budget-suspended` (`applyBudgetPolicy`); this is the half that stops the spend, because only vps owns the
// instances. The source of truth is the `vps.suspension` sweep: every minute it stops the running instances of any
// (pool, tenant) whose offer is suspended, so it works in every deployment, with or without host wiring. The host's
// `budget` reaction (`sandboxIamReactions.budget`, in `iamReactions`) is an accelerator: it runs the same stop in the
// alert's transaction, so the instances stop at once instead of within the minute.

import { ComputeError, type Logger, type SqlTx } from '@better-compute/core';
import { budgetSuspendedCondition, setPower, type InstanceDeps } from './instances.js';

/** What the stop needs: a ModuleContext has it all. */
export type BudgetReactionDeps = Pick<InstanceDeps, 'clock' | 'events' | 'work' | 'desired'> & {
  log?: Pick<Logger, 'warn'>;
};

/** The offers a budget alert suspended, as `applyBudgetPolicy` hands them over. */
export interface BudgetSuspendedOffers {
  tenantId: string;
  poolIds: string[];
  reason: string;
}

/** Instances stopped per sweep pass; the rest wait for the next minute. */
export const suspensionBatch = 500;

/**
 * Sets the running instances of suspended offers to `desiredState: 'stopped'` with the `BudgetSuspended` condition,
 * through `setPower` (the reconciler then stops the machines). With `only`, just those pools of that tenant
 * (the reaction); without it, every suspended offer (the sweep). Level-triggered: every call re-reads the
 * instances still wanted running, so one started between two calls, or one whose stop failed, is stopped by the
 * next. Returns the instances it stopped. Sandbox-managed instances follow their sandbox only (`setPower` refuses
 * them), so they are left to it: its create and extend are refused by the suspended offer, and its TTL ends it.
 *
 * Each instance is stopped under its own savepoint, so one that cannot be (an attached instance that lost its
 * machine: INVALID_STATE) never keeps the others running. Any other failure fails the call when `strict` (the
 * reaction: the alert is retried) and is logged and skipped otherwise (the sweep: the next pass retries it).
 */
export async function stopSuspendedInstances(
  tx: SqlTx,
  deps: BudgetReactionDeps,
  options: { only?: BudgetSuspendedOffers; strict?: boolean } = {},
): Promise<string[]> {
  const { only } = options;
  if (only && only.poolIds.length === 0) return [];
  const { rows } = await tx.query<{ id: string; tenant_id: string }>(
    `SELECT i.id, i.tenant_id
       FROM instances i
       JOIN pool_offers o ON o.pool_id = i.pool_id AND o.tenant_id = i.tenant_id AND o.suspended_at IS NOT NULL
      WHERE NOT i.draft AND i.desired_state = 'running'
        AND i.sandbox_id IS NULL AND i.warm_template_id IS NULL
        AND ($1::text IS NULL OR (i.tenant_id = $1 AND i.pool_id = ANY($2::text[])))
      ORDER BY i.id
      LIMIT ${suspensionBatch}`,
    [only?.tenantId ?? null, only?.poolIds ?? []],
  );
  const stopped: string[] = [];
  for (const row of rows) {
    await tx.query('SAVEPOINT vps_budget_stop');
    try {
      await setPower(deps, tx, { tenantId: row.tenant_id, instanceId: row.id }, 'stopped', {
        condition: {
          type: budgetSuspendedCondition,
          status: 'true',
          reason: 'OfferSuspended',
          message: only?.reason ?? 'the offer is suspended',
        },
      });
      await tx.query('RELEASE SAVEPOINT vps_budget_stop');
      stopped.push(row.id);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT vps_budget_stop');
      if (error instanceof ComputeError && error.code === 'INVALID_STATE') continue;
      if (options.strict) throw error;
      deps.log?.warn('vps: suspended instance not stopped', {
        instanceId: row.id,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
  return stopped;
}

/** The accelerator: `applyBudgetPolicy`'s `suspend` hook stops the alert's pools now. Failures fail the alert. */
export async function suspendBudgetInstances(
  tx: SqlTx,
  deps: BudgetReactionDeps,
  suspended: BudgetSuspendedOffers,
): Promise<string[]> {
  return stopSuspendedInstances(tx, deps, { only: suspended, strict: true });
}

/** The `vps.suspension` pass: every suspended offer's running instances (see `stopSuspendedInstances`). */
export async function sweepSuspendedOffers(tx: SqlTx, deps: BudgetReactionDeps): Promise<string[]> {
  return stopSuspendedInstances(tx, deps);
}
