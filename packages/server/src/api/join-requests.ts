import {
  ComputeError,
  defineMethod,
  idPrefixes,
  type Json,
  type MethodContext,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import { callerOf, fields, idPattern, int, limit, ms, notFound, page, type Page } from './common.js';
import { parser, v } from './input.js';

// `joinRequests` (PLAN.md §3.3 step 4, §9.2, module server, v0.2): the approval queue of joins an
// attestor deferred: a machine whose hardware key is built from placeholder DMI values, or one the
// `discovery` attestor found unknown on a site whose policy asks for approval. JoinService commits
// the `pending` row without spending the token and answers with a deferral. An operator approves or
// rejects the row, and the daemon's retry (same CSR) consumes an `approved` row in its own join
// transaction, so an approval admits one join. Every method is decided on `compute-pool/{poolId}`.

export type JoinRequestState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export interface JoinRequestInfo {
  id: string;
  tenantId: string;
  siteId: string;
  /** Unset until an approval assigns the pool (discovery of an unknown machine names only its site). */
  poolId?: string;
  attestor: string;
  state: JoinRequestState;
  /** The machine's identifiers as the attestor saw them (DMI, MACs, TPM EK hash, ...). */
  claims: Record<string, Json>;
  /** Hex of `hardware_key` (§8.3), when the attestor could compute one. */
  hardwareKey?: string;
  mac?: string;
  ip?: string;
  workflowId?: string;
  /** The site agent that vouched for the machine, and its boot-lease epoch then. */
  vouchedBy?: string;
  bootLeaseEpoch?: number;
  /** Hex of sha256 over the CSR the retry must present. */
  csrSha256: string;
  nodeId?: string;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  consumedAt?: number;
  version: number;
}

export interface ListJoinRequestsInput {
  tenantId: string;
  poolId: string;
  /** Default `pending`; `all` lists every state. */
  state?: JoinRequestState | 'all';
  /** At most 200 (100 by default). */
  limit?: number;
  cursor?: string;
}
export interface ApproveJoinRequestInput {
  tenantId: string;
  poolId: string;
  requestId: string;
  /** How long the approval waits for the machine's retry (60 s to a day; one hour by default). */
  ttlSeconds?: number;
  reason?: string;
}
export interface RejectJoinRequestInput {
  tenantId: string;
  poolId: string;
  requestId: string;
  reason?: string;
}

export type JoinRequestsApi = {
  joinRequests: {
    list: MethodDefinition<ListJoinRequestsInput, Page<JoinRequestInfo>>;
    approve: MethodDefinition<ApproveJoinRequestInput, JoinRequestInfo>;
    reject: MethodDefinition<RejectJoinRequestInput, JoinRequestInfo>;
  };
};

// --- Inputs --------------------------------------------------------------------------------------

const requestId = v.string({ pattern: idPattern(idPrefixes.joinRequest), max: 64 });
const states = ['pending', 'approved', 'rejected', 'expired', 'consumed', 'all'] as const;
const listInput: (input: unknown) => ListJoinRequestsInput = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  state: v.withDefault(v.option(states), 'pending'),
  limit: limit(200, 100),
  cursor: v.optional(requestId),
});
const approveInput: (input: unknown) => ApproveJoinRequestInput = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  requestId,
  ttlSeconds: v.withDefault(v.int({ min: 60, max: 86_400 }), 3600),
  reason: v.optional(fields.reason),
});
const rejectInput: (input: unknown) => RejectJoinRequestInput = parser({
  tenantId: fields.tenantId,
  poolId: fields.poolId,
  requestId,
  reason: v.optional(fields.reason),
});

// --- Rows ----------------------------------------------------------------------------------------

