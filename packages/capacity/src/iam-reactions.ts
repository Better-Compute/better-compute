// Reservations' reactions to IAM events (PLAN.md §12.7-12.8), called from the iam bridge's inbox handlers in
// the inbox transaction (`bridge.setHandlers({ agent, identity, budget })`):
// - an agent suspended or a delegation revoked: its reservations that have not started are cancelled; started
//   ones run on (the default tenant policy);
// - an owner offboarded: their reservations move to the successor (the authz row follows, so the successor can
//   manage them), or, without one, the unstarted ones are cancelled;
// - a budget spent: each offer to the tenant applies its `onBudgetExceeded` (`notify` publishes; `stop-new`
//   also has admissions check the budget; `drain` also cancels the tenant's unstarted reservations there).
// Handlers are level-triggered (§12.8): every reaction re-reads current rows, so a replayed event does nothing new.

import type { Json, ModuleContext, SqlTx } from '@better-compute/core';
import {
  cancelPendingReservation,
  readReservationsBy,
  reservationAuthzRow,
  type ReservationRow,
} from './reservations.js';

/** What the reactions need: a ModuleContext has it all. */
export type IamReactionDeps = Pick<ModuleContext, 'events' | 'work' | 'desired' | 'authz'>;

/** Reservations that have not started: cancelling them releases no running workload. */
const unstarted = ['pending', 'placed', 'awaiting-confirmation'] as const;
/** Reservations not yet terminal: an owner change carries all of them. */
const live = [
  'pending',
  'placed',
  'binding',
  'active',
  'releasing',
  'awaiting-confirmation',
] as const;

export interface ReactionResult {
  /** Reservations cancelled. */
  cancelled: string[];
  /** Reservations whose owner changed. */
  reassigned: string[];
}

const cancelAll = async (
  deps: IamReactionDeps,
  tx: SqlTx,
  rows: readonly ReservationRow[],
  reason: string,
): Promise<string[]> => {
  const cancelled: string[] = [];
  for (const row of rows) {
    const after = await cancelPendingReservation(deps, tx, row, reason);
    if (after.state === 'cancelled' && row.state !== 'cancelled') cancelled.push(row.id);
  }
  return cancelled;
};

/**
 * An agent suspended (`agentId`), every agent of the tenant suspended (`allAgents`), or a delegation revoked
 * (`delegationId`, with its `agentId` when known): cancels the reservations they created that have not started.
 * Takes the shape of `@better-compute/iam`'s `AgentStreamFilter`. A filter naming nothing does nothing.
 */
export async function withdrawAgentReservations(
  tx: SqlTx,
  deps: IamReactionDeps,
  filter: {
    tenantId: string;
    agentId?: string;
    delegationId?: string;
    allAgents?: boolean;
    reason: string;
  },
): Promise<ReactionResult> {
  const by = filter.delegationId
    ? { delegationId: filter.delegationId }
    : filter.agentId
      ? { agentId: filter.agentId }
      : filter.allAgents
        ? { anyAgent: true }
        : undefined;
  if (!by) return { cancelled: [], reassigned: [] };
  const rows = await readReservationsBy(tx, filter.tenantId, unstarted, by);
  return { cancelled: await cancelAll(deps, tx, rows, filter.reason), reassigned: [] };
}

/**
 * An owner offboarded, expired or deleted: with a `successorId`, their live reservations move to the successor
 * (and `reservation.reassigned` is published); without one, those that have not started are cancelled and
 * started ones run to their end (their late usage is billed to the successor or the tenant, §12.7).
 */
