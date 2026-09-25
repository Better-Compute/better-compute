import {
  ComputeError,
  newId,
  parseDuration,
  type AgentRole,
  type CommandBatchInput,
  type CommandKindSpec,
  type CommandQueue,
  type EnqueueCommand,
  type EventPublisher,
  type Lane,
  type Notifier,
  type RegistryView,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import {
  AgentRole as WireRole,
  CommandBodySchema,
  commandKinds as wireKinds,
  encodeMessage,
  encodeMessageJson,
  Lane as WireLane,
  MAX_COMMAND_BODY_BYTES,
  ProtocolError,
  type CommandBody,
} from '@better-compute/protocol';
import { batchSubject, commandKindAllowed } from '@better-compute/pki';
import { createCommandBatch, type QuorumConfig } from '../quorum/quorum.js';
import type { CommandSigner } from './command-signing.js';
import type { CommitHook } from './commit-hooks.js';

// The durable command queue (PLAN.md §7.4, §8.5) and the CommandSweeper. Enqueue runs in the
// caller's transaction: `seq` comes from `nodes.next_cmd_seq` (the value before the increment), the
// row starts `pending`, and an idempotency key already used on the node returns that command. The
// body is the encoded `CommandBody` the gateway sends as is (and a signature will cover from
// v0.2). After commit, the node's gateway is poked through the notifier (`gw:<gatewayId>`), best
// effort: gateways also poll every second.

/** The v0.1 kinds the server knows without a module registering them (timeouts are policy). */
const builtinTimeouts: Readonly<Record<keyof typeof wireKinds, `${number}${'s' | 'm'}`>> = {
  'diag.nvml': '2m',
  'inventory.refresh': '2m',
  'logs.collect': '15m',
  // Self-terminating: the timeout covers the rejoin window.
  'node.reboot': '15m',
  'gpu.reset': '5m',
};

const wireLanes: Readonly<Record<number, Lane>> = {
  [WireLane.CONTROL]: 'control',
  [WireLane.PROVISION]: 'provision',
  [WireLane.BULK]: 'bulk',
};
const wireRoles: Readonly<Record<number, AgentRole>> = {
  [WireRole.NODE]: 'node',
  [WireRole.SITE]: 'site',
  [WireRole.RAMDISK]: 'ramdisk',
};
const laneValues: Readonly<Record<Lane, WireLane>> = {
  control: WireLane.CONTROL,
  provision: WireLane.PROVISION,
  bulk: WireLane.BULK,
};

/** The built-in v0.1 command kinds as registry specs (protocol flags, server timeouts). */
export const builtinCommandKinds: readonly CommandKindSpec[] = Object.freeze(
  Object.entries(wireKinds).map(([kind, wire]) =>
    Object.freeze({
      kind,
      lane: wireLanes[wire.lane] ?? 'control',
      retrySafe: wire.retrySafe,
      selfTerminating: wire.selfTerminating,
      attested: wire.attested,
      destructive: wire.destructive,
      timeout: builtinTimeouts[kind as keyof typeof wireKinds],
      roles: wire.roles.map((role) => wireRoles[role]!).filter(Boolean),
      payload: wire.payload,
    } satisfies CommandKindSpec),
  ),
);
const builtinByKind = new Map(builtinCommandKinds.map((spec) => [spec.kind, spec]));

/** A kind's spec: the registry's, else the built-in one. Unknown kinds are `INVALID_CONFIG`. */
export function commandKindSpec(registry: RegistryView, kind: string): CommandKindSpec {
  const spec = registry.commandKind(kind) ?? builtinByKind.get(kind);
  if (!spec)
    throw new ComputeError('INVALID_CONFIG', `Command kind ${kind} is not registered`, undefined, {
      kind,
    });
  return spec;
}

type Descriptor = Parameters<typeof encodeMessage>[0];
type AnyMessage = NonNullable<CommandBody['payload']>;
type Timestamp = NonNullable<CommandBody['notAfter']>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The encoded payload message: a message of the kind's payload type (`$typeName` must match), the
 * proto3 JSON of one (what modules build: metal, provision steps), its encoded bytes, or nothing
 * (`undefined`, `null`, `{}`) for the type's default message. Module kinds name their type only
 * (`{ kind: 'message', typeName }`); it resolves in protocol's registry.
 */
function encodePayload(spec: CommandKindSpec, payload: unknown): Uint8Array {
  const typeName = spec.payload?.typeName;
  if (payload === undefined || payload === null) return new Uint8Array(0);
  if (payload instanceof Uint8Array) {
    if (payload.byteLength > MAX_COMMAND_BODY_BYTES)
      throw new ComputeError('INVALID_INPUT', `A ${spec.kind} payload is too large`);
    return payload;
  }
  if (!isRecord(payload))
    throw new ComputeError(
      'INVALID_INPUT',
      `${spec.kind} takes a ${typeName} message, its proto3 JSON, its encoded bytes, or nothing`,
    );
  const hasDescriptor = Array.isArray((spec.payload as { fields?: unknown }).fields);
  if (typeof payload.$typeName === 'string') {
    if (payload.$typeName !== typeName)
      throw new ComputeError(
        'INVALID_INPUT',
        `${spec.kind} takes ${typeName}, not ${payload.$typeName}`,
      );
    if (hasDescriptor)
      try {
        return encodeMessage(spec.payload as Descriptor, payload as never, MAX_COMMAND_BODY_BYTES);
      } catch (error) {
        throw new ComputeError(
          'INVALID_INPUT',
          `The ${spec.kind} payload cannot be encoded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
  }
  if (Object.keys(payload).length === 0) return new Uint8Array(0);
  if (typeof payload.$typeName === 'string')
    throw new ComputeError(
      'INVALID_CONFIG',
      `Command kind ${spec.kind} has no protobuf descriptor to encode a ${typeName} message with; pass its proto3 JSON`,
    );
  // Proto3 JSON: resolved by type name in protocol's registry.
  try {
    return encodeMessageJson(String(typeName), payload, MAX_COMMAND_BODY_BYTES);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === 'UNKNOWN_KIND')
      throw new ComputeError(
        'INVALID_CONFIG',
        `Command kind ${spec.kind} names payload type ${typeName}, which is not a better-compute message`,
      );
    throw new ComputeError(
      'INVALID_INPUT',
      `The ${spec.kind} payload is not a ${typeName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function timestamp(ms: number): Timestamp {
  const seconds = Math.floor(ms / 1000);
  return {
    $typeName: 'google.protobuf.Timestamp',
    seconds: BigInt(seconds),
    nanos: (ms - seconds * 1000) * 1_000_000,
  };
}

/** `wf:<workflowId>:<stepId>` keys carry the step the command executes. */
const workflowKey = /^wf:([^:]+):([^:]+)/;

export function encodeCommandBody(input: {
  id: string;
  nodeId: string;
  seq: number;
  spec: CommandKindSpec;
  payload: Uint8Array;
  notAfter: number;
  minGeneration?: number;
  idempotencyKey: string;
  traceparent?: string;
  /** (v1.0 quorum) The batch this command belongs to (signed with the rest of the body). */
  batchId?: string;
}): Uint8Array {
  const { spec } = input;
  const step = workflowKey.exec(input.idempotencyKey);
  const payload: AnyMessage = {
    $typeName: 'google.protobuf.Any',
    typeUrl: `type.googleapis.com/${spec.payload.typeName}`,
    value: input.payload,
  };
  const body: CommandBody = {
    $typeName: 'bettercompute.agent.v1.CommandBody',
    id: input.id,
    nodeId: input.nodeId,
    seq: BigInt(input.seq),
    kind: spec.kind,
    payload,
    lane: laneValues[spec.lane] ?? WireLane.CONTROL,
    notAfter: timestamp(input.notAfter),
    minGeneration: BigInt(input.minGeneration ?? 0),
    retrySafe: spec.retrySafe,
    idempotencyKey: input.idempotencyKey,
    traceparent: input.traceparent ?? '',
    selfTerminating: spec.selfTerminating ?? false,
    attested: spec.attested ?? false,
    workflowId: step?.[1] ?? '',
    stepId: step?.[2] ?? '',
    // (v1.0 quorum) The batch the command belongs to; the daemon then requires its approval.
    batchId: input.batchId ?? '',
  };
  try {
    return encodeMessage(CommandBodySchema, body, MAX_COMMAND_BODY_BYTES);
  } catch (error) {
    throw new ComputeError(
      'INVALID_INPUT',
      `The command cannot be encoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const keyPattern = /^[\x21-\x7e]{1,256}$/;
const traceparentPattern = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function checkCommand(command: EnqueueCommand): void {
  if (!isRecord(command)) throw new ComputeError('INVALID_INPUT', 'enqueue() takes a command');
  if (typeof command.nodeId !== 'string' || !command.nodeId)
    throw new ComputeError('INVALID_INPUT', 'A command needs a nodeId');
  if (typeof command.kind !== 'string' || !command.kind)
    throw new ComputeError('INVALID_INPUT', 'A command needs a kind');
  if (typeof command.idempotencyKey !== 'string' || !keyPattern.test(command.idempotencyKey))
    throw new ComputeError(
      'INVALID_INPUT',
      'A command idempotency key is 1-256 printable ASCII characters without spaces',
    );
  const time = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!time(command.notAfter))
    throw new ComputeError('INVALID_INPUT', 'notAfter is epoch milliseconds');
  if (command.notBefore !== undefined) {
    if (!time(command.notBefore))
      throw new ComputeError('INVALID_INPUT', 'notBefore is epoch milliseconds');
    if (command.notBefore >= command.notAfter)
      throw new ComputeError('INVALID_INPUT', 'notBefore must come before notAfter');
  }
  if (
    command.minGeneration !== undefined &&
    (!Number.isSafeInteger(command.minGeneration) || command.minGeneration < 0)
  )
    throw new ComputeError('INVALID_INPUT', 'minGeneration is a non-negative integer');
  if (command.traceparent !== undefined && !traceparentPattern.test(command.traceparent))
    throw new ComputeError('INVALID_INPUT', 'traceparent must be a W3C trace context');
}

/**
 * The message of a gateway poke (`gw:<gatewayId>`): `{"nodeIds": [...]}`, which the gateway's
 * notifier turns into `gateway.poke(nodeIds)`: dispatch now and a spec check for those nodes.
 */
export const pokeMessage = (nodeIds: readonly string[]): string =>
  JSON.stringify({ nodeIds: [...nodeIds] });

/** Best-effort wake-ups of the gateways that hold nodes' sessions, published after commit. */
export interface GatewayPokes {
  /** Pokes `gw:<gatewayId>` for `nodeId` after the current transaction commits. */
  poke(gatewayId: string | null | undefined, nodeId: string): void;
  /** Looks up the nodes' gateways in `tx` and pokes each after commit. */
  pokeNodes(tx: SqlTx, nodeIds: readonly string[]): Promise<void>;
}

export function gatewayPokes(
  notifier: Notifier | undefined,
  afterCommit: (hook: CommitHook) => void,
): GatewayPokes {
  const poke = (gatewayId: string | null | undefined, nodeId: string) => {
    if (!notifier || !gatewayId) return;
    afterCommit(() => notifier.publish(`gw:${gatewayId}`, pokeMessage([nodeId])));
  };
  return {
    poke,
    async pokeNodes(tx, nodeIds) {
      if (!notifier || !nodeIds.length) return;
      const { rows } = await tx.query<{ node_id: string; gateway_id: string }>(
        `SELECT node_id, gateway_id FROM node_sessions
          WHERE node_id = ANY($1::text[]) AND gateway_id IS NOT NULL`,
        [[...nodeIds]],
      );
      const byGateway = new Map<string, string[]>();
      for (const row of rows)
        byGateway.set(row.gateway_id, [...(byGateway.get(row.gateway_id) ?? []), row.node_id]);
      for (const [gatewayId, ids] of byGateway)
        afterCommit(() => notifier.publish(`gw:${gatewayId}`, pokeMessage(ids)));
    },
  };
}

export interface CommandQueueInput {
  registry: RegistryView;
  notifier?: Notifier;
  afterCommit(hook: CommitHook): void;
  /** Worker command signing (`createCommandSigner`); without it commands go unsigned (v0.1). */
  signer?: Pick<CommandSigner, 'sign'>;
  /** (v1.0) The trust bundle's quorum (`quorumConfigOf`); without it batches need no approvals. */
  quorum?: QuorumConfig;
  /** Business time, for batch expiry defaults. */
  now?: () => number;
}

/**
 * Checks a command's batch (§13) in `tx`: the batch belongs to the node's owner, still admits
 * commands, and names this (subject, kind) in its scope. Returns whether the command must wait for
 * the batch's approvals (a quorum is configured and the batch is not approved yet).
 */
async function batchMembership(
  tx: SqlTx,
  input: { batchId: string; nodeTenantId: string | null; subject: string; kind: string },
): Promise<{ held: boolean }> {
  const { rows } = await tx.query<{
    tenant_id: string;
    state: string;
    required: number;
    live: boolean;
    in_scope: boolean;
  }>(
    `SELECT b.tenant_id, b.state, b.required, b.not_after > compute_now() AS live,
            EXISTS (SELECT 1 FROM command_batch_scope s
                     WHERE s.batch_id = b.id AND s.subject = $2 AND s.kind = $3) AS in_scope
       FROM command_batches b WHERE b.id = $1 FOR SHARE`,
    [input.batchId, input.subject, input.kind],
  );
  const batch = rows[0];
  // Another tenant's batch reads as missing.
  if (!batch || batch.tenant_id !== input.nodeTenantId)
    throw new ComputeError('NOT_FOUND', `Batch ${input.batchId} not found`);
  if ((batch.state !== 'pending' && batch.state !== 'approved') || !batch.live)
    throw new ComputeError('INVALID_STATE', `Batch ${input.batchId} no longer admits commands`);
  if (!batch.in_scope)
    throw new ComputeError(
      'INVALID_INPUT',
      `${input.kind} on ${input.subject} is not in the scope of batch ${input.batchId}`,
    );
  return { held: Number(batch.required) > 0 && batch.state !== 'approved' };
}

/** `ctx.commands`. */
export function createCommandQueue(input: CommandQueueInput): CommandQueue {
  const { registry } = input;
  const { poke } = gatewayPokes(input.notifier, input.afterCommit);

  const existing = async (tx: SqlTx, nodeId: string, key: string) =>
    (
      await tx.query<{ id: string; seq: number | bigint; kind: string }>(
        'SELECT id, seq, kind FROM commands WHERE node_id = $1 AND idempotency_key = $2',
        [nodeId, key],
      )
    ).rows[0];

  const replay = (row: { id: string; seq: number | bigint; kind: string }, kind: string) => {
    if (row.kind !== kind)
      throw new ComputeError(
        'CONFLICT',
        'The idempotency key is already used on this node by another kind of command',
      );
    return { id: row.id, seq: Number(row.seq) };
  };

  return Object.freeze({
    async enqueue(tx: SqlTx, command: EnqueueCommand) {
      checkCommand(command);
      const spec = commandKindSpec(registry, command.kind);
      const found = await existing(tx, command.nodeId, command.idempotencyKey);
      if (found) return replay(found, command.kind);
      const payload = encodePayload(spec, command.payload);
      await checkAllowedKind(tx, command.nodeId, spec.kind);

      const bumped = await tx.query<{
        seq: number | bigint;
        gateway_id: string | null;
        owner_tenant_id: string | null;
      }>(
        `UPDATE nodes n SET next_cmd_seq = n.next_cmd_seq + 1 WHERE n.id = $1
         RETURNING n.next_cmd_seq - 1 AS seq, n.owner_tenant_id,
           (SELECT s.gateway_id FROM node_sessions s WHERE s.node_id = n.id) AS gateway_id`,
        [command.nodeId],
      );
      const node = bumped.rows[0];
      if (!node) throw new ComputeError('NOT_FOUND', `Node ${command.nodeId} does not exist`);
      const seq = Number(node.seq);
      const id = newId('cmd');
      // (v1.0 §13) A batched command: its subject is computed from the payload the agent will see.
      let batch: { id: string; subject: string; held: boolean } | undefined;
      if (command.batchId !== undefined) {
        if (typeof command.batchId !== 'string' || !command.batchId)
          throw new ComputeError('INVALID_INPUT', 'batchId must be a batch id');
        const subject = batchSubject({
          nodeId: command.nodeId,
          kind: spec.kind,
          payload: {
            $typeName: 'google.protobuf.Any',
            typeUrl: `type.googleapis.com/${spec.payload.typeName}`,
            value: payload,
          },
        });
        const { held } = await batchMembership(tx, {
          batchId: command.batchId,
          nodeTenantId: node.owner_tenant_id,
          subject,
          kind: spec.kind,
        });
        batch = { id: command.batchId, subject, held };
      }
      const body = encodeCommandBody({
        id,
        nodeId: command.nodeId,
        seq,
        spec,
        payload,
        notAfter: command.notAfter,
        ...(command.minGeneration !== undefined ? { minGeneration: command.minGeneration } : {}),
        idempotencyKey: command.idempotencyKey,
        ...(command.traceparent !== undefined ? { traceparent: command.traceparent } : {}),
        ...(batch ? { batchId: batch.id } : {}),
      });
      const inserted = await tx.query<{ id: string; seq: number | bigint }>(
        `INSERT INTO commands (id, node_id, seq, kind, body, state, not_before, not_after,
           min_generation, retry_safe, self_terminating, attested, idempotency_key, signature)
         VALUES ($1, $2, $3, $4, $5, 'pending', COALESCE($6::timestamptz, compute_now()), $7, $8,
           $9, $10, $11, $12, $13)
         ON CONFLICT (node_id, idempotency_key) DO NOTHING
         RETURNING id, seq`,
        [
          id,
          command.nodeId,
          seq,
          spec.kind,
          body,
          // Held until the batch's approval releases it (the quorum module sets not_before then).
          batch?.held ? 'infinity' : command.notBefore === undefined ? null : new Date(command.notBefore),
          new Date(command.notAfter),
          command.minGeneration ?? null,
          spec.retrySafe,
          spec.selfTerminating ?? false,
          spec.attested ?? false,
          command.idempotencyKey,
          // Signed intent (§13): every command, when a worker signer is configured; daemons require
          // it for the kinds their own table marks destructive.
          input.signer ? input.signer.sign(body) : null,
        ],
      );
      if (!inserted.rows[0]) {
        // A concurrent enqueue with the same key committed first (its seq is the one that counts).
        const winner = await existing(tx, command.nodeId, command.idempotencyKey);
        if (!winner) throw new ComputeError('CONFLICT', 'The command changed meanwhile; retry');
        return replay(winner, command.kind);
      }
      if (batch)
        await tx.query(
          `INSERT INTO command_batch_members (command_id, batch_id, subject, kind) VALUES ($1, $2, $3, $4)`,
          [id, batch.id, batch.subject, spec.kind],
        );
      if (!batch?.held) poke(node.gateway_id, command.nodeId);
      return { id, seq };
    },

    /** (v1.0 §13) A destructive-command batch: the quorum module stores its tree and proofs. */
    async createBatch(tx: SqlTx, batch: CommandBatchInput) {
      return createCommandBatch(tx, batch, {
        now: (input.now ?? Date.now)(),
        ...(input.quorum ? { quorum: input.quorum } : {}),
      });
    },

    /**
     * `pending` → `cancelled` at once. In flight (`dispatched`, `acked`, `running`), the row keeps
     * its state and gets `cancel_requested_at` (core/0004): the gateway re-sends `Cancel{id,
     * reason}` until the daemon reports a terminal state (a completed side effect stays visible,
     * §7.4). Terminal commands are left alone.
     */
    async cancel(tx: SqlTx, commandId: string) {
      if (typeof commandId !== 'string' || !commandId)
        throw new ComputeError('INVALID_INPUT', 'cancel() takes a command id');
      const { rows } = await tx.query<{
        state: string;
        node_id: string;
        gateway_id: string | null;
      }>(
        `UPDATE commands c SET
           state = CASE WHEN c.state = 'pending' THEN 'cancelled' ELSE c.state END,
           reason = CASE WHEN c.state = 'pending' THEN 'cancelled' ELSE c.reason END,
           cancel_requested_at = CASE WHEN c.state = 'pending' THEN c.cancel_requested_at
             ELSE COALESCE(c.cancel_requested_at, compute_now()) END,
           cancel_reason = CASE WHEN c.state = 'pending' THEN c.cancel_reason
             ELSE COALESCE(c.cancel_reason, 'cancelled') END,
           updated_at = compute_now()
         WHERE c.id = $1 AND c.state IN ('pending', 'dispatched', 'acked', 'running')
         RETURNING c.state, c.node_id,
           (SELECT s.gateway_id FROM node_sessions s WHERE s.node_id = c.node_id) AS gateway_id`,
        [commandId],
      );
      const row = rows[0];
      if (row) {
        if (row.state !== 'cancelled') poke(row.gateway_id, row.node_id);
        return;
      }
      const found = await tx.query('SELECT 1 FROM commands WHERE id = $1', [commandId]);
      if (!found.rowCount)
        throw new ComputeError('NOT_FOUND', `Command ${commandId} does not exist`);
    },
  } satisfies CommandQueue);
}

// --- CommandSweeper ------------------------------------------------------------------------------

/** For kinds no longer registered: how long past `not_after` an in-flight command may run. */
export const defaultCommandTimeoutMs = 15 * 60_000;

/**
 * Past `not_after`, `pending` → `expired`; past `not_after` + the kind's timeout, `dispatched`,
 * `acked` and `running` → `failed('timeout')` (for self-terminating kinds the timeout covers the
 * rejoin window). One batch of each per pass, oldest first.
 */
const sweepCommands = `WITH expired AS (
    UPDATE commands SET state = 'expired', reason = 'not_after', updated_at = compute_now()
     WHERE id IN (SELECT id FROM commands
                   WHERE state = 'pending' AND not_after <= compute_now()
                   ORDER BY not_after, id LIMIT $4 FOR UPDATE SKIP LOCKED)
    RETURNING id, node_id, kind, state, reason, idempotency_key),
  timed_out AS (
    UPDATE commands SET state = 'failed', reason = 'timeout', updated_at = compute_now()
     WHERE id IN (SELECT c.id FROM commands c
                   WHERE c.state IN ('dispatched', 'acked', 'running') AND c.not_after <= compute_now()
                     AND c.not_after + make_interval(secs => COALESCE(
                           (SELECT k.timeout_s FROM unnest($1::text[], $2::float8[]) AS k(kind, timeout_s)
                             WHERE k.kind = c.kind), $3::float8)) <= compute_now()
                   ORDER BY c.not_after, c.id LIMIT $4 FOR UPDATE SKIP LOCKED)
    RETURNING id, node_id, kind, state, reason, idempotency_key)
  SELECT s.*, n.owner_tenant_id FROM (SELECT * FROM expired UNION ALL SELECT * FROM timed_out) s
    LEFT JOIN nodes n ON n.id = s.node_id
   ORDER BY s.id`;

export interface SweptCommand {
  id: string;
  nodeId: string;
  kind: string;
  state: 'expired' | 'failed';
  reason: string;
  idempotencyKey: string;
}

/** The work item that owns a command, besides its node: `wf:<id>:…` → `workflow/<id>`. */
export function commandOwner(
  idempotencyKey: string,
  registered: (kind: string) => boolean,
): { kind: string; key: string } | undefined {
  const [prefix, key] = idempotencyKey.split(':');
  if (!prefix || !key) return undefined;
  const kind = prefix === 'wf' ? 'workflow' : prefix;
  return registered(kind) && kind !== 'node' ? { kind, key } : undefined;
}

export interface SweepInput {
  kinds: readonly CommandKindSpec[];
  batchSize: number;
  work: WorkQueue;
  events: EventPublisher;
  /** Whether a reconciler of this name is registered. */
  registered(kind: string): boolean;
}

/**
 * One CommandSweeper pass in `tx` (fenced by the caller). Each transition wakes the node's
 * controller (`work_queue('node', nodeId)`, as the gateway does when a command settles), the
 * reconciler named by the idempotency key's prefix when one is registered (`wf:` → `workflow`,
 * keyed by the workflow id and by the node, `<reconciler>:<key>:…`), and publishes
 * `command.settled` in the node owner's tenant.
 */
export async function sweepCommandsOnce(tx: SqlTx, input: SweepInput): Promise<SweptCommand[]> {
  const kinds = input.kinds.map((spec) => spec.kind);
  const timeouts = input.kinds.map((spec) => {
    try {
      return parseDuration(spec.timeout) / 1000;
    } catch {
      return defaultCommandTimeoutMs / 1000;
    }
  });
  const { rows } = await tx.query<{
    id: string;
    node_id: string;
    kind: string;
    state: 'expired' | 'failed';
    reason: string;
    idempotency_key: string;
    owner_tenant_id: string | null;
  }>(sweepCommands, [kinds, timeouts, defaultCommandTimeoutMs / 1000, input.batchSize]);
  const swept: SweptCommand[] = [];
  // Each key once per pass, by kind; events in row order. Written set-based below.
  const wakes = new Map<string, Set<string>>();
  const wake = (kind: string, key: string) => {
    let keys = wakes.get(kind);
    if (!keys) wakes.set(kind, (keys = new Set()));
    keys.add(key);
  };
  const settled: Parameters<EventPublisher['publish']>[1][] = [];
  for (const row of rows) {
    swept.push({
      id: row.id,
      nodeId: row.node_id,
      kind: row.kind,
      state: row.state,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
    });
    wake('node', row.node_id);
    const owner = commandOwner(row.idempotency_key, input.registered);
    if (owner) wake(owner.kind, owner.key);
    // Node workflows are keyed by their node (provision's `work_key`), only node-less ones by the
    // workflow id: wake both, so the step fails now rather than at the engine's next poll.
    if (owner?.kind === 'workflow') wake('workflow', row.node_id);
    if (row.owner_tenant_id)
      settled.push({
        type: 'command.settled',
        tenantId: row.owner_tenant_id,
        subject: `command/${row.id}`,
        data: {
          commandId: row.id,
          nodeId: row.node_id,
          kind: row.kind,
          state: row.state,
          reason: row.reason,
        },
      });
  }
  for (const [kind, keys] of wakes) await enqueueAll(input.work, tx, kind, [...keys]);
  await publishAll(input.events, tx, settled);
  return swept;
}

/**
 * A restricted identity (`node_certs.allowed_kinds` of the node's current certificate: a
 * discovery ramdisk) refuses kinds outside its set up front, with the same matcher the gateway's
 * dispatch uses (`commandKindAllowed`), so a caller learns at enqueue instead of seeing the command
 * cancelled `kind-not-allowed` later. No current certificate, or an unrestricted one, allows all:
 * the gateway still checks the session's certificate at dispatch.
 */
async function checkAllowedKind(tx: SqlTx, nodeId: string, kind: string): Promise<void> {
  const { rows } = await tx.query<{ allowed_kinds: string[] | null }>(
    `SELECT c.allowed_kinds FROM node_certs c JOIN nodes n ON n.id = c.node_id
      WHERE c.node_id = $1 AND c.revoked_at IS NULL AND c.identity_gen = n.identity_gen
        AND c.not_after > compute_now()
      ORDER BY c.not_after DESC LIMIT 1`,
    [nodeId],
  );
  const allowed = rows[0]?.allowed_kinds ?? null;
  if (!commandKindAllowed(kind, allowed))
    throw new ComputeError(
      'INVALID_STATE',
      `Node ${nodeId} runs a restricted identity that does not accept ${kind} commands`,
      undefined,
      { kind, allowedKinds: allowed },
    );
}

/** `work.enqueueMany` when the port has it, else one `enqueue` per key. */
export async function enqueueAll(
  work: WorkQueue,
  tx: SqlTx,
  kind: string,
  keys: readonly string[],
): Promise<void> {
  if (!keys.length) return;
  if (work.enqueueMany) return work.enqueueMany(tx, kind, keys);
  for (const key of keys) await work.enqueue(tx, kind, key);
}

/** `events.publishMany` when the port has it, else one `publish` per event, in order. */
export async function publishAll(
  events: EventPublisher,
  tx: SqlTx,
  list: readonly Parameters<EventPublisher['publish']>[1][],
): Promise<void> {
  if (!list.length) return;
  if (events.publishMany) return events.publishMany(tx, list);
  for (const event of list) await events.publish(tx, event);
}
