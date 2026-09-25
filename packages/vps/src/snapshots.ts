import {
  ComputeError,
  draftId,
  newId,
  type CommandKindSpec,
  type Json,
  type Logger,
  type MessageDescriptor,
  type MethodContext,
  type Migration,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  decodeMessage,
  InstanceSnapshotResultSchema,
  MAX_COMMAND_BODY_BYTES,
} from '@better-compute/protocol';
import { id, key, object, optional, tenant } from './input.js';
import { cpuModelLabelValue, readInstance, type InstanceDeps } from './instances.js';

// Sandbox snapshots (PLAN.md §3.7): `sandboxes.snapshot` sends the host the `instance.snapshot`
// command; the runtime captures disk (and memory) state and uploads it to a presigned URL from the
// deployment's `SnapshotStore`. Snapshots are tenant data that include memory: they live in vps's
// own table, private to the sandbox's tenant (never promotable), and are deleted with the sandbox
// unless `keep`. `sandboxes.create({ fromSnapshot })` restores one on a host with the same runtime
// and, for memory state, the same `cpu.model` node label (inventory's).

/** Where snapshots are stored: presigned uploads, and the URL restores download from. */
export interface SnapshotStore {
  /** A presigned HTTPS PUT for a new snapshot object, and the URL a restoring host fetches it from. */
  presign(input: { tenantId: string; sandboxId: string; snapshotId: string }): Promise<{
    uploadUrl: string;
    uploadHeaders?: Readonly<Record<string, string>>;
    url: string;
  }>;
  /** Deletes a stored snapshot (best effort: failures are logged). */
  delete?(input: { tenantId: string; snapshotId: string; url: string }): Promise<void>;
}

/** The command kind (agent/v1 `InstanceSnapshotRequest` → `InstanceSnapshotResult`). */
export const instanceSnapshotKind: CommandKindSpec = Object.freeze({
  kind: 'instance.snapshot',
  lane: 'bulk',
  retrySafe: false,
  timeout: '1h',
  roles: ['node'],
  payload: Object.freeze({
    kind: 'message',
    typeName: 'bettercompute.agent.v1.InstanceSnapshotRequest',
  }) as MessageDescriptor,
} satisfies CommandKindSpec);

/** How long a snapshot command may wait for its host before it expires. */
export const snapshotCommandTtlMs = 60 * 60_000;

export const vpsSandboxSnapshotsMigration: Migration = {
  name: 'vps/0005_sandbox_snapshots',
  sql: `
CREATE TABLE sandbox_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  sandbox_id text NOT NULL REFERENCES sandboxes,
  template_id text NOT NULL,
  instance_id text NOT NULL,
  node_id text NOT NULL,
  runtime text NOT NULL,
  include_memory bool NOT NULL,
  -- Kept after the sandbox is deleted (still deleted with the tenant).
  keep bool NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'deleted')),
  command_id text NOT NULL,
  -- Where restores download it from (the store's URL; never shown to tenants).
  url text NOT NULL,
  sha256 text,
  size_bytes bigint,
  cpu_model text,
  reason text,
  owner_identity_id text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  ready_at timestamptz,
  version bigint NOT NULL
);
CREATE INDEX sandbox_snapshots_pending ON sandbox_snapshots (created_at) WHERE state = 'pending';
CREATE INDEX sandbox_snapshots_sandbox ON sandbox_snapshots (sandbox_id);
-- {"snapshotId", "url", "sha256", "includeMemory", "cpuModel"?}: the snapshot an instance boots from.
ALTER TABLE instances ADD COLUMN restore_from jsonb;
ALTER TABLE sandboxes ADD COLUMN from_snapshot text;
`,
};

export type SnapshotState = 'pending' | 'ready' | 'failed' | 'deleted';

export interface SandboxSnapshot {
  id: string;
  tenantId: string;
  sandboxId: string;
  templateId: string;
  state: SnapshotState;
  includeMemory: boolean;
  keep: boolean;
  runtime: string;
  sha256?: string;
  sizeBytes?: number;
  cpuModel?: string;
  reason?: string;
  createdAt: number;
  readyAt?: number;
}

export interface SnapshotSandboxInput {
  tenantId: string;
  sandboxId: string;
  /** Capture memory state too (a restorable running snapshot; default true). */
  includeMemory: boolean;
  /** Keep the snapshot after the sandbox is deleted (default false). */
  keep: boolean;
  idempotencyKey?: string;
}