export async function reassignReservations(
  tx: SqlTx,
  deps: IamReactionDeps,
  input: { tenantId: string; identityId: string; successorId?: string; reason: string },
): Promise<ReactionResult> {
  if (!input.identityId) return { cancelled: [], reassigned: [] };
  if (!input.successorId || input.successorId === input.identityId) {
    const rows = await readReservationsBy(tx, input.tenantId, unstarted, {
      ownerIdentityId: input.identityId,
    });
    return { cancelled: await cancelAll(deps, tx, rows, input.reason), reassigned: [] };
  }
  const rows = await readReservationsBy(tx, input.tenantId, live, {
    ownerIdentityId: input.identityId,
  });
  const reassigned: string[] = [];
  for (const row of rows) {
    await tx.query(
      `UPDATE reservations SET owner_identity_id = $2, version = version + 1 WHERE id = $1`,
      [row.id, input.successorId],
    );
    const moved: ReservationRow = {
      ...row,
      ownerIdentityId: input.successorId,
      version: row.version + 1,
    };
    await deps.authz.upsert(tx, await reservationAuthzRow(tx, moved));
    await deps.events.publish(tx, {
      type: 'reservation.reassigned',
      tenantId: row.tenantId,
      subject: `reservation/${row.id}`,
      data: {
        reservationId: row.id,
        from: input.identityId,
        to: input.successorId,
        reason: input.reason,
      },
    });
    reassigned.push(row.id);
  }
  return { cancelled: [], reassigned };
}

/** A budget alert as `@better-compute/iam`'s `budgetAlertOf` reads it (structural). */
export interface BudgetAlertLike {
  tenantId: string;
  budgetId: string;
  name?: string;
  exceeded: boolean;
  spentMicros?: number;
  amountMicros?: number;
}

/**
 * A tenant's budget is spent: every pool offered to it with an `onBudgetExceeded` publishes
 * `quota.budget-exceeded` (subject the pool); `drain` also cancels the tenant's reservations there that have
 * not started. `stop-new` and `drain` refuse new admissions through the admission's budget check (a pool offer
 * with either policy checks the caller's budget on create and extend), which clears itself when the budget's
 * window resets. Offers inherited through `include_descendants` are not covered: compute does not know the tenant
 * tree; offer the budgeted tenant directly for the policy to apply.
 */
export async function applyBudgetPolicy(
  tx: SqlTx,
  deps: IamReactionDeps,
  alert: BudgetAlertLike,
): Promise<ReactionResult & { pools: { poolId: string; policy: string }[] }> {
  if (!alert.exceeded) return { cancelled: [], reassigned: [], pools: [] };
  const { rows: offers } = await tx.query<{ pool_id: string; on_budget_exceeded: string }>(
    `SELECT pool_id, on_budget_exceeded FROM pool_offers
      WHERE tenant_id = $1 AND on_budget_exceeded IS NOT NULL ORDER BY pool_id`,
    [alert.tenantId],
  );
  const reason = `budget ${alert.name ?? alert.budgetId} exceeded`;
  const drained = offers.filter((offer) => offer.on_budget_exceeded === 'drain');
  let cancelled: string[] = [];
  if (drained.length > 0) {
    const pools = new Set(drained.map((offer) => offer.pool_id));
    const rows = (await readReservationsBy(tx, alert.tenantId, unstarted, {})).filter((row) =>
      pools.has(row.poolId),
    );
    cancelled = await cancelAll(deps, tx, rows, reason);
  }
  for (const offer of offers) {
    const data: Record<string, Json> = {
      poolId: offer.pool_id,
      budgetId: alert.budgetId,
      policy: offer.on_budget_exceeded,
    };
    if (alert.spentMicros !== undefined) data.spentMicros = alert.spentMicros;
    if (alert.amountMicros !== undefined) data.amountMicros = alert.amountMicros;
    await deps.events.publish(tx, {
      type: 'quota.budget-exceeded',
      tenantId: alert.tenantId,
      subject: `pool/${offer.pool_id}`,
      data,
    });
  }
  return {
    cancelled,
    reassigned: [],
    pools: offers.map((offer) => ({ poolId: offer.pool_id, policy: offer.on_budget_exceeded })),
  };
}
