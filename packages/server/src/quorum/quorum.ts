import { createHash } from 'node:crypto';
import {
  ComputeError,
  defineMethod,
  defineModule,
  newId,
  type ComputeModule,
  type MethodDefinition,
  type Migration,
  type ModuleContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import {
  batchScope,
  requiredApprovals,
  verifyBatchApproval,
  type ApproverKey,
  type BatchScopeEntry,
} from '@better-compute/pki';
import {
  BatchApprovalSchema,
  BatchProofSchema,
  encodeMessage,
  type BatchApproval,
  type Signature,
} from '@better-compute/protocol';
import { derivedId } from '../api/common.js';
import { trustBundleApproverSetMigration, trustBundleStateMigration } from './trust-version.js';

// The destructive-batch quorum, server side (PLAN.md §13, v1.0). A batch is a set of (subject, kind)
// leaves, fixed when it is created: its Merkle root, size and every leaf's inclusion proof are
// stored then. Commands enqueued into a batch that needs approvals stay pending (not_before =
// infinity) until k distinct approver keys, held by people off the control plane, have signed the
// root (`commandBatches.approve`). The gateway then sends each command with the encoded approval
// and its leaf's proof, and the daemon checks both. The approval is cryptographic; the IAM decision
// on `compute:batches:approve` comes on top of it, never instead of it.

export const quorumModuleName = 'quorum';
export const quorumWorkKind = 'quorum.batches';

/** Leaves a batch may hold (a scope list the approval UI can still page through). */
export const maxBatchLeaves = 50_000;
/** How long a batch waits for its approvals by default. */
export const defaultBatchTtlMs = 24 * 3_600_000;

export const quorumMigration: Migration = {
  name: 'quorum/0001_batches',
  sql: `
CREATE TABLE command_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  reason text NOT NULL,
  scope_root bytea NOT NULL CHECK (length(scope_root) = 32),
  scope_size int NOT NULL CHECK (scope_size > 0),
  -- Distinct approver signatures needed (the trust bundle's tier for scope_size); 0: no quorum.
  required int NOT NULL CHECK (required >= 0),
  not_after timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'expired', 'cancelled')),
  -- The encoded BatchApproval the gateway attaches to every member command, once approved.
  approval bytea,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  approved_at timestamptz,
  version bigint NOT NULL DEFAULT 1
);
CREATE INDEX command_batches_tenant ON command_batches (tenant_id, created_at DESC);
CREATE INDEX command_batches_pending ON command_batches (not_after) WHERE state = 'pending';
-- One row per leaf, with its encoded BatchProof: the tree is fixed at creation.
CREATE TABLE command_batch_scope (
  batch_id text NOT NULL REFERENCES command_batches ON DELETE CASCADE,
  subject text NOT NULL,
  kind text NOT NULL,
  leaf_index int NOT NULL,
  proof bytea NOT NULL,
  PRIMARY KEY (batch_id, subject, kind)
);
CREATE UNIQUE INDEX command_batch_scope_index ON command_batch_scope (batch_id, leaf_index);
-- Commands enqueued into a batch (CommandQueue writes them).
CREATE TABLE command_batch_members (
  command_id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES command_batches ON DELETE CASCADE,
  subject text NOT NULL,
  kind text NOT NULL
);
CREATE INDEX command_batch_members_batch ON command_batch_members (batch_id);
CREATE TABLE command_batch_approvals (
  batch_id text NOT NULL REFERENCES command_batches ON DELETE CASCADE,
  kid text NOT NULL,
  sig bytea NOT NULL,
  approved_by text,
  at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (batch_id, kid)
);
`,
};

/**
 * quorum/0002 (review #6): a leaf binds (subject, kind, payload digest), where an empty digest
 * means "any payload of this kind" (a payload built later), so the scope table keys on all three.
 */
export const quorumPayloadMigration: Migration = {
  name: 'quorum/0002_payload_digest',
  sql: `
ALTER TABLE command_batch_scope ADD COLUMN payload_sha256 bytea NOT NULL DEFAULT '\\x';
ALTER TABLE command_batch_scope DROP CONSTRAINT command_batch_scope_pkey;
ALTER TABLE command_batch_scope ADD PRIMARY KEY (batch_id, subject, kind, payload_sha256);
ALTER TABLE command_batch_members ADD COLUMN payload_sha256 bytea NOT NULL DEFAULT '\\x';
`,
};

/** `commandBatches.create` retries: the request a caller's key stands for. */
export const quorumRequestMigration: Migration = {
  name: 'quorum/0005_batch_request',
  sql: `ALTER TABLE command_batches ADD COLUMN request_sha256 bytea;`,
};

/** The quorum a deployment publishes in its trust bundle (`pki.approvers`). */
export interface QuorumConfig {
  approverKeys: readonly ApproverKey[];
  threshold: number;
  tiers: readonly { maxScopeSize: number; threshold: number }[];
  /** The deployment's trust domain, a signed part of every approval (JoinService's). */
  trustDomain?: string | undefined;
}

/** The trust bundle's quorum fields as a config; undefined when no approver keys are published. */
export function quorumConfigOf(
  bundle:
    | {
        approverKeys?: readonly ApproverKey[];
        approverThreshold?: number;
        quorumTiers?: readonly { maxScopeSize: number; threshold: number }[];
      }
    | undefined,
  trustDomain?: string,
): QuorumConfig | undefined {
  if (!bundle?.approverKeys?.length || !bundle.approverThreshold) return undefined;
  return {
    approverKeys: bundle.approverKeys,
    threshold: bundle.approverThreshold,
    tiers: bundle.quorumTiers ?? [],
    ...(trustDomain ? { trustDomain } : {}),
  };
}

export type BatchState = 'pending' | 'approved' | 'expired' | 'cancelled';

export interface CommandBatchView {
  batchId: string;
  tenantId: string;
  reason: string;
  state: BatchState;
  /** Hex SHA-256 Merkle root of the (subject, kind, payload) leaves. */
  scopeRoot: string;
  /** The trust domain approvers sign with (a signed part of every approval); absent without one. */
  trustDomain?: string;
  scopeSize: number;
  /** Distinct approver signatures needed; 0 when the deployment has no quorum. */
  requiredApprovals: number;
  notAfter: number;
  approvals: { kid: string; at: number; approvedBy?: string }[];
  /** Commands enqueued into the batch so far, by state. */
  commands: Record<string, number>;
  createdAt: number;
  approvedAt?: number;
  createdBy?: string;
}

export interface CreateBatchInput {
  tenantId: string;
  scope: readonly BatchScopeEntry[];
  reason: string;
  /** When the batch stops admitting commands (default 24 h); approvals are signed up to it. */
  notAfterMs?: number;
  createdBy?: string;
  /**
   * A deterministic id (the API derives it from the caller's idempotency key) with the digest of
   * the request it stands for: the same request again returns the stored batch (`replayed`), a
   * different one under the same id is `CONFLICT`.
   */
  batchId?: string;
  requestSha256?: Uint8Array;
}

/**
 * Creates a batch in `tx`: its tree is computed now and every leaf stored with its proof.
 * `held` is true when the deployment's quorum needs approvals for this size.
 */
export async function createCommandBatch(
  tx: SqlTx,
  input: CreateBatchInput,
  options: { now: number; quorum?: QuorumConfig | undefined },
): Promise<{
  batchId: string;
  held: boolean;
  required: number;
  size: number;
  replayed?: true;
}> {
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500)
    throw new ComputeError('INVALID_INPUT', 'A batch needs a reason of at most 500 characters');
  if (!Array.isArray(input.scope) || input.scope.length === 0)
    throw new ComputeError('INVALID_INPUT', 'A batch needs at least one (subject, kind)');
  for (const entry of input.scope)
    if (
      typeof entry?.subject !== 'string' ||
      !entry.subject ||
      entry.subject.length > 512 ||
      typeof entry.kind !== 'string' ||
      !/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(entry.kind)
    )
      throw new ComputeError('INVALID_INPUT', 'Batch scope entries are { subject, kind }');
  const batchId = input.batchId ?? newId('batch');
  const scope = batchScope(batchId, input.scope);
  if (scope.size > maxBatchLeaves)
    throw new ComputeError('INVALID_INPUT', `A batch holds at most ${maxBatchLeaves} leaves`);
  const notAfter = input.notAfterMs ?? options.now + defaultBatchTtlMs;
  if (!Number.isFinite(notAfter) || notAfter <= options.now)
    throw new ComputeError('INVALID_INPUT', 'A batch must end in the future');
  const quorum = options.quorum;
  const required = quorum?.approverKeys.length
    ? requiredApprovals(scope.size, quorum.threshold, quorum.tiers)
    : 0;
  const inserted = await tx.query(
    `INSERT INTO command_batches (id, tenant_id, reason, scope_root, scope_size, required, not_after,
                                  state, created_by, request_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::float8 / 1000), 'pending', $8, $9)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [
      batchId,
      input.tenantId,
      input.reason.trim(),
      Buffer.from(scope.root),
      scope.size,
      required,
      notAfter,
      input.createdBy ?? null,
      input.requestSha256 ? Buffer.from(input.requestSha256) : null,
    ],
  );
  if (inserted.rows.length === 0) {
    // Only a caller-chosen id collides: the same request again, or a key reused for another.
    const { rows } = await tx.query<{
      tenant_id: string;
      request_sha256: Uint8Array | null;
      required: number;
      scope_size: number;
    }>(
      'SELECT tenant_id, request_sha256, required, scope_size FROM command_batches WHERE id = $1',
      [batchId],
    );
    const existing = rows[0];
    if (
      !existing ||
      existing.tenant_id !== input.tenantId ||
      !existing.request_sha256 ||
      !input.requestSha256 ||
      !Buffer.from(existing.request_sha256).equals(Buffer.from(input.requestSha256))
    )
      throw new ComputeError('CONFLICT', 'The idempotency key was already used for a different request');
    const stored = Number(existing.required);
    return { batchId, held: stored > 0, required: stored, size: Number(existing.scope_size), replayed: true };
  }
  const hexOf = (digest: Uint8Array | undefined) => Buffer.from(digest ?? []).toString('hex');
  const leaves = new Map<string, BatchScopeEntry>();
  for (const entry of input.scope)
    leaves.set(`${entry.subject}\0${entry.kind}\0${hexOf(entry.payloadSha256)}`, entry);
  const rows = [...leaves.values()].map((entry) => {
    const proof = scope.proofOf(entry.subject, entry.kind, entry.payloadSha256)!;
    return {
      ...entry,
      payload: hexOf(entry.payloadSha256),
      index: proof.index,
      proof: Buffer.from(
        encodeMessage(BatchProofSchema, {
          $typeName: 'bettercompute.agent.v1.BatchProof',
          index: proof.index,
          siblings: proof.siblings,
        }),
      ).toString('hex'),
    };
  });
  // Set-based, in chunks (a fleet-wide batch is tens of thousands of leaves).
  for (let start = 0; start < rows.length; start += 5_000) {
    const chunk = rows.slice(start, start + 5_000);
    await tx.query(
      `INSERT INTO command_batch_scope (batch_id, subject, kind, payload_sha256, leaf_index, proof)
       SELECT $1, v.subject, v.kind, decode(v.payload, 'hex'), v.leaf_index, decode(v.proof, 'hex')
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[])
              AS v(subject, kind, payload, leaf_index, proof)`,
      [
        batchId,
        chunk.map((row) => row.subject),
        chunk.map((row) => row.kind),
        chunk.map((row) => row.payload),
        chunk.map((row) => row.index),
        chunk.map((row) => row.proof),
      ],
    );
  }
  return { batchId, held: required > 0, required, size: scope.size };
}

interface BatchRow {
  id: string;
  tenant_id: string;
  reason: string;
  scope_root: Uint8Array;
  scope_size: number;
  required: number;
  not_after: Date | string;
  state: BatchState;
  created_by: string | null;
  created_at: Date | string;
  approved_at: Date | string | null;
}

const ms = (value: Date | string) => new Date(value).getTime();

/** A pending batch past its end reads as expired at once; the sweep records it and cancels its commands. */
const effectiveState = `CASE WHEN state = 'pending' AND not_after <= compute_now() THEN 'expired'
            ELSE state END AS state`;

async function readBatch(
  tx: Pick<SqlTx, 'query'>,
  tenantId: string,
  batchId: string,
  lock = false,
): Promise<BatchRow> {
  const { rows } = await tx.query<BatchRow>(
    `SELECT id, tenant_id, reason, scope_root, scope_size, required, not_after, ${effectiveState},
            created_by, created_at, approved_at
       FROM command_batches WHERE id = $1 AND tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [batchId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Batch ${batchId} not found`);
  return row;
}

async function batchView(
  tx: Pick<SqlTx, 'query'>,
  row: BatchRow,
  trustDomain?: string,
): Promise<CommandBatchView> {
  const approvals = await tx.query<{ kid: string; at: Date | string; approved_by: string | null }>(
    'SELECT kid, at, approved_by FROM command_batch_approvals WHERE batch_id = $1 ORDER BY at, kid',
    [row.id],
  );
  const commands = await tx.query<{ state: string; count: number | string }>(
    `SELECT c.state, count(*) AS count FROM command_batch_members m JOIN commands c ON c.id = m.command_id
      WHERE m.batch_id = $1 GROUP BY c.state`,
    [row.id],
  );
  return {
    batchId: row.id,
    tenantId: row.tenant_id,
    reason: row.reason,
    state: row.state,
    scopeRoot: Buffer.from(row.scope_root).toString('hex'),
    ...(trustDomain ? { trustDomain } : {}),
    scopeSize: Number(row.scope_size),
    requiredApprovals: Number(row.required),
    notAfter: ms(row.not_after),
    approvals: approvals.rows.map((approval) => ({
      kid: approval.kid,
      at: ms(approval.at),
      ...(approval.approved_by ? { approvedBy: approval.approved_by } : {}),
    })),
    commands: Object.fromEntries(commands.rows.map((entry) => [entry.state, Number(entry.count)])),
    createdAt: ms(row.created_at),
    ...(row.approved_at ? { approvedAt: ms(row.approved_at) } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
  };
}

const timestamp = (value: number) => {
  const seconds = Math.floor(value / 1000);
  return {
    $typeName: 'google.protobuf.Timestamp' as const,
    seconds: BigInt(seconds),
    nanos: (value - seconds * 1000) * 1_000_000,
  };
};

function approvalOf(row: BatchRow, signatures: Signature[]): BatchApproval {
  return {
    $typeName: 'bettercompute.agent.v1.BatchApproval',
    batchId: row.id,
    scopeRoot: new Uint8Array(row.scope_root),
    scopeSize: Number(row.scope_size),
    notAfter: timestamp(ms(row.not_after)),
    signatures,
  };
}

const signature = (kid: string, sig: Uint8Array): Signature => ({
  $typeName: 'bettercompute.common.v1.Signature',
  kid,
  sig,
  chain: [],
});

/** Ends a pending batch: its pending member commands are cancelled with `reason`. */
async function endBatch(
  tx: SqlTx,
  context: Pick<ModuleContext, 'events'>,
  row: BatchRow,
  state: 'expired' | 'cancelled',
): Promise<void> {
  await tx.query(
    `UPDATE command_batches SET state = $2, version = version + 1 WHERE id = $1 AND state = 'pending'`,
    [row.id, state],
  );
  await tx.query(
    `UPDATE commands c SET state = 'cancelled', reason = $2, not_before = compute_now()
       FROM command_batch_members m
      WHERE m.batch_id = $1 AND c.id = m.command_id AND c.state = 'pending'`,
    [row.id, `batch-${state}`],
  );
  await context.events.publish(tx, {
    type: `command.batch.${state}`,
    tenantId: row.tenant_id,
    subject: `batch/${row.id}`,
    data: { batchId: row.id, scopeSize: Number(row.scope_size) },
  });
}

// --- API --------------------------------------------------------------------------------------------

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const batchIdPattern = /^batch_[0-9a-z]{26,52}$/;

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ComputeError('INVALID_INPUT', 'The request must be an object');
  for (const key of Object.keys(raw))
    if (!allowed.includes(key))
      throw new ComputeError('INVALID_INPUT', `Unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}
function tenantOf(value: unknown): string {
  if (typeof value !== 'string' || !tenantPattern.test(value))
    throw new ComputeError('INVALID_INPUT', 'tenantId is invalid');
  return value;
}
function batchIdOf(value: unknown): string {
  if (typeof value !== 'string' || !batchIdPattern.test(value))
    throw new ComputeError('INVALID_INPUT', 'batchId is invalid');
  return value;
}
function limitOf(value: unknown, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new ComputeError('INVALID_INPUT', `limit must be a whole number from 1 to ${max}`);
  return value as number;
}

export interface BatchRef {
  tenantId: string;
  batchId: string;
}
export interface ListBatchesInput {
  tenantId: string;
  state?: BatchState;
  limit?: number;
  cursor?: string;
}
export interface BatchScopeInput extends BatchRef {
  /** Leaf index to start from (the previous page's `next`). */
  cursor?: number;
  limit?: number;
}
export interface CreateBatchRequest {
  tenantId: string;
  /** Shown to approvers (at most 500 characters). */
  reason: string;
  /**
   * The leaves approvers sign: `subject` is the node id for kinds a node runs on itself,
   * `bmc:<site agent node id>/<address>` for bmc.*, `node:<target>` for site.httpProxy.
   * `payloadSha256` (hex) binds a leaf to one exact payload; without it the leaf admits any payload
   * of its kind (approvers see it flagged).
   */
  scope: { subject: string; kind: string; payloadSha256?: string }[];
  /** How long the batch admits commands (and approvals), 60 s to 72 h; 24 h by default. */
  notAfterSeconds?: number;
  /** Scoped to (tenant, caller identity): a retry returns the same batch, never a second one. */
  idempotencyKey: string;
}

export interface ApproveBatchInput extends BatchRef {
  /** One approver's signature over the batch (pki signBatchApproval): `sig` is base64url. */
  signature: { kid: string; sig: string };
}

const parseRef = (
  raw: unknown,
  extra: readonly string[] = [],
): BatchRef & Record<string, unknown> => {
  const input = record(raw, ['tenantId', 'batchId', ...extra]);
  return { ...input, tenantId: tenantOf(input.tenantId), batchId: batchIdOf(input.batchId) };
};

const idempotencyKeyPattern = /^[A-Za-z0-9._~:/+=-]{1,128}$/;

function parseCreate(raw: unknown): CreateBatchRequest {
  const input = record(raw, ['tenantId', 'reason', 'scope', 'notAfterSeconds', 'idempotencyKey']);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500)
    throw new ComputeError('INVALID_INPUT', 'reason is required (at most 500 characters)');
  if (typeof input.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(input.idempotencyKey))
    throw new ComputeError('INVALID_INPUT', 'idempotencyKey is invalid');
  if (!Array.isArray(input.scope) || input.scope.length === 0 || input.scope.length > maxBatchLeaves)
    throw new ComputeError('INVALID_INPUT', `scope is 1 to ${maxBatchLeaves} leaves`);
  const scope = input.scope.map((raw, index) => {
    const entry = record(raw, ['subject', 'kind', 'payloadSha256']);
    if (typeof entry.subject !== 'string' || !entry.subject || entry.subject.length > 512)
      throw new ComputeError('INVALID_INPUT', `scope[${index}].subject is invalid`);
    if (typeof entry.kind !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(entry.kind))
      throw new ComputeError('INVALID_INPUT', `scope[${index}].kind is not a command kind`);
    if (
      entry.payloadSha256 !== undefined &&
      (typeof entry.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.payloadSha256))
    )
      throw new ComputeError('INVALID_INPUT', `scope[${index}].payloadSha256 is a hex SHA-256`);
    return {
      subject: entry.subject,
      kind: entry.kind,
      ...(entry.payloadSha256 ? { payloadSha256: entry.payloadSha256 as string } : {}),
    };
  });
  const result: CreateBatchRequest = {
    tenantId: tenantOf(input.tenantId),
    reason: input.reason,
    scope,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.notAfterSeconds !== undefined) {
    if (
      !Number.isInteger(input.notAfterSeconds) ||
      (input.notAfterSeconds as number) < 60 ||
      (input.notAfterSeconds as number) > 72 * 3600
    )
      throw new ComputeError('INVALID_INPUT', 'notAfterSeconds is 60 to 259200 (72 h)');
    result.notAfterSeconds = input.notAfterSeconds as number;
  }
  return result;
}

