import {
  ComputeError,
  commandStates,
  defineMethod,
  type CommandState,
  type Json,
  type MethodDefinition,
} from '@better-compute/core';
import type { CommandPayload } from '@better-compute/protocol';
import {
  derivedId,
  fields,
  int,
  keyReused,
  limit,
  ms,
  notFound,
  page,
  visibleIn,
  type Page,
} from './common.js';
import { check, parser, v, type Schema } from './input.js';

// `commands` (PLAN.md §7.3-7.4, §9.2, module server): one-shot actions on a node, queued in the
// caller's transaction through the command queue. v0.1 runs an allowlist of kinds; anything else is
// `UNSUPPORTED` (P11). Every method is decided on `compute-node/{nodeId}`.

/** The command kinds `commands.run` accepts in v0.1, and the payload each takes. */
const payloads = {
  'diag.nvml': v.object({}),
  'inventory.refresh': v.object({
    sections: v.optional(
      v.list(v.option(['system', 'cpu', 'memory', 'disks', 'nics', 'gpus', 'bmc', 'os']), {
        min: 1,
        max: 8,
        unique: true,
      }),
    ),
    /** Re-collect from the hardware first instead of resending the last collection. */
    rescan: v.optional(v.boolean()),
  }),
  'logs.collect': v.object({
    /** How far back to collect, in seconds (default: the daemon's choice). */
    sinceSeconds: v.optional(v.int({ min: 60, max: 604_800 })),
    /** systemd units to include (default: bcd's own). */
    units: v.optional(
      v.list(v.string({ pattern: /^[A-Za-z0-9@._:-]{1,128}$/, max: 128 }), {
        max: 16,
        unique: true,
      }),
    ),
  }),
  'node.reboot': v.object({}),
} satisfies Record<string, Schema<unknown>>;

export type RunnableCommandKind = keyof typeof payloads;
/** The v0.1 allowlist of `commands.run` (§9.2); `diag.dcgm` joins in v0.2. */
export const runnableCommandKinds = Object.freeze(
  Object.keys(payloads),
) as readonly RunnableCommandKind[];

export interface RunCommandInput {
  tenantId: string;
  nodeId: string;
  kind: RunnableCommandKind;
  payload?: Record<string, Json>;
  /** Scoped to (tenant, caller identity): a retry returns the command already queued. */
  idempotencyKey: string;
  /** How long the command may wait for the node before it expires (default 600, at most 3600). */
  notAfterSeconds?: number;
}
export interface GetCommandInput {
  tenantId: string;
  nodeId: string;
  commandId: string;
}
export interface ListCommandsInput {
  tenantId: string;
  nodeId: string;
  state?: CommandState;
  /** At most 200 (100 by default). */
  limit?: number;
  cursor?: string;
}

/** A command as the API shows it (newest first in lists). */
export interface CommandInfo {
  id: string;
  nodeId: string;
  seq: number;
  kind: string;
  state: CommandState;
  reason?: string;
  notBefore: number;
  notAfter: number;
  minGeneration?: number;
  retrySafe: boolean;
  selfTerminating: boolean;
  attested: boolean;
}

export type CommandsApi = {
  commands: {
    run: MethodDefinition<RunCommandInput, CommandInfo>;
    get: MethodDefinition<GetCommandInput, CommandInfo>;
    list: MethodDefinition<ListCommandsInput, Page<CommandInfo>>;
  };
};

