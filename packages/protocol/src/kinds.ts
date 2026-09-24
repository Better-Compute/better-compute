import { anyIs, anyPack } from '@bufbuild/protobuf/wkt';
import type { Any } from '@bufbuild/protobuf/wkt';
import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { AgentRole, Lane } from './gen/bettercompute/common/v1/common_pb.js';
import {
  DiagNvmlRequestSchema,
  DiagNvmlResultSchema,
  GpuResetRequestSchema,
  GpuResetResultSchema,
  InventoryRefreshRequestSchema,
  InventoryRefreshResultSchema,
  LogsCollectRequestSchema,
  LogsCollectResultSchema,
  NodeRebootRequestSchema,
  NodeRebootResultSchema,
} from './gen/bettercompute/agent/v1/commands_pb.js';
import { ProtocolError } from './errors.js';
import { decodeMessage, encodeMessage, MAX_COMMAND_BODY_BYTES } from './frames.js';

/**
 * The wire-level description of a command kind: its messages and the flags `CommandBody` carries
 * (PLAN.md §7.4 kind registry). Timeouts are control-plane policy and live in the module that
 * registers the kind.
 */
export interface CommandKindSpec<
  Payload extends DescMessage = DescMessage,
  Result extends DescMessage = DescMessage,
> {
  /** Request message, packed into `CommandBody.payload`. */
  payload: Payload;
  /** Result message, serialized into `CommandUpdate.result`. */
  result: Result;
  lane: Lane;
  /** May run again after `accepted` without `running` (crash before the side effect). */
  retrySafe: boolean;
  /** The side effect ends the daemon process; completes on restart or rejoin. */
  selfTerminating: boolean;
  /** The result is node-signed (`CommandUpdate.node_sig`, verified from v0.2). */
  attested: boolean;
  /** Requires a valid `Command.signature` from v0.2 (`BAD_SIGNATURE` otherwise). */
  destructive: boolean;
  /** Agent roles allowed to run it; any other role rejects it `UNSUPPORTED`. */
  roles: readonly AgentRole[];
}

/** The built-in v0.1 command kinds. The daemon's dispatcher carries the same table. */
export const commandKinds = {
  'diag.nvml': {
    payload: DiagNvmlRequestSchema,
    result: DiagNvmlResultSchema,
    lane: Lane.CONTROL,
    retrySafe: true,
    selfTerminating: false,
    attested: true,
    destructive: false,
    roles: [AgentRole.NODE, AgentRole.RAMDISK],
  },
  'inventory.refresh': {
    payload: InventoryRefreshRequestSchema,
    result: InventoryRefreshResultSchema,
    lane: Lane.CONTROL,
    retrySafe: true,
    selfTerminating: false,
    attested: false,
    destructive: false,
    roles: [AgentRole.NODE, AgentRole.SITE, AgentRole.RAMDISK],
  },
  'logs.collect': {
    payload: LogsCollectRequestSchema,
    result: LogsCollectResultSchema,
    lane: Lane.BULK,
    retrySafe: true,
    selfTerminating: false,
    attested: false,
    destructive: false,
    roles: [AgentRole.NODE, AgentRole.SITE, AgentRole.RAMDISK],
  },
  'node.reboot': {
    payload: NodeRebootRequestSchema,
    result: NodeRebootResultSchema,
    lane: Lane.CONTROL,
    retrySafe: true,
    selfTerminating: true,
    attested: false,
    destructive: true,
    roles: [AgentRole.NODE, AgentRole.SITE],
  },
  'gpu.reset': {
    payload: GpuResetRequestSchema,
    result: GpuResetResultSchema,
    lane: Lane.CONTROL,
    retrySafe: false,
    selfTerminating: false,
    attested: true,
    destructive: true,
    roles: [AgentRole.NODE],
  },
} as const satisfies Record<string, CommandKindSpec>;

/** A built-in command kind name. */
export type CommandKind = keyof typeof commandKinds;
/** The request message of a built-in kind. */
export type CommandPayload<K extends CommandKind> = MessageShape<
  (typeof commandKinds)[K]['payload']
>;
/** The result message of a built-in kind. */
export type CommandResult<K extends CommandKind> = MessageShape<(typeof commandKinds)[K]['result']>;

/** Whether `kind` is a built-in kind (own properties only). */
export const isCommandKind = (kind: string): kind is CommandKind =>
  Object.hasOwn(commandKinds, kind);

function specOf(kind: string): CommandKindSpec {
  if (!isCommandKind(kind)) throw new ProtocolError('UNKNOWN_KIND', `unknown command kind ${kind}`);
  return commandKinds[kind];
}

/** Pack a built-in kind's request for `CommandBody.payload`. */
export function packCommandPayload<K extends CommandKind>(
  kind: K,
  payload: CommandPayload<K>,
): Any {
  const { payload: schema } = specOf(kind);
  if (payload.$typeName !== schema.typeName)
    throw new ProtocolError(
      'PAYLOAD_MISMATCH',
      `${kind} takes ${schema.typeName}, not ${payload.$typeName}`,
    );
  return anyPack(schema, payload);
}

/** Unpack `CommandBody.payload` for a built-in kind; the Any must hold the kind's request type. */
export function unpackCommandPayload<K extends CommandKind>(
  kind: K,
  any: Any | undefined,
): CommandPayload<K> {
  const { payload: schema } = specOf(kind);
  if (!any || !anyIs(any, schema))
    throw new ProtocolError('PAYLOAD_MISMATCH', `${kind} payload is ${any?.typeUrl || 'empty'}`);
  return decodeMessage(schema, any.value, MAX_COMMAND_BODY_BYTES) as CommandPayload<K>;
}

/** Serialize a built-in kind's result for `CommandUpdate.result`. */
export function encodeCommandResult<K extends CommandKind>(
  kind: K,
  result: CommandResult<K>,
): Uint8Array {
  const { result: schema } = specOf(kind);
  if (result.$typeName !== schema.typeName)
    throw new ProtocolError(
      'PAYLOAD_MISMATCH',
      `${kind} returns ${schema.typeName}, not ${result.$typeName}`,
    );
  return encodeMessage(schema, result, MAX_COMMAND_BODY_BYTES);
}

/** Parse `CommandUpdate.result` of a built-in kind. */
export function decodeCommandResult<K extends CommandKind>(
  kind: K,
  bytes: Uint8Array,
): CommandResult<K> {
  return decodeMessage(specOf(kind).result, bytes, MAX_COMMAND_BODY_BYTES) as CommandResult<K>;
}
