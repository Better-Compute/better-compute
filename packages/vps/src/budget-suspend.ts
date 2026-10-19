// A suspended offer (D16, `onBudgetExceeded: 'suspend'`): capacity sets `pool_offers.suspended_at` and publishes
// `quota.budget-suspended` (`applyBudgetPolicy`); this is the half that stops the spend, because only vps owns the
// instances. It runs in the same inbox transaction, through the host's `iamReactions` (`sandboxIamReactions.budget`).

import { ComputeError, type SqlTx } from '@better-compute/core';
import { budgetSuspendedCondition, setPower, type InstanceDeps } from './instances.js';

/** What the reaction needs: a ModuleContext has it all. */
export type BudgetReactionDeps = Pick<InstanceDeps, 'clock' | 'events' | 'work' | 'desired'>;

/** The offers a budget alert suspended, as `applyBudgetPolicy` hands them over. */
export interface BudgetSuspendedOffers {
  tenantId: string;
  poolIds: string[];
  reason: string;
}

/**
 * Sets the tenant's running instances in the suspended pools to `desiredState: 'stopped'` with the
 * `BudgetSuspended` condition, through `setPower` (the reconciler then stops the machines). Level-triggered:
 * every alert re-reads the instances still wanted running, so one started between two alerts is stopped by the
 * next. Returns the instances it stopped. Sandbox-managed instances follow their sandbox only (`setPower` refuses
 * them), so they are left to it: its create and extend are refused by the suspended offer, and its TTL ends it.
 */
export async function suspendBudgetInstances(
  tx: SqlTx,
  deps: BudgetReactionDeps,
  suspended: BudgetSuspendedOffers,
): Promise<string[]> {
  if (suspended.poolIds.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM instances
      WHERE tenant_id = $1 AND pool_id = ANY($2::text[]) AND NOT draft AND desired_state = 'running'
        AND sandbox_id IS NULL AND warm_template_id IS NULL
      ORDER BY id`,
    [suspended.tenantId, suspended.poolIds],
  );
  const stopped: string[] = [];
  for (const row of rows) {
    // One instance that cannot be stopped (an attached one that lost its machine) must not keep the others
    // running: it is skipped under a savepoint, anything else fails the alert, which is retried.
    await tx.query('SAVEPOINT vps_budget_stop');
    try {
      await setPower(deps, tx, { tenantId: suspended.tenantId, instanceId: row.id }, 'stopped', {
        condition: {
          type: budgetSuspendedCondition,
          status: 'true',
          reason: 'OfferSuspended',
          message: suspended.reason,
        },
      });
      await tx.query('RELEASE SAVEPOINT vps_budget_stop');
      stopped.push(row.id);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT vps_budget_stop');
      if (!(error instanceof ComputeError) || error.code !== 'INVALID_STATE') throw error;
    }
  }
  return stopped;
}
