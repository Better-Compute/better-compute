import type { ModuleContext, SqlTx } from '@better-compute/core';

// Break-glass access ends with the grant that allowed it (PLAN.md §12.8 "binding:activate|deactivate: cap or close
// break-glass sessions", §13). Node-bound SSH certificates are issued only for `compute:nodes:ssh-root`, the
// break-glass role; when IAM withdraws that role from an identity, every certificate it still holds in the tenant
// is revoked, exactly as `nodes.revokeSshCert` revokes one: the serial joins the node's KRL through its next spec.

export interface RevokedSshCertificate {
  serial: string;
  nodeId: string;
}

/** Revokes the identity's unexpired, unrevoked SSH certificates in `tenantId`; returns them. */
export async function revokeIdentitySshCertificates(
  tx: SqlTx,
  context: Pick<ModuleContext, 'desired' | 'events'>,
  input: { tenantId: string; identityId: string; reason: string; by: string },
): Promise<RevokedSshCertificate[]> {
  // The table exists only with the tunnels module; without it there is nothing to revoke.
  const { rows: table } = await tx.query<{ found: string | null }>(
    "SELECT to_regclass('ssh_certificates')::text AS found",
  );
  if (!table[0]?.found) return [];
  const { rows } = await tx.query<{ serial: string; node_id: string }>(
    `UPDATE ssh_certificates
        SET revoked_at = compute_now(), revoked_by = $3, revoke_reason = $4
      WHERE tenant_id = $1 AND identity_id = $2 AND revoked_at IS NULL AND expires_at > compute_now()
      RETURNING serial, node_id`,
    [input.tenantId, input.identityId, input.by, input.reason],
  );
  const nodes = [...new Set(rows.map((row) => row.node_id))].sort();
  // Each node's spec changes (its revoked serials): push it.
  for (const nodeId of nodes) await context.desired.invalidate(tx, nodeId);
  for (const row of rows)
    await context.events.publish(tx, {
      type: 'node.ssh-cert.revoked',
      tenantId: input.tenantId,
      subject: `node/${row.node_id}`,
      data: { serial: row.serial, identityId: input.identityId, reason: input.reason },
    });
  return rows.map((row) => ({ serial: row.serial, nodeId: row.node_id }));
}