export type CommandBatchesApi = {
  commandBatches: {
    create: MethodDefinition<CreateBatchRequest, CommandBatchView>;
    get: MethodDefinition<BatchRef, CommandBatchView>;
    list: MethodDefinition<ListBatchesInput, { items: CommandBatchView[]; next?: string }>;
    scope: MethodDefinition<
      BatchScopeInput,
      {
        items: { leafIndex: number; subject: string; kind: string; payloadSha256: string }[];
        next?: number;
      }
    >;
    approve: MethodDefinition<ApproveBatchInput, CommandBatchView>;
    cancel: MethodDefinition<BatchRef, CommandBatchView>;
  };
};

/** The group (`commandBatches`) the quorum module serves (§9.2, v1.0). */
export function commandBatchesApi(options: {
  quorum?: QuorumConfig | undefined;
}): CommandBatchesApi {
  const quorum = options.quorum;
  const trustDomain = quorum?.trustDomain;
  // Decided on the tenant (the envelope adds the deployment's type prefix).
  const tenant = (input: { tenantId: string }) => ({ type: 'tenant', id: input.tenantId });

  return {
    commandBatches: {
      create: defineMethod<CreateBatchRequest, CommandBatchView>({
        action: 'compute:batches:create',
        kind: 'mutation',
        resource: tenant,
        validate: parseCreate,
        handler: async (context, input) => {
          const tx = context.sql as unknown as SqlTx;
          const scope = input.scope.map((entry) => ({
            subject: entry.subject,
            kind: entry.kind,
            ...(entry.payloadSha256
              ? { payloadSha256: new Uint8Array(Buffer.from(entry.payloadSha256, 'hex')) }
              : {}),
          }));
          // What the key stands for: the same leaves (in any order), reason and lifetime.
          const requestSha256 = createHash('sha256')
            .update(
              JSON.stringify([
                input.reason.trim(),
                input.notAfterSeconds ?? defaultBatchTtlMs / 1000,
                input.scope
                  .map((entry) => [entry.subject, entry.kind, entry.payloadSha256 ?? ''])
                  .sort((a, b) => (a.join('\0') < b.join('\0') ? -1 : 1)),
              ]),
            )
            .digest();
          const created = await createCommandBatch(
            tx,
            {
              tenantId: input.tenantId,
              scope,
              reason: input.reason,
              notAfterMs: context.clock.now() + (input.notAfterSeconds ?? defaultBatchTtlMs / 1000) * 1000,
              ...(context.caller?.identityId ? { createdBy: context.caller.identityId } : {}),
              batchId: await derivedId('batch', input.tenantId, context, input.idempotencyKey),
              requestSha256: new Uint8Array(requestSha256),
            },
            { now: context.clock.now(), quorum },
          );
          if (!created.replayed)
            await context.events.publish(tx, {
              type: 'command.batch.created',
              tenantId: input.tenantId,
              subject: `batch/${created.batchId}`,
              data: {
                batchId: created.batchId,
                scopeSize: created.size,
                requiredApprovals: created.required,
              },
            });
          return batchView(tx, await readBatch(tx, input.tenantId, created.batchId), trustDomain);
        },
      }),
      get: defineMethod<BatchRef, CommandBatchView>({
        action: 'compute:batches:read',
        kind: 'read',
        resource: tenant,
        validate: (raw) => parseRef(raw),
        handler: async (context, input) =>
          batchView(context.sql, await readBatch(context.sql, input.tenantId, input.batchId), trustDomain),
      }),
      list: defineMethod<ListBatchesInput, { items: CommandBatchView[]; next?: string }>({
        action: 'compute:batches:read',
        kind: 'read',
        resource: tenant,
        validate: (raw): ListBatchesInput => {
          const input = record(raw, ['tenantId', 'state', 'limit', 'cursor']);
          const result: ListBatchesInput = { tenantId: tenantOf(input.tenantId) };
          if (input.state !== undefined) {
            if (!['pending', 'approved', 'expired', 'cancelled'].includes(input.state as string))
              throw new ComputeError('INVALID_INPUT', 'state is not a batch state');
            result.state = input.state as BatchState;
          }
          if (input.limit !== undefined) result.limit = limitOf(input.limit, 200, 50);
          if (input.cursor !== undefined) result.cursor = batchIdOf(input.cursor);
          return result;
        },
        handler: async (context, input) => {
          const limit = input.limit ?? 50;
          const { rows } = await context.sql.query<BatchRow>(
            `SELECT * FROM (
               SELECT id, tenant_id, reason, scope_root, scope_size, required, not_after,
                      ${effectiveState}, created_by, created_at, approved_at
                 FROM command_batches WHERE tenant_id = $1) b
              WHERE ($2::text IS NULL OR state = $2)
                AND ($3::text IS NULL OR id < $3)
              ORDER BY id DESC LIMIT $4`,
            [input.tenantId, input.state ?? null, input.cursor ?? null, limit + 1],
          );
          const page = rows.slice(0, limit);
          const items = [];
          for (const row of page) items.push(await batchView(context.sql, row, trustDomain));
          return rows.length > limit ? { items, next: page.at(-1)!.id } : { items };
        },
      }),
      scope: defineMethod<
        BatchScopeInput,
        {
          items: { leafIndex: number; subject: string; kind: string; payloadSha256: string }[];
          next?: number;
        }
      >({
        action: 'compute:batches:read',
        kind: 'read',
        resource: tenant,
        validate: (raw): BatchScopeInput => {
          const input = parseRef(raw, ['cursor', 'limit']);
          const result: BatchScopeInput = { tenantId: input.tenantId, batchId: input.batchId };
          if (input.cursor !== undefined) {
            if (!Number.isInteger(input.cursor) || (input.cursor as number) < 0)
              throw new ComputeError('INVALID_INPUT', 'cursor is a leaf index');
            result.cursor = input.cursor as number;
          }
          if (input.limit !== undefined) result.limit = limitOf(input.limit, 5_000, 1_000);
          return result;
        },
        handler: async (context, input) => {
          await readBatch(context.sql, input.tenantId, input.batchId);
          const limit = input.limit ?? 1_000;
          const { rows } = await context.sql.query<{
            leaf_index: number;
            subject: string;
            kind: string;
            payload_sha256: Uint8Array;
          }>(
            `SELECT leaf_index, subject, kind, payload_sha256 FROM command_batch_scope
              WHERE batch_id = $1 AND leaf_index >= $2 ORDER BY leaf_index LIMIT $3`,
            [input.batchId, input.cursor ?? 0, limit + 1],
          );
          // payloadSha256 '' = the leaf admits any payload of its kind (flag it to approvers).
          const items = rows.slice(0, limit).map((row) => ({
            leafIndex: Number(row.leaf_index),
            subject: row.subject,
            kind: row.kind,
            payloadSha256: Buffer.from(row.payload_sha256).toString('hex'),
          }));
          return rows.length > limit ? { items, next: Number(rows[limit]!.leaf_index) } : { items };
        },
      }),
      approve: defineMethod<ApproveBatchInput, CommandBatchView>({
        action: 'compute:batches:approve',
        kind: 'mutation',
        resource: tenant,
        validate: (raw): ApproveBatchInput => {
          const input = parseRef(raw, ['signature']);
          const signed = record(input.signature, ['kid', 'sig']);
          if (typeof signed.kid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signed.kid))
            throw new ComputeError('INVALID_INPUT', 'signature.kid is an approver key id');
          if (typeof signed.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.sig))
            throw new ComputeError('INVALID_INPUT', 'signature.sig is a base64url P-256 signature');
          return {
            tenantId: input.tenantId,
            batchId: input.batchId,
            signature: { kid: signed.kid, sig: signed.sig },
          };
        },
        handler: async (context, input) => {
          const tx = context.sql as unknown as SqlTx;
          const row = await readBatch(tx, input.tenantId, input.batchId, true);
          const now = context.clock.now();
          if (row.state !== 'pending')
            throw new ComputeError('INVALID_STATE', `Batch ${row.id} is ${row.state}`);
          if (!quorum?.approverKeys.length || Number(row.required) === 0)
            throw new ComputeError('INVALID_STATE', `Batch ${row.id} needs no approvals`);
          if (!trustDomain)
            throw new ComputeError(
              'INVALID_CONFIG',
              'Approvals are signed for the trust domain: configure pki.join (JoinService)',
            );
          const given = signature(
            input.signature.kid,
            new Uint8Array(Buffer.from(input.signature.sig, 'base64url')),
          );
          // This signature alone first: a known approver key, over exactly this batch.
          verifyBatchApproval(approvalOf(row, [given]), {
            approverKeys: quorum.approverKeys,
            threshold: 1,
            now,
            trustDomain,
          });
          await tx.query(
            `INSERT INTO command_batch_approvals (batch_id, kid, sig, approved_by)
             VALUES ($1, $2, $3, $4) ON CONFLICT (batch_id, kid) DO NOTHING`,
            [row.id, given.kid, Buffer.from(given.sig), context.caller?.identityId ?? null],
          );
          const stored = await tx.query<{ kid: string; sig: Uint8Array }>(
            'SELECT kid, sig FROM command_batch_approvals WHERE batch_id = $1 ORDER BY kid',
            [row.id],
          );
          const approval = approvalOf(
            row,
            stored.rows.map((entry) => signature(entry.kid, new Uint8Array(entry.sig))),
          );
          let complete = true;
          try {
            verifyBatchApproval(approval, {
              approverKeys: quorum.approverKeys,
              threshold: quorum.threshold,
              tiers: quorum.tiers,
              now,
              trustDomain,
            });
          } catch {
            complete = false;
          }
          if (complete) {
            await tx.query(
              `UPDATE command_batches SET state = 'approved', approval = $2, approved_at = compute_now(),
                      version = version + 1
                WHERE id = $1`,
              [row.id, Buffer.from(encodeMessage(BatchApprovalSchema, approval))],
            );
            // Release: the held member commands become due now (the gateway's dispatch picks them up).
            await tx.query(
              `UPDATE commands c SET not_before = compute_now()
                 FROM command_batch_members m
                WHERE m.batch_id = $1 AND c.id = m.command_id AND c.state = 'pending'`,
              [row.id],
            );
            await context.events.publish(tx, {
              type: 'command.batch.approved',
              tenantId: row.tenant_id,
              subject: `batch/${row.id}`,
              data: {
                batchId: row.id,
                scopeSize: Number(row.scope_size),
                approvers: stored.rows.map((entry) => entry.kid),
              },
            });
          }
          return batchView(tx, await readBatch(tx, input.tenantId, input.batchId), trustDomain);
        },
      }),
      cancel: defineMethod<BatchRef, CommandBatchView>({
        action: 'compute:batches:approve',
        kind: 'mutation',
        resource: tenant,
        validate: (raw) => parseRef(raw),
        handler: async (context, input) => {
          const tx = context.sql as unknown as SqlTx;
          const row = await readBatch(tx, input.tenantId, input.batchId, true);
          if (row.state !== 'pending')
            throw new ComputeError('INVALID_STATE', `Batch ${row.id} is ${row.state}`);
          await endBatch(tx, context, row, 'cancelled');
          return batchView(tx, await readBatch(tx, input.tenantId, input.batchId), trustDomain);
        },
      }),
    },
  };
}

