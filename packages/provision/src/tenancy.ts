import type { AuthzWriter, SqlTx } from '@better-compute/core';
import { abortWorkflow, type EngineContext } from './engine.js';

// A deleted tenant's provisioning state (the server's tenancy teardown, PLAN.md §12.5): its active
// workflows are aborted (their cleanup still runs), its private images and its profiles are soft
// deleted with their authz rows, and its image signers are revoked. Images it promoted to public stay:
// other tenants may deploy them, and they remain verified by the platform's allowlist only if the
// platform signed them. Idempotent: a second run finds nothing left to do.

export interface ProvisionTenantTeardown {
  workflowsAborted: number;
  imagesDeleted: number;
  profilesDeleted: number;
  signersRevoked: number;
}

export async function teardownTenantProvisioning(
  tx: SqlTx,
  context: EngineContext & { authz?: AuthzWriter },
  tenantId: string,
): Promise<ProvisionTenantTeardown> {
  const { rows: active } = await tx.query<{ id: string }>(
    `SELECT id FROM workflows WHERE tenant_id = $1 AND state IN ('pending', 'running', 'paused') AND outcome IS NULL ORDER BY id`,
    [tenantId],
  );
  for (const workflow of active) await abortWorkflow(context, tx, workflow.id, { tenantId, reason: 'tenant deleted' });
  const { rows: images } = await tx.query<{ id: string }>(
    `UPDATE images SET deleted_at = compute_now(), version = version + 1
      WHERE tenant_id = $1 AND visibility = 'private' AND deleted_at IS NULL RETURNING id`,
    [tenantId],
  );
  for (const image of images) await context.authz?.remove(tx, { type: 'image', id: image.id, tenantId });
  const { rows: profiles } = await tx.query<{ id: string }>(
    `UPDATE profiles SET deleted_at = compute_now(), version = version + 1
      WHERE tenant_id = $1 AND deleted_at IS NULL RETURNING id`,
    [tenantId],
  );
  for (const id of new Set(profiles.map((row) => row.id))) await context.authz?.remove(tx, { type: 'profile', id, tenantId });
  const signers = await tx.query(`UPDATE image_signers SET revoked_at = compute_now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId]);
  return {
    workflowsAborted: active.length,
    imagesDeleted: images.length,
    profilesDeleted: profiles.length,
    signersRevoked: signers.rowCount ?? 0,
  };
}
