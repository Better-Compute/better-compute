import type { ModuleContext } from '@better-compute/core';
import {
  publishInstance,
  readInstance,
  updateInstance,
  wake,
  type InstanceDeps,
} from './instances.js';
import {
  dropSnapshots,
  purgeSnapshots,
  type DroppedSnapshot,
  type SnapshotStore,
} from './snapshots.js';

// VPS's part of a tenant teardown (PLAN.md §12.8: the IAM tenant was deleted; the built-in `tenancy`
// reconciler calls `ComputeModule.tenantDeleted` until every module answers DONE). Hosted instances
// hold inline allocations, not reservations, so capacity's teardown never reaches them:
// 1. sandbox templates are deleted (their warm pools drain), open sandboxes marked deleting, and
//    every snapshot deleted (kept ones too; stored objects after the transaction);
// 2. admission drafts are dropped;
// 3. every live instance (sandboxes' and warm ones included) gets `desiredState: 'deleted'` and goes
//    through the ordinary lifecycle: runtime teardown, allocation released, IP freed, quota refunded.
// `SYNC_AGAIN` until every instance of the tenant is `deleted`. Idempotent.

/** Instances asked to go per call (per transaction). */
export const vpsTeardownBatch = 100;

export async function vpsTenantDeleted(
  deps: InstanceDeps,
  context: Pick<ModuleContext, 'sql'>,
  tenantId: string,
  store?: SnapshotStore,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  const at = new Date(deps.clock.now()).toISOString();
  let dropped: DroppedSnapshot[] = [];
  const outcome = await context.sql.transaction(async (tx) => {
    // Its snapshots, kept ones included (tenant data with memory state).
    dropped = await dropSnapshots(tx, { tenantId }, deps.authz);
    const templates = await tx.query<{ id: string }>(
      `UPDATE sandbox_templates SET deleted = true, version = version + 1
        WHERE tenant_id = $1 AND NOT deleted RETURNING id`,
      [tenantId],
    );
    for (const { id } of templates.rows)
      await deps.authz.remove(tx, { type: 'sandbox-template', id, tenantId });
    await tx.query(
      `UPDATE sandboxes SET deleting_at = $2::timestamptz, version = version + 1
        WHERE tenant_id = $1 AND NOT draft AND deleting_at IS NULL`,
      [tenantId, at],
    );
    const sandboxDrafts = await tx.query<{ id: string }>(
      `DELETE FROM sandboxes WHERE tenant_id = $1 AND draft RETURNING id`,
      [tenantId],
    );
    for (const { id } of sandboxDrafts.rows)
      await deps.authz.remove(tx, { type: 'sandbox', id, tenantId });
    const drafts = await tx.query<{ id: string }>(
      `DELETE FROM instances WHERE tenant_id = $1 AND draft RETURNING id`,
      [tenantId],
    );
    for (const { id } of drafts.rows)
      await deps.authz.remove(tx, { type: 'instance', id, tenantId });

    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM instances
        WHERE tenant_id = $1 AND NOT draft AND desired_state <> 'deleted' AND state <> 'deleted'
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [tenantId, vpsTeardownBatch],
    );
    for (const { id } of rows) {
      const row = (await readInstance(tx, id, { lock: true }))!;
      const next = await updateInstance(tx, row, { desiredState: 'deleted' });
      await wake(deps, tx, next);
      await publishInstance(deps, tx, next, 'instance.deleting', { reason: 'tenant deleted' });
    }
    const left = await tx.query(
      `SELECT 1 FROM instances WHERE tenant_id = $1 AND NOT draft AND state <> 'deleted' LIMIT 1`,
      [tenantId],
    );
    return left.rows.length > 0 ? ('SYNC_AGAIN' as const) : ('DONE' as const);
  });
  await purgeSnapshots(store, deps.log, dropped);
  return outcome;
}
