import { createHash } from 'node:crypto';
import { newId, type DriverDefinition, type SqlTx } from '@better-compute/core';
import type { JoinTokenMinter } from '../../packages/server/src/api/join-tokens.js';
import { serverHarness } from './server-api.js';

// The server harness for the v0.2 groups (registered in `coreGroups`). Secrets go to the default
// sealed store under the harness secret; `drivers` are what `drivers.list` shows.

export function v02Harness(options: { joinTokens?: JoinTokenMinter; drivers?: () => readonly DriverDefinition[] } = {}) {
  return serverHarness(options);
}

export const sha256 = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());

/** A join request as the attestor writes it (JoinService's deferral), pending by default. */
export async function seedJoinRequest(
  sql: SqlTx,
  row: {
    tenantId: string;
    siteId: string;
    poolId?: string;
    hardwareKey?: string;
    mac?: string;
    csr?: string;
    ttlSeconds?: number;
    attestor?: string;
  },
): Promise<string> {
  const id = newId('jreq');
  await sql.query(
    `INSERT INTO join_requests (id, tenant_id, site_id, pool_id, attestor, state, claims, hardware_key,
       mac, ip, vouched_by, boot_lease_epoch, csr_sha256, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7, $8, '10.0.0.9', 'node_s1te', 3, $9,
       compute_now() + make_interval(secs => $10::int))`,
    [
      id,
      row.tenantId,
      row.siteId,
      row.poolId ?? null,
      row.attestor ?? 'discovery',
      JSON.stringify({ serial: 'To Be Filled By O.E.M.', mac: row.mac ?? null }),
      row.hardwareKey === undefined ? null : sha256(row.hardwareKey),
      row.mac ?? null,
      sha256(row.csr ?? `csr-${id}`),
      row.ttlSeconds ?? 900,
    ],
  );
  return id;
}

/** What the attestor does on the daemon's retry: consume one approved row for this CSR. */
export async function consumeApproved(
  sql: SqlTx,
  match: { tenantId: string; hardwareKey?: string; siteId?: string; mac?: string; csr: string; nodeId: string },
) {
  const { rows } = await sql.query<{ id: string }>(
    `UPDATE join_requests SET state = 'consumed', consumed_at = compute_now(), node_id = $6,
       version = version + 1
      WHERE tenant_id = $1 AND state = 'approved' AND csr_sha256 = $2 AND expires_at > compute_now()
        AND (hardware_key = $3 OR (hardware_key IS NULL AND site_id = $4 AND mac = $5))
      RETURNING id`,
    [
      match.tenantId,
      sha256(match.csr),
      match.hardwareKey === undefined ? null : sha256(match.hardwareKey),
      match.siteId ?? null,
      match.mac ?? null,
      match.nodeId,
    ],
  );
  return rows[0]?.id;
}