/** Expires pending batches past their end (their held commands are cancelled), every minute. */
function expiryReconciler(): Reconciler {
  return {
    name: quorumWorkKind,
    shardBy: 'none',
    periodic: [{ key: 'expire', every: '1m' }],
    async run(context) {
      await context.sql.transaction(async (tx) => {
        const { rows } = await tx.query<BatchRow>(
          `SELECT id, tenant_id, reason, scope_root, scope_size, required, not_after, state,
                  created_by, created_at, approved_at
             FROM command_batches WHERE state = 'pending' AND not_after <= compute_now()
            ORDER BY not_after LIMIT 500 FOR UPDATE SKIP LOCKED`,
        );
        for (const row of rows) await endBatch(tx, context, row, 'expired');
      });
      return 'DONE';
    },
  };
}

/** The built-in quorum module: batch tables, `commandBatches`, and the expiry sweep. */
export function createQuorumModule(options: {
  quorum?: QuorumConfig | undefined;
}): ComputeModule<typeof quorumModuleName, CommandBatchesApi> {
  return Object.freeze(
    defineModule<typeof quorumModuleName, CommandBatchesApi>({
      name: quorumModuleName,
      migrations: [
        quorumMigration,
        quorumPayloadMigration,
        trustBundleStateMigration,
        trustBundleApproverSetMigration,
        quorumRequestMigration,
      ],
      api: () => commandBatchesApi(options),
      reconcilers: [expiryReconciler()],
      // A deleted tenant's pending batches end, and their held commands with them.
      async tenantDeleted(context, tenantId) {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<BatchRow>(
            `SELECT id, tenant_id, reason, scope_root, scope_size, required, not_after, state,
                    created_by, created_at, approved_at
               FROM command_batches WHERE tenant_id = $1 AND state = 'pending' FOR UPDATE`,
            [tenantId],
          );
          for (const row of rows) await endBatch(tx, context, row, 'cancelled');
        });
        return 'DONE';
      },
    }),
  );
}