export function parseSnapshotSandbox(raw: unknown): SnapshotSandboxInput {
  const input = object(raw, ['tenantId', 'sandboxId', 'includeMemory', 'keep', 'idempotencyKey']);
  for (const flag of ['includeMemory', 'keep'] as const)
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
      throw new ComputeError('INVALID_INPUT', `${flag} must be a boolean`);
  const result: SnapshotSandboxInput = {
    tenantId: tenant(input.tenantId),
    sandboxId: id(input.sandboxId, 'sbx', 'sandboxId'),
    includeMemory: input.includeMemory !== false,
    keep: input.keep === true,
  };
  const idempotencyKey = optional(input.idempotencyKey, (value) => key(value));
  if (idempotencyKey !== undefined) result.idempotencyKey = idempotencyKey;
  return result;
}

interface RawSnapshot {
  id: string;
  tenant_id: string;
  sandbox_id: string;
  template_id: string;
  instance_id: string;
  node_id: string;
  runtime: string;
  include_memory: boolean;
  keep: boolean;
  state: SnapshotState;
  command_id: string;
  url: string;
  sha256: string | null;
  size_bytes: string | number | null;
  cpu_model: string | null;
  reason: string | null;
  created_ms: number;
  ready_ms: number | null;
}

const snapshotColumnsOf = (a: string) => `${a}id, ${a}tenant_id, ${a}sandbox_id, ${a}template_id,
  ${a}instance_id, ${a}node_id, ${a}runtime, ${a}include_memory, ${a}keep, ${a}state, ${a}command_id,
  ${a}url, ${a}sha256, ${a}size_bytes, ${a}cpu_model, ${a}reason,
  (extract(epoch FROM ${a}created_at) * 1000)::float8 AS created_ms,
  (extract(epoch FROM ${a}ready_at) * 1000)::float8 AS ready_ms`;
const snapshotColumns = snapshotColumnsOf('');

function snapshotView(raw: RawSnapshot): SandboxSnapshot {
  const view: SandboxSnapshot = {
    id: raw.id,
    tenantId: raw.tenant_id,
    sandboxId: raw.sandbox_id,
    templateId: raw.template_id,
    state: raw.state,
    includeMemory: raw.include_memory,
    keep: raw.keep,
    runtime: raw.runtime,
    createdAt: Number(raw.created_ms),
  };
  if (raw.sha256 !== null) view.sha256 = raw.sha256;
  if (raw.size_bytes !== null) view.sizeBytes = Number(raw.size_bytes);
  if (raw.cpu_model !== null) view.cpuModel = raw.cpu_model;
  if (raw.reason !== null) view.reason = raw.reason;
  if (raw.ready_ms !== null) view.readyAt = Number(raw.ready_ms);
  return view;
}

/** A sandbox's snapshots, newest first. */
export async function sandboxSnapshots(tx: SqlTx, sandboxId: string): Promise<SandboxSnapshot[]> {
  const { rows } = await tx.query<RawSnapshot>(
    `SELECT ${snapshotColumns} FROM sandbox_snapshots
      WHERE sandbox_id = $1 AND state <> 'deleted' ORDER BY created_at DESC, id DESC`,
    [sandboxId],
  );
  return rows.map(snapshotView);
}

/** What a restore needs of a snapshot, checked for the restoring tenant. */
export interface RestoreSource {
  snapshotId: string;
  url: string;
  sha256: string;
  runtime: string;
  includeMemory: boolean;
  cpuModel?: string;
}

/**
 * The snapshot a `sandboxes.create({ fromSnapshot })` restores: the tenant's own and ready. Another
 * tenant's snapshot is `NOT_FOUND`, exactly like a missing one.
 */
export async function restoreSource(
  tx: SqlTx,
  tenantId: string,
  snapshotId: string,
): Promise<RestoreSource> {
  const { rows } = await tx.query<RawSnapshot>(
    `SELECT ${snapshotColumns} FROM sandbox_snapshots WHERE id = $1 AND tenant_id = $2`,
    [snapshotId, tenantId],
  );
  const raw = rows[0];
  if (!raw || raw.state === 'deleted')
    throw new ComputeError('NOT_FOUND', `Snapshot ${snapshotId} not found`);
  if (raw.state !== 'ready' || raw.sha256 === null)
    throw new ComputeError('INVALID_STATE', `Snapshot ${snapshotId} is ${raw.state}`);
  const source: RestoreSource = {
    snapshotId: raw.id,
    url: raw.url,
    sha256: raw.sha256,
    runtime: raw.runtime,
    includeMemory: raw.include_memory,
  };
  if (raw.cpu_model !== null) source.cpuModel = raw.cpu_model;
  return source;
}

