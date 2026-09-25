import type { AuthzWriter, SqlTx } from '@better-compute/core';
import { abortWorkflow, type EngineContext } from './engine.js';

// A deleted tenant's provisioning state (the server's tenancy teardown, PLAN.md §12.5): its active
// workflows are aborted (their cleanup still runs), its private images and its profiles are soft
// deleted with their authz rows, and its image signers are revoked. Images it promoted to public stay:
// other tenants may deploy them, and they remain verified by the platform's allowlist only if the
// platform signed them. Idempotent and bounded: at most `limit` rows of each kind per call, with
// `more` telling the caller to come back (ComputeModule.tenantDeleted answers SYNC_AGAIN).

export interface ProvisionTenantTeardown {
  workflowsAborted: number;
  imagesDeleted: number;
  profilesDeleted: number;
  signersRevoked: number;
  /** Some kind hit `limit`: call again. */
  more: boolean;
}

export async function teardownTenantProvisioning(
  tx: SqlTx,
  context: EngineContext & { authz?: AuthzWriter },
  tenantId: string,
  options: { limit?: number } = {},
): Promise<ProvisionTenantTeardown> {
  const limit = options.limit ?? 100;
  const { rows: active } = await tx.query<{ id: string }>(
    `SELECT id FROM workflows WHERE tenant_id = $1 AND state IN ('pending', 'running', 'paused') AND outcome IS NULL
      ORDER BY id LIMIT $2`,
    [tenantId, limit],
  );
  for (const workflow of active) await abortWorkflow(context, tx, workflow.id, { tenantId, reason: 'tenant deleted' });
  const { rows: images } = await tx.query<{ id: string }>(
    `UPDATE images SET deleted_at = compute_now(), version = version + 1
      WHERE id IN (SELECT id FROM images WHERE tenant_id = $1 AND visibility = 'private' AND deleted_at IS NULL ORDER BY id LIMIT $2)
      RETURNING id`,
    [tenantId, limit],
  );
  for (const image of images) await context.authz?.remove(tx, { type: 'image', id: image.id, tenantId });
  const { rows: profiles } = await tx.query<{ id: string }>(
    `UPDATE profiles SET deleted_at = compute_now(), version = version + 1
      WHERE (tenant_id, id, profile_version) IN (
        SELECT tenant_id, id, profile_version FROM profiles WHERE tenant_id = $1 AND deleted_at IS NULL
         ORDER BY id, profile_version LIMIT $2)
      RETURNING id`,
    [tenantId, limit],
  );
  for (const id of new Set(profiles.map((row) => row.id))) await context.authz?.remove(tx, { type: 'profile', id, tenantId });
  const signers = await tx.query(`UPDATE image_signers SET revoked_at = compute_now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId]);
  return {
    workflowsAborted: active.length,
    imagesDeleted: images.length,
    profilesDeleted: profiles.length,
    signersRevoked: signers.rowCount ?? 0,
    more: active.length === limit || images.length === limit || profiles.length === limit,
  };
}
