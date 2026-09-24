import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { DescMessage, MessageInitShape, MessageShape } from '@bufbuild/protobuf';
import type { SignatureSchema } from './gen/bettercompute/common/v1/common_pb.js';
import {
  AgentFrameSchema,
  AttestedReportBodySchema,
  AttestedReportSchema,
  CommandBodySchema,
  CommandSchema,
  DesiredStateBodySchema,
  DesiredStateSchema,
  JoinResponseBodySchema,
  ServerFrameSchema,
} from './gen/bettercompute/agent/v1/session_pb.js';
import type {
  AgentFrame,
  AttestedReport,
  AttestedReportBody,
  Command,
  CommandBody,
  DesiredState,
  DesiredStateBody,
  JoinResponse,
  JoinResponseBody,
  ServerFrame,
} from './gen/bettercompute/agent/v1/session_pb.js';
import { ProtocolError } from './errors.js';

/** A Signature message or its plain-object form. */
type SignatureInit = MessageInitShape<typeof SignatureSchema>;

const MiB = 1024 * 1024;

/** Upper bound of a serialized CommandBody (PLAN.md §6: 1 MiB per command). */
export const MAX_COMMAND_BODY_BYTES = 1 * MiB;
/** Upper bound of a serialized DesiredStateBody (PLAN.md §6: 4 MiB per spec). */
export const MAX_SPEC_BODY_BYTES = 4 * MiB;
/**
 * Upper bound of one Session or Tunnel frame: the largest body plus envelope, signature and
 * certificate-chain headroom. Gateways and daemons set their gRPC receive limit to it.
 */
export const MAX_FRAME_BYTES = 5 * MiB;

/** `toBinary` with a size bound. Throws `ProtocolError('FRAME_TOO_LARGE')`. */
export function encodeMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  maxBytes = MAX_FRAME_BYTES,
): Uint8Array {
  const bytes = toBinary(schema, message);
  if (bytes.byteLength > maxBytes)
    throw new ProtocolError(
      'FRAME_TOO_LARGE',
      `${schema.typeName} is ${bytes.byteLength} bytes; the limit is ${maxBytes}`,
    );
  return bytes;
}

/**
 * `fromBinary` with a size bound checked before parsing. Unknown fields are kept, so a relay
 * re-encoding a newer peer's message loses nothing. Throws `ProtocolError('FRAME_TOO_LARGE' |
 * 'INVALID_FRAME')`.
 */
export function decodeMessage<Desc extends DescMessage>(
  schema: Desc,
  bytes: Uint8Array,
  maxBytes = MAX_FRAME_BYTES,
): MessageShape<Desc> {
  if (bytes.byteLength > maxBytes)
    throw new ProtocolError(
      'FRAME_TOO_LARGE',
      `${schema.typeName} is ${bytes.byteLength} bytes; the limit is ${maxBytes}`,
    );
  try {
    return fromBinary(schema, bytes);
  } catch (error) {
    throw new ProtocolError(
      'INVALID_FRAME',
      `cannot decode ${schema.typeName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Serialize a daemon → gateway frame. */
export const encodeAgentFrame = (frame: AgentFrame): Uint8Array =>
  encodeMessage(AgentFrameSchema, frame);
/** Parse a daemon → gateway frame. */
export const decodeAgentFrame = (bytes: Uint8Array): AgentFrame =>
  decodeMessage(AgentFrameSchema, bytes);
/** Serialize a gateway → daemon frame. */
export const encodeServerFrame = (frame: ServerFrame): Uint8Array =>
  encodeMessage(ServerFrameSchema, frame);
/** Parse a gateway → daemon frame. */
export const decodeServerFrame = (bytes: Uint8Array): ServerFrame =>
  decodeMessage(ServerFrameSchema, bytes);

/**
 * Put a CommandBody into its signed envelope. The body is serialized once; the control plane
 * stores and resends exactly these bytes, which are also what a signature covers
 * (`signingInput('command', [command.body])`).
 */
export function wrapCommand(
  body: CommandBody,
  options: { signature?: SignatureInit; attempt?: number } = {},
): Command {
  return create(CommandSchema, {
    body: encodeMessage(CommandBodySchema, body, MAX_COMMAND_BODY_BYTES),
    signature: options.signature,
    attempt: options.attempt ?? 1,
  });
}

/** Decode a Command's body. Verify `command.signature` over `command.body` first where required. */
export const unwrapCommand = (command: Command): CommandBody =>
  decodeMessage(CommandBodySchema, command.body, MAX_COMMAND_BODY_BYTES);

/** Put a DesiredStateBody into its signed envelope (`signingInput('desired-state', [body])`). */
export function wrapDesiredState(
  body: DesiredStateBody,
  options: { signature?: SignatureInit } = {},
): DesiredState {
  return create(DesiredStateSchema, {
    body: encodeMessage(DesiredStateBodySchema, body, MAX_SPEC_BODY_BYTES),
    signature: options.signature,
  });
}

/** Decode a DesiredState's body. */
export const unwrapDesiredState = (state: DesiredState): DesiredStateBody =>
  decodeMessage(DesiredStateBodySchema, state.body, MAX_SPEC_BODY_BYTES);

/** Put an AttestedReportBody into its envelope (`signingInput('attested-report', [body])`). */
export function wrapAttestedReport(
  body: AttestedReportBody,
  options: { nodeSig?: SignatureInit } = {},
): AttestedReport {
  return create(AttestedReportSchema, {
    body: encodeMessage(AttestedReportBodySchema, body),
    nodeSig: options.nodeSig,
  });
}

/** Decode an AttestedReport's body. Workers verify `node_sig` first from v0.2. */
export const unwrapAttestedReport = (report: AttestedReport): AttestedReportBody =>
  decodeMessage(AttestedReportBodySchema, report.body);

/** Decode a JoinResponse's body. The daemon verifies `sig` with the pinned join-signing key first. */
export const unwrapJoinResponse = (response: JoinResponse): JoinResponseBody =>
  decodeMessage(JoinResponseBodySchema, response.body);
