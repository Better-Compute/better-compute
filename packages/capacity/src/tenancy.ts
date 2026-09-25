import type { ModuleContext, ReservationState } from '@better-compute/core';
import { readQuotas, setQuota } from './quota.js';
import {
  cancelPendingReservation,
  endReservation,
  readReservationsBy,
  type ReservationDeps,
} from './reservations.js';

// Capacity's part of a tenant teardown (PLAN.md §12.8: the IAM tenant was deleted; the built-in
// `tenancy` reconciler calls `ComputeModule.tenantDeleted` until every module answers DONE):
// 1. its reservations: unstarted ones cancelled, started ones released now (bookings and quota
//    back, node specs invalidated), a batch per call;
// 2. offers to it: withdrawn, its quotas there zeroed, its authz view of the pool removed;
// 3. pools it owns: archived (offers withdrawn from everyone); other tenants' live bookings there
//    run to their end, as `pools.archive` leaves them;
// 4. its quota rows with nothing in use: deleted.
// Idempotent: a second call finds nothing left and answers DONE.

/** Reservations handled per call (per transaction). */
export const tenantTeardownBatch = 100;

const live: readonly ReservationState[] = [
  'awaiting-confirmation',
  'pending',
  'placed',
  'binding',
  'active',
  'releasing',
];

export type TenantTeardownContext = Pick<
  ModuleContext,
  'sql' | 'clock' | 'events' | 'work' | 'authz' | 'desired'
>;

/** Capacity's `tenantDeleted`: `SYNC_AGAIN` while reservations remain beyond this call's batch. */
export async function capacityTenantDeleted(
  context: TenantTeardownContext,
  tenantId: string,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  const deps = {
    clock: context.clock,
    events: context.events,
    work: context.work,
    authz: context.authz,
    desired: context.desired,
  } as ReservationDeps;

  // 1. Reservations.
  const more = await context.sql.transaction(async (tx) => {
    const rows = await readReservationsBy(tx, tenantId, live, {});
    for (const row of rows.slice(0, tenantTeardownBatch)) {
      if (
        row.state === 'pending' ||
        row.state === 'placed' ||
        row.state === 'awaiting-confirmation'
      )
        await cancelPendingReservation(deps, tx, row, 'tenant deleted');
      else await endReservation(deps, tx, row, 'release');
    }
    return rows.length > tenantTeardownBatch;
  });
  if (more) return 'SYNC_AGAIN';

  await context.sql.transaction(async (tx) => {
    // 2. Offers to it.
    const offered = await tx.query<{ pool_id: string; owner_tenant_id: string }>(
      `DELETE FROM pool_offers o USING pools p
        WHERE o.tenant_id = $1 AND p.id = o.pool_id AND p.owner_tenant_id <> $1
        RETURNING o.pool_id, p.owner_tenant_id`,
      [tenantId],
    );
    for (const offer of offered.rows) {
      for (const quota of await readQuotas(tx, tenantId, offer.pool_id))
        await setQuota(tx, tenantId, offer.pool_id, quota.resource, 0);
      await context.authz.remove(tx, { type: 'pool', id: offer.pool_id, tenantId });
      await context.events.publish(tx, {
        type: 'pool.unoffered',
        tenantId: offer.owner_tenant_id,
        subject: `pool/${offer.pool_id}`,
        data: { toTenantId: tenantId, reason: 'tenant deleted' },
      });
    }

    // 3. Pools it owns.
    const { rows: owned } = await tx.query<{ id: string }>(
      `SELECT id FROM pools WHERE owner_tenant_id = $1 AND archived_at IS NULL ORDER BY id FOR UPDATE`,
      [tenantId],
    );
    for (const pool of owned) {
      const viewers = await tx.query<{ tenant_id: string }>(
        `DELETE FROM pool_offers WHERE pool_id = $1 RETURNING tenant_id`,
        [pool.id],
      );
      for (const { tenant_id: viewer } of viewers.rows) {
        if (viewer !== tenantId)
          for (const quota of await readQuotas(tx, viewer, pool.id))
            await setQuota(tx, viewer, pool.id, quota.resource, 0);
        await context.authz.remove(tx, { type: 'pool', id: pool.id, tenantId: viewer });
      }
      await context.authz.remove(tx, { type: 'pool', id: pool.id, tenantId });
      await tx.query(
        `UPDATE pools SET archived_at = compute_now(), version = version + 1 WHERE id = $1`,
        [pool.id],
      );
      await context.events.publish(tx, {
        type: 'pool.archived',
        tenantId,
        subject: `pool/${pool.id}`,
        data: { unoffered: viewers.rows.map((row) => row.tenant_id), reason: 'tenant deleted' },
      });
    }

    // 4. Its quota rows with nothing in use.
    await tx.query(`DELETE FROM quota_usage WHERE tenant_id = $1 AND used = 0`, [tenantId]);
  });
  return 'DONE';
}
