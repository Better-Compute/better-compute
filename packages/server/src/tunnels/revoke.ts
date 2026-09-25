import type { ModuleContext, SqlTx } from '@better-compute/core';

// Break-glass access ends with the grant that allowed it (PLAN.md §12.8 "binding:activate|deactivate: cap or close
// break-glass sessions", §13). Node-bound SSH certificates are issued only for `compute:nodes:ssh-root`, the
// break-glass role; when IAM withdraws that role from an identity, ends its sessions or ends the identity, every
// certificate it still holds is revoked, exactly as `nodes.revokeSshCert` revokes one: the serial joins the node's
// KRL through its next spec.

export interface RevokedSshCertificate {
  serial: string;
  nodeId: string;
  tenantId: string;
}

/**
 * Revokes the identity's unexpired, unrevoked SSH certificates in `tenantId`, or in every tenant when it is
 * omitted (an identity that is gone, or whose sessions ended); returns them.
 */
export async function revokeIdentitySshCertificates(
  tx: SqlTx,
  context: Pick<ModuleContext, 'desired' | 'events'>,
  input: { tenantId?: string; identityId: string; reason: string; by: string },
): Promise<RevokedSshCertificate[]> {
  // The table exists only with the tunnels module; without it there is nothing to revoke.
  const { rows: table } = await tx.query<{ found: string | null }>(
    "SELECT to_regclass('ssh_certificates')::text AS found",
  );
  if (!table[0]?.found) return [];
  const { rows } = await tx.query<{ serial: string; node_id: string; tenant_id: string }>(
    `UPDATE ssh_certificates
        SET revoked_at = compute_now(), revoked_by = $3, revoke_reason = $4
      WHERE ($1::text IS NULL OR tenant_id = $1) AND identity_id = $2
        AND revoked_at IS NULL AND expires_at > compute_now()
      RETURNING serial, node_id, tenant_id`,
    [input.tenantId ?? null, input.identityId, input.by, input.reason],
  );
  rows.sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0));
  const nodes = [...new Set(rows.map((row) => row.node_id))].sort();
  // Each node's spec changes (its revoked serials): push it.
  for (const nodeId of nodes) await context.desired.invalidate(tx, nodeId);
  for (const row of rows)
    await context.events.publish(tx, {
      type: 'node.ssh-cert.revoked',
      tenantId: row.tenant_id,
      subject: `node/${row.node_id}`,
      data: { serial: row.serial, identityId: input.identityId, reason: input.reason },
    });
  return rows.map((row) => ({ serial: row.serial, nodeId: row.node_id, tenantId: row.tenant_id }));
}