const parseRun = parser({
  tenantId: fields.tenantId,
  nodeId: fields.nodeId,
  kind: v.string({ pattern: /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, max: 64 }),
  payload: v.optional(v.anyObject()),
  idempotencyKey: fields.idempotencyKey,
  notAfterSeconds: v.withDefault(v.int({ min: 10, max: 3600 }), 600),
});
function runInput(input: unknown): RunCommandInput {
  const parsed = parseRun(input);
  if (!Object.hasOwn(payloads, parsed.kind))
    throw new ComputeError(
      'UNSUPPORTED',
      `Command kind ${parsed.kind} cannot be run through the API; use one of ${runnableCommandKinds.join(', ')}`,
    );
  const kind = parsed.kind as RunnableCommandKind;
  const payload = check(payloads[kind] as Schema<Record<string, Json>>, parsed.payload ?? {}, [
    'payload',
  ]);
  return { ...parsed, kind, payload };
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The kind's request message for a validated API payload, every field set as `create()` would set
 * it, so the command queue can encode it into `CommandBody.payload`.
 */
function requestMessage(input: RunCommandInput): CommandPayload<RunnableCommandKind> {
  const payload: Record<string, unknown> = input.payload ?? {};
  switch (input.kind) {
    case 'diag.nvml':
      // Every visible GPU, no expected count: acceptance sets both; an operator run checks health.
      return {
        $typeName: 'bettercompute.agent.v1.DiagNvmlRequest',
        gpuUuids: [],
        expectedGpuCount: 0,
      };
    case 'inventory.refresh':
      return {
        $typeName: 'bettercompute.agent.v1.InventoryRefreshRequest',
        sections: strings(payload.sections),
        rescan: payload.rescan === true,
      };
    case 'logs.collect':
      // The upload destination (a presigned URL from the downloads BlobStore) is v0.2's.
      return {
        $typeName: 'bettercompute.agent.v1.LogsCollectRequest',
        uploadUrl: '',
        uploadHeaders: [],
        units: strings(payload.units),
        lookbackSeconds: typeof payload.sinceSeconds === 'number' ? payload.sinceSeconds : 0,
        maxBytes: 0n,
        supportBundle: false,
      };
    case 'node.reboot':
      return {
        $typeName: 'bettercompute.agent.v1.NodeRebootRequest',
        reason: 'commands.run',
        delayMs: 0,
      };
  }
}

const getInput: (input: unknown) => GetCommandInput = parser({
  tenantId: fields.tenantId,
  nodeId: fields.nodeId,
  commandId: fields.commandId,
});
const listInput: (input: unknown) => ListCommandsInput = parser({
  tenantId: fields.tenantId,
  nodeId: fields.nodeId,
  state: v.optional(v.option(commandStates)),
  limit: limit(200, 100),
  cursor: v.optional(v.string({ pattern: /^\d{1,19}$/, max: 19 })),
});

interface CommandRow {
  id: string;
  node_id: string;
  seq: unknown;
  kind: string;
  state: CommandState;
  reason: string | null;
  not_before: Date;
  not_after: Date;
  min_generation: unknown;
  retry_safe: boolean;
  self_terminating: boolean;
  attested: boolean;
}
const columns = `c.id, c.node_id, c.seq, c.kind, c.state, c.reason, c.not_before, c.not_after,
  c.min_generation, c.retry_safe, c.self_terminating, c.attested`;

function toCommand(row: CommandRow): CommandInfo {
  const command: CommandInfo = {
    id: row.id,
    nodeId: row.node_id,
    seq: int(row.seq),
    kind: row.kind,
    state: row.state,
    notBefore: ms(row.not_before)!,
    notAfter: ms(row.not_after)!,
    retrySafe: row.retry_safe,
    selfTerminating: row.self_terminating,
    attested: row.attested,
  };
  if (row.reason !== null) command.reason = row.reason;
  if (row.min_generation !== null && row.min_generation !== undefined)
    command.minGeneration = int(row.min_generation);
  return command;
}

const nodeVisible = visibleIn('node', 'c.node_id', '$1');

export function commandsApi(): CommandsApi {
  return {
    commands: {
      run: defineMethod<RunCommandInput, CommandInfo>({
        action: 'compute:nodes:exec',
        kind: 'mutation',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: runInput,
        async handler(context, input) {
          const { rows: nodes } = await context.sql.query(
            `SELECT n.id FROM nodes n WHERE n.id = $2 AND ${visibleIn('node', 'n.id', '$1')}
             FOR SHARE OF n`,
            [input.tenantId, input.nodeId],
          );
          if (!nodes[0]) throw notFound('Node');
          // The queue's key is per node; derive it from (tenant, identity, key) so two callers'
          // keys never collide and a retry finds its own command.
          const derived = await derivedId('cmd', input.tenantId, context, input.idempotencyKey);
          const idempotencyKey = `api:${derived.slice('cmd_'.length)}`;
          const { rows: existing } = await context.sql.query<{ kind: string }>(
            'SELECT kind FROM commands WHERE node_id = $1 AND idempotency_key = $2',
            [input.nodeId, idempotencyKey],
          );
          if (existing[0] && existing[0].kind !== input.kind) throw keyReused();
          const { id } = await context.commands.enqueue(context.sql, {
            nodeId: input.nodeId,
            kind: input.kind,
            payload: requestMessage(input),
            idempotencyKey,
            notAfter: context.clock.now() + (input.notAfterSeconds ?? 600) * 1000,
          });
          const { rows } = await context.sql.query<CommandRow>(
            `SELECT ${columns} FROM commands c WHERE c.id = $1`,
            [id],
          );
          if (!rows[0]) throw new ComputeError('INTERNAL_ERROR', 'The queued command is missing');
          const command = toCommand(rows[0]);
          if (!existing[0])
            await context.events.publish(context.sql, {
              type: 'node.command.queued',
              tenantId: input.tenantId,
              subject: `node/${input.nodeId}`,
              data: { nodeId: input.nodeId, commandId: command.id, kind: command.kind },
            });
          return command;
        },
      }),
      get: defineMethod<GetCommandInput, CommandInfo>({
        action: 'compute:nodes:read',
        kind: 'read',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: getInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<CommandRow>(
            `SELECT ${columns} FROM commands c
             WHERE c.id = $3 AND c.node_id = $2 AND ${nodeVisible}`,
            [input.tenantId, input.nodeId, input.commandId],
          );
          if (!rows[0]) throw notFound('Command');
          return toCommand(rows[0]);
        },
      }),
      list: defineMethod<ListCommandsInput, Page<CommandInfo>>({
        action: 'compute:nodes:read',
        kind: 'read',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 100;
          const { rows } = await context.sql.query<CommandRow>(
            `SELECT ${columns} FROM commands c
             WHERE c.node_id = $2 AND ${nodeVisible}
               AND ($3::text IS NULL OR c.state = $3) AND ($4::bigint IS NULL OR c.seq < $4)
             ORDER BY c.seq DESC LIMIT $5`,
            [input.tenantId, input.nodeId, input.state ?? null, input.cursor ?? null, size + 1],
          );
          return page(rows, size, toCommand, (row) => String(int(row.seq)));
        },
      }),
    },
  };
}