/**
 * `sandboxes.snapshot`: asks the sandbox's host for its instance's state. The snapshot is `pending`
 * until the command settles (`sandbox.snapshot.ready` or `.failed`). With an idempotency key, a
 * retry returns the same snapshot.
 */
export async function snapshotSandbox(
  deps: Pick<InstanceDeps, 'clock' | 'events'>,
  store: SnapshotStore | undefined,
  context: MethodContext,
  input: SnapshotSandboxInput,
): Promise<SandboxSnapshot> {
  const tx = context.sql;
  if (!store)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Sandbox snapshots need vps({ snapshots }) to store them',
    );
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const snapshotId =
    input.idempotencyKey === undefined
      ? newId('snap')
      : await draftId('snap', input.tenantId, caller.identityId, input.idempotencyKey);
  if (input.idempotencyKey !== undefined) {
    const { rows } = await tx.query<RawSnapshot>(
      `SELECT ${snapshotColumns} FROM sandbox_snapshots WHERE id = $1 AND tenant_id = $2`,
      [snapshotId, input.tenantId],
    );
    if (rows[0]) {
      if (rows[0].sandbox_id !== input.sandboxId)
        throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
      return snapshotView(rows[0]);
    }
  }
  const { rows: sandboxes } = await tx.query<{
    id: string;
    template_id: string;
    instance_id: string;
    draft: boolean;
    deleting_at: string | null;
  }>(
    `SELECT id, template_id, instance_id, draft, deleting_at FROM sandboxes
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.sandboxId, input.tenantId],
  );
  const sandbox = sandboxes[0];
  if (!sandbox || sandbox.draft)
    throw new ComputeError('NOT_FOUND', `Sandbox ${input.sandboxId} not found`);
  if (sandbox.deleting_at !== null)
    throw new ComputeError('INVALID_STATE', `Sandbox ${sandbox.id} is being deleted`);
  const instance = await readInstance(tx, sandbox.instance_id);
  if (!instance?.nodeId || (instance.state !== 'running' && instance.state !== 'paused'))
    throw new ComputeError(
      'INVALID_STATE',
      `Sandbox ${sandbox.id} is not running (its instance is ${instance?.state ?? 'gone'})`,
    );
  const target = await store.presign({
    tenantId: input.tenantId,
    sandboxId: sandbox.id,
    snapshotId,
  });
  if (!/^https:\/\//.test(target.uploadUrl))
    throw new ComputeError('INVALID_CONFIG', 'The snapshot store must presign https upload URLs');
  const now = deps.clock.now();
  const command = await context.commands.enqueue(tx, {
    nodeId: instance.nodeId,
    kind: instanceSnapshotKind.kind,
    payload: {
      instanceId: instance.id,
      uploadUrl: target.uploadUrl,
      uploadHeaders: Object.entries(target.uploadHeaders ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
      imageId: snapshotId,
      includeMemory: input.includeMemory,
    },
    // The command sweeper and the gateway wake `vps.sandboxes` with the snapshot id when it settles.
    idempotencyKey: `vps.sandboxes:${snapshotId}:snapshot`,
    notAfter: now + snapshotCommandTtlMs,
    ...(context.traceparent ? { traceparent: context.traceparent } : {}),
  });
  const { rows } = await tx.query<RawSnapshot>(
    `INSERT INTO sandbox_snapshots (id, tenant_id, sandbox_id, template_id, instance_id, node_id, runtime,
                                    include_memory, keep, state, command_id, url, owner_identity_id,
                                    idempotency_key, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, 1)
     RETURNING ${snapshotColumns}`,
    [
      snapshotId,
      input.tenantId,
      sandbox.id,
      sandbox.template_id,
      instance.id,
      instance.nodeId,
      instance.runtime,
      input.includeMemory,
      input.keep,
      command.id,
      target.url,
      caller.identityId,
      input.idempotencyKey ?? null,
    ],
  );
  return snapshotView(rows[0]!);
}

async function publishSnapshot(
  deps: Pick<InstanceDeps, 'events'>,
  tx: SqlTx,
  raw: RawSnapshot,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: raw.tenant_id,
    subject: `sandbox/${raw.sandbox_id}`,
    data: { snapshotId: raw.id, includeMemory: raw.include_memory, ...data },
  });
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Settles pending snapshots whose command ended (all of them, or `onlyId`): a succeeded command's
 * `InstanceSnapshotResult` makes the snapshot `ready`; anything else `failed` with the command's reason.
 */
export async function settleSnapshots(
  deps: Pick<InstanceDeps, 'events' | 'clock'>,
  sql: SqlExecutor,
  options: { onlyId?: string; batch?: number } = {},
): Promise<number> {
  return sql.transaction(async (tx) => {
    const { rows } = await tx.query<
      RawSnapshot & {
        command_state: string;
        command_reason: string | null;
        result: Uint8Array | null;
      }
    >(
      `SELECT ${snapshotColumnsOf('s.')},
              c.state AS command_state, c.reason AS command_reason, c.result
         FROM sandbox_snapshots s JOIN commands c ON c.id = s.command_id
        WHERE s.state = 'pending' AND ($1::text IS NULL OR s.id = $1)
          AND c.state IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled')
        ORDER BY s.created_at, s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [options.onlyId ?? null, options.batch ?? 100],
    );
    const at = new Date(deps.clock.now()).toISOString();
    for (const raw of rows) {
      let result: ReturnType<typeof decodeMessage<typeof InstanceSnapshotResultSchema>> | undefined;
      if (raw.command_state === 'succeeded' && raw.result)
        try {
          result = decodeMessage(InstanceSnapshotResultSchema, raw.result, MAX_COMMAND_BODY_BYTES);
        } catch {
          result = undefined;
        }
      if (result && result.sha256.byteLength === 32) {
        const sha256 = hex(result.sha256);
        await tx.query(
          `UPDATE sandbox_snapshots
              SET state = 'ready', sha256 = $2, size_bytes = $3, cpu_model = $4,
                  runtime = coalesce(nullif($5, ''), runtime), ready_at = $6::timestamptz,
                  version = version + 1
            WHERE id = $1`,
          [
            raw.id,
            sha256,
            Number(result.uploadedBytes),
            raw.include_memory ? (cpuModelLabelValue(result.cpuModel) ?? null) : null,
            result.runtime,
            at,
          ],
        );
        await publishSnapshot(deps, tx, raw, 'sandbox.snapshot.ready', {
          sha256,
          sizeBytes: Number(result.uploadedBytes),
        });
      } else {
        const reason =
          raw.command_state === 'succeeded'
            ? 'bad-result'
            : (raw.command_reason ?? raw.command_state);
        await tx.query(
          `UPDATE sandbox_snapshots SET state = 'failed', reason = $2, version = version + 1 WHERE id = $1`,
          [raw.id, reason],
        );
        await publishSnapshot(deps, tx, raw, 'sandbox.snapshot.failed', { reason });
      }
    }
    return rows.length;
  });
}