interface RequestRow {
  id: string;
  tenant_id: string;
  site_id: string;
  pool_id: string | null;
  attestor: string;
  state: JoinRequestState;
  claims: Record<string, Json>;
  hardware_key: Uint8Array | null;
  mac: string | null;
  ip: string | null;
  workflow_id: string | null;
  vouched_by: string | null;
  boot_lease_epoch: unknown;
  csr_sha256: Uint8Array;
  node_id: string | null;
  reason: string | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  consumed_at: Date | null;
  version: unknown;
}
// A pending or approved row past its expiry reads as expired, whether or not the sweep got to it.
const columns = `r.id, r.tenant_id, r.site_id, r.pool_id, r.attestor,
  CASE WHEN r.state IN ('pending', 'approved') AND r.expires_at <= compute_now() THEN 'expired'
       ELSE r.state END AS state,
  r.claims, r.hardware_key, r.mac, r.ip, r.workflow_id, r.vouched_by, r.boot_lease_epoch,
  r.csr_sha256, r.node_id, r.reason, r.created_at, r.expires_at, r.decided_at, r.decided_by,
  r.consumed_at, r.version`;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function toRequest(row: RequestRow): JoinRequestInfo {
  const request: JoinRequestInfo = {
    id: row.id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    attestor: row.attestor,
    state: row.state,
    claims: row.claims ?? {},
    csrSha256: hex(row.csr_sha256),
    createdAt: ms(row.created_at)!,
    expiresAt: ms(row.expires_at)!,
    version: int(row.version),
  };
  if (row.pool_id !== null) request.poolId = row.pool_id;
  if (row.hardware_key !== null) request.hardwareKey = hex(row.hardware_key);
  if (row.mac !== null) request.mac = row.mac;
  if (row.ip !== null) request.ip = row.ip;
  if (row.workflow_id !== null) request.workflowId = row.workflow_id;
  if (row.vouched_by !== null) request.vouchedBy = row.vouched_by;
  if (row.boot_lease_epoch !== null) request.bootLeaseEpoch = int(row.boot_lease_epoch);
  if (row.node_id !== null) request.nodeId = row.node_id;
  if (row.reason !== null) request.reason = row.reason;
  if (row.decided_by !== null) request.decidedBy = row.decided_by;
  for (const [key, value] of [
    ['decidedAt', row.decided_at],
    ['consumedAt', row.consumed_at],
  ] as const) {
    const time = ms(value);
    if (time !== undefined) request[key] = time;
  }
  return request;
}

/** The pool, when the tenant owns it: requests are the owner's to decide (§3.3). */
async function ownedPool(tx: SqlTx, tenantId: string, poolId: string, lock = '') {
  const { rows } = await tx.query<{ site_id: string; archived: boolean }>(
    `SELECT site_id, archived_at IS NOT NULL AS archived FROM pools
      WHERE id = $1 AND owner_tenant_id = $2 ${lock}`,
    [poolId, tenantId],
  );
  if (!rows[0]) throw notFound('Pool');
  return rows[0];
}

/**
 * The request as seen from this pool: its own requests, and its site's requests no pool claimed
 * yet. Locked for a decision.
 */
async function requestInPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  siteId: string,
  id: string,
  lock = '',
): Promise<RequestRow> {
  const { rows } = await tx.query<RequestRow>(
    `SELECT ${columns} FROM join_requests r
      WHERE r.id = $1 AND r.tenant_id = $2
        AND (r.pool_id = $3 OR (r.pool_id IS NULL AND r.site_id = $4)) ${lock}`,
    [id, tenantId, poolId, siteId],
  );
  if (!rows[0]) throw notFound('Join request');
  return rows[0];
}

const decided = (row: RequestRow, state: JoinRequestState) =>
  new ComputeError('INVALID_STATE', `The join request is already ${row.state}`, undefined, {
    state: row.state,
    wanted: state,
  });

async function publish(
  context: MethodContext,
  row: RequestRow,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await context.events.publish(context.sql, {
    type,
    tenantId: row.tenant_id,
    subject: row.pool_id === null ? `site/${row.site_id}` : `pool/${row.pool_id}`,
    data: {
      requestId: row.id,
      siteId: row.site_id,
      poolId: row.pool_id,
      attestor: row.attestor,
      ...(row.node_id === null ? {} : { nodeId: row.node_id }),
      ...data,
    },
  });
}

/**
 * Marks pending and approved requests past their expiry as expired (at most `limit`), and returns
 * how many. Reads already show them as expired; this keeps the pending index free for a new request.
 */
