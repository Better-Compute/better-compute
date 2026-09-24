import { ComputeError, newId, type SqlTx } from '@better-compute/core';

// The attestor side of `join_requests` (core/0010), the operator approval queue behind
// joinRequests.approve/reject. Attestors that need a human decision defer with
// `{ deferred: 'approval', requestId }`; JoinService commits the deferral, the operator decides, and
// the agent's retry (same CSR) consumes the approved row inside its join transaction.

/** How a request names the machine: a trusted key (DMI hardware key, TPM EK hash), else site+MAC. */
export interface RequestMachine {
  key: Uint8Array | undefined;
  siteId: string;
  mac: string | undefined;
}

function machineMatch(machine: RequestMachine, first: number): { sql: string; params: unknown[] } {
  if (machine.key) return { sql: `hardware_key = $${first}`, params: [machine.key] };
  if (!machine.mac)
    throw new ComputeError('INVALID_INPUT', 'A join request needs a hardware key or a MAC');
  return {
    sql: `hardware_key IS NULL AND site_id = $${first} AND mac = $${first + 1}`,
    params: [machine.siteId, machine.mac],
  };
}

export interface ApprovedRequest {
  id: string;
  node_id: string | null;
  pool_id: string | null;
  site_id: string;
}

/** Consumes the approved, unexpired request for this machine and CSR (single use), if any. */
export async function consumeApprovedRequest(
  tx: SqlTx,
  input: { tenantId: string; attestor: string; csrSha256: Uint8Array; machine: RequestMachine },
): Promise<ApprovedRequest | undefined> {
  const match = machineMatch(input.machine, 4);
  const { rows } = await tx.query<ApprovedRequest>(
    `UPDATE join_requests SET state = 'consumed', consumed_at = compute_now(), version = version + 1
      WHERE tenant_id = $1 AND attestor = $2 AND state = 'approved' AND csr_sha256 = $3
        AND expires_at > compute_now() AND ${match.sql}
      RETURNING id, node_id, pool_id, site_id`,
    [input.tenantId, input.attestor, input.csrSha256, ...match.params],
  );
  return rows[0];
}

/** Whether an operator rejected this machine's request for this CSR. */
export async function requestRejected(
  tx: SqlTx,
  input: { tenantId: string; attestor: string; csrSha256: Uint8Array; machine: RequestMachine },
): Promise<boolean> {
  const match = machineMatch(input.machine, 4);
  const { rows } = await tx.query(
    `SELECT 1 FROM join_requests
      WHERE tenant_id = $1 AND attestor = $2 AND state = 'rejected' AND csr_sha256 = $3
        AND ${match.sql} LIMIT 1`,
    [input.tenantId, input.attestor, input.csrSha256, ...match.params],
  );
  return rows.length > 0;
}

export interface PendingRequestInput {
  tenantId: string;
  attestor: string;
  poolId: string | null;
  csrSha256: Uint8Array;
  machine: RequestMachine;
  claims: unknown;
  ip?: string | null;
  workflowId?: string | null;
  vouchedBy?: string | null;
  epoch?: bigint | null;
  nodeId?: string | null;
  ttlSeconds: number;
}

/**
 * The machine's pending request, created or refreshed: the newest attempt's CSR is the one an
 * approval admits (a machine that rebooted has a new key). At most one pending row per machine.
 */
export async function recordPendingRequest(tx: SqlTx, input: PendingRequestInput): Promise<string> {
  const epoch = input.epoch === undefined || input.epoch === null ? null : input.epoch.toString();
  const refresh = async () => {
    const match = machineMatch(input.machine, 7);
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE join_requests SET csr_sha256 = $2, ip = COALESCE($3, ip),
              vouched_by = COALESCE($4, vouched_by), boot_lease_epoch = COALESCE($5, boot_lease_epoch),
              claims = $6, version = version + 1
        WHERE tenant_id = $1 AND state = 'pending' AND ${match.sql} RETURNING id`,
      [
        input.tenantId,
        input.csrSha256,
        input.ip ?? null,
        input.vouchedBy ?? null,
        epoch,
        JSON.stringify(input.claims ?? {}),
        ...match.params,
      ],
    );
    return rows[0]?.id;
  };
  const existing = await refresh();
  if (existing) return existing;
  const id = newId('jreq');
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO join_requests (id, tenant_id, site_id, pool_id, attestor, state, claims, hardware_key,
       mac, ip, workflow_id, vouched_by, boot_lease_epoch, csr_sha256, node_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14,
       compute_now() + make_interval(secs => $15))
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      id,
      input.tenantId,
      input.machine.siteId,
      input.poolId,
      input.attestor,
      JSON.stringify(input.claims ?? {}),
      input.machine.key ?? null,
      input.machine.mac ?? null,
      input.ip ?? null,
      input.workflowId ?? null,
      input.vouchedBy ?? null,
      epoch,
      input.csrSha256,
      input.nodeId ?? null,
      input.ttlSeconds,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  // A concurrent attempt inserted it first (or decided it in between): let the agent retry.
  const raced = await refresh();
  if (raced) return raced;
  throw new ComputeError('CONFLICT', 'The join request changed concurrently; retry', undefined, {
    retryAfterMs: 1000,
  });
}