/** A snapshot whose row was deleted: its stored object goes next, outside the transaction. */
export interface DroppedSnapshot {
  tenantId: string;
  snapshotId: string;
  url: string;
}

/** Marks snapshots deleted: those of `sandboxId` not kept, or every one of `tenantId` (teardown). */
export async function dropSnapshots(
  tx: SqlTx,
  scope: { sandboxId: string } | { tenantId: string },
): Promise<DroppedSnapshot[]> {
  const { rows } = await tx.query<{ id: string; tenant_id: string; url: string }>(
    'sandboxId' in scope
      ? `UPDATE sandbox_snapshots SET state = 'deleted', version = version + 1
          WHERE sandbox_id = $1 AND NOT keep AND state <> 'deleted' RETURNING id, tenant_id, url`
      : `UPDATE sandbox_snapshots SET state = 'deleted', version = version + 1
          WHERE tenant_id = $1 AND state <> 'deleted' RETURNING id, tenant_id, url`,
    ['sandboxId' in scope ? scope.sandboxId : scope.tenantId],
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, snapshotId: row.id, url: row.url }));
}

/** Deletes dropped snapshots' stored objects (never inside a transaction; failures are logged). */
export async function purgeSnapshots(
  store: SnapshotStore | undefined,
  log: Logger,
  dropped: readonly DroppedSnapshot[],
): Promise<void> {
  if (!store?.delete) return;
  for (const snapshot of dropped)
    try {
      await store.delete(snapshot);
    } catch (error) {
      log.warn('vps: could not delete a sandbox snapshot', {
        snapshotId: snapshot.snapshotId,
        error: String((error as Error)?.message ?? error),
      });
    }
}