export async function expireJoinRequests(tx: SqlTx, limit = 1000): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE join_requests SET state = 'expired', version = version + 1
      WHERE id IN (SELECT id FROM join_requests
                    WHERE state IN ('pending', 'approved') AND expires_at <= compute_now()
                    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [limit],
  );
  return rowCount;
}

export function joinRequestsApi(): JoinRequestsApi {
  return {
    joinRequests: {
      list: defineMethod<ListJoinRequestsInput, Page<JoinRequestInfo>>({
        action: 'compute:join-tokens:read',
        kind: 'read',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: listInput,
        async handler(context, input) {
          const pool = await ownedPool(context.sql, input.tenantId, input.poolId);
          const size = input.limit ?? 100;
          const { rows } = await context.sql.query<RequestRow>(
            `SELECT * FROM (
               SELECT ${columns} FROM join_requests r
                WHERE r.tenant_id = $1 AND (r.pool_id = $2 OR (r.pool_id IS NULL AND r.site_id = $3))
                  AND ($4::text IS NULL OR r.id > $4)
             ) listed
             WHERE $5 = 'all' OR listed.state = $5
             ORDER BY listed.id LIMIT $6`,
            [input.tenantId, input.poolId, pool.site_id, input.cursor ?? null, input.state ?? 'pending', size + 1],
          );
          return page(rows, size, toRequest, (row) => row.id);
        },
      }),
      approve: defineMethod<ApproveJoinRequestInput, JoinRequestInfo>({
        action: 'compute:join-tokens:create',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: approveInput,
        async handler(context, input) {
          // Lock order: pools before anything else (coordination.md).
          const pool = await ownedPool(context.sql, input.tenantId, input.poolId, 'FOR SHARE');
          const row = await requestInPool(
            context.sql,
            input.tenantId,
            input.poolId,
            pool.site_id,
            input.requestId,
            'FOR UPDATE OF r',
          );
          // Approving twice answers with the approval; any other decided state is final.
          if (row.state === 'approved' && row.pool_id === input.poolId) return toRequest(row);
          if (row.state !== 'pending') throw decided(row, 'approved');
          if (pool.archived)
            throw new ComputeError('INVALID_STATE', 'The pool is archived and admits no machines');
          const { rows } = await context.sql.query<RequestRow>(
            `UPDATE join_requests r SET state = 'approved', pool_id = $2, decided_at = compute_now(),
               decided_by = $3, reason = COALESCE($4, r.reason),
               expires_at = compute_now() + make_interval(secs => $5::int), version = r.version + 1
             WHERE r.id = $1 AND r.state = 'pending'
             RETURNING ${columns}`,
            [row.id, input.poolId, callerOf(context).identityId, input.reason ?? null, input.ttlSeconds ?? 3600],
          );
          const approved = rows[0]!;
          await publish(context, approved, 'security.join-request.approved', {
            expiresAt: new Date(ms(approved.expires_at)!).toISOString(),
          });
          return toRequest(approved);
        },
      }),
      reject: defineMethod<RejectJoinRequestInput, JoinRequestInfo>({
        action: 'compute:join-tokens:create',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: rejectInput,
        async handler(context, input) {
          const pool = await ownedPool(context.sql, input.tenantId, input.poolId, 'FOR SHARE');
          const row = await requestInPool(
            context.sql,
            input.tenantId,
            input.poolId,
            pool.site_id,
            input.requestId,
            'FOR UPDATE OF r',
          );
          if (row.state === 'rejected') return toRequest(row);
          // An approval the machine has not used yet can still be withdrawn.
          if (row.state !== 'pending' && row.state !== 'approved') throw decided(row, 'rejected');
          const { rows } = await context.sql.query<RequestRow>(
            `UPDATE join_requests r SET state = 'rejected', decided_at = compute_now(), decided_by = $2,
               reason = COALESCE($3, r.reason), version = r.version + 1
             WHERE r.id = $1 AND r.state IN ('pending', 'approved')
             RETURNING ${columns}`,
            [row.id, callerOf(context).identityId, input.reason ?? null],
          );
          const rejected = rows[0]!;
          await publish(context, rejected, 'security.join-request.rejected', {
            ...(input.reason ? { reason: input.reason } : {}),
          });
          return toRequest(rejected);
        },
      }),
    },
  };
}
