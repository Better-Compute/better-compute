import type { Timestamp } from '@bufbuild/protobuf/wkt';
import type { CommandState } from './gen/bettercompute/common/v1/common_pb.js';
import type {
  SecretRequest,
  WorkloadTokenRequest,
} from './gen/bettercompute/agent/v1/session_pb.js';
import { ProtocolError } from './errors.js';

/**
 * What a signature is for. Each purpose fixes its signer and its parts (see the proto comments);
 * the purpose is part of the signed bytes, so a signature never verifies for another purpose.
 */
export type SigningPurpose =
  /** Worker key; parts [Command.body]. */
  | 'command'
  /** Worker key; parts [DesiredState.body]. */
  | 'desired-state'
  /** JoinService signing key; parts [JoinResponse.body]. */
  | 'join-response'
  /** JoinService signing key; parts [SignedTrustBundle.body]. */
  | 'trust-bundle'
  /** Node key; parts [AttestedReport.body]. */
  | 'attested-report'
  /** Node key; parts [command_id, uint32_be(state), sha256(result)]. */
  | 'command-update'
  /** Node key; parts [request_id, ref, workflow_id, step_id, allocation_id, epk]. */
  | 'secret-request'
  /** Node key; parts [request_id, instance_id, audience, epk] (v0.5 workload identity). */
  | 'workload-token'
  /** Current node key; parts [sha256(csr), node_id, client_time]. */
  | 'renew-pop'
  /** Site agent node key; parts [SignedDiscoveryAssertion.body] (site/v1, draft). */
  | 'discovery-assertion'
  /** Audit signing key; parts [canonical checkpoint body]. */
  | 'audit-checkpoint'
  /** Offline release signing key; parts [canonical release manifest body]. */
  | 'release-manifest'
  /**
   * Node key of a possibly expired certificate (≤ 7 days, §6), re-joining via the x509pop attestor; parts
   * [sha256(csr), node_id, client_time]. Separate from 'renew-pop' so a relayed Renew can't be replayed as a join.
   */
  | 'x509pop';

const PREFIX = 'bettercompute.v1/';
const utf8 = new TextEncoder();

/**
 * The exact bytes an ES256 signature covers:
 * `"bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖ part)*`. Signing and verifying are the
 * caller's (pki, daemon); this package only fixes the layout.
 */
export function signingInput(purpose: SigningPurpose, parts: readonly Uint8Array[]): Uint8Array {
  const head = utf8.encode(`${PREFIX}${purpose}\0`);
  let length = head.byteLength;
  for (const part of parts) length += 4 + part.byteLength;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set(head, 0);
  let offset = head.byteLength;
  for (const part of parts) {
    if (part.byteLength > 0xffffffff)
      throw new ProtocolError('INVALID_SIGNING_INPUT', 'signing input part exceeds 4 GiB');
    view.setUint32(offset, part.byteLength);
    out.set(part, offset + 4);
    offset += 4 + part.byteLength;
  }
  return out;
}

function digest(name: string, value: Uint8Array): Uint8Array {
  if (value.byteLength !== 32)
    throw new ProtocolError('INVALID_SIGNING_INPUT', `${name} must be a 32-byte SHA-256 digest`);
  return value;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** int64_be(seconds) ‖ int32_be(nanos). */
function timestamp(value: Timestamp): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigInt64(0, value.seconds);
  view.setInt32(8, value.nanos);
  return out;
}

/**
 * Signing input of `CommandUpdate.node_sig`. `resultSha256` is SHA-256 of `CommandUpdate.result`
 * (of the empty string when there is no result); hashing stays with the caller so this package
 * needs no crypto.
 */
export const commandUpdateSigningInput = (update: {
  commandId: string;
  state: CommandState;
  resultSha256: Uint8Array;
}): Uint8Array =>
  signingInput('command-update', [
    utf8.encode(update.commandId),
    uint32(update.state),
    digest('resultSha256', update.resultSha256),
  ]);

/** Signing input of `SecretRequest.node_sig`: every field except the signature itself. */
export const secretRequestSigningInput = (
  request: Pick<
    SecretRequest,
    'requestId' | 'ref' | 'workflowId' | 'stepId' | 'allocationId' | 'epk'
  >,
): Uint8Array =>
  signingInput('secret-request', [
    utf8.encode(request.requestId),
    utf8.encode(request.ref),
    utf8.encode(request.workflowId),
    utf8.encode(request.stepId),
    utf8.encode(request.allocationId),
    request.epk,
  ]);

/** Signing input of `WorkloadTokenRequest.node_sig` (v0.5 workload identity, §12.2). */
export const workloadTokenRequestSigningInput = (
  request: Pick<WorkloadTokenRequest, 'requestId' | 'instanceId' | 'audience' | 'epk'>,
): Uint8Array =>
  signingInput('workload-token', [
    utf8.encode(request.requestId),
    utf8.encode(request.instanceId),
    utf8.encode(request.audience),
    request.epk,
  ]);

/** Signing input of `RenewRequest.pop_sig`. `csrSha256` is SHA-256 of `RenewRequest.csr`. */
export const renewPopSigningInput = (input: {
  csrSha256: Uint8Array;
  nodeId: string;
  clientTime: Timestamp;
}): Uint8Array =>
  signingInput('renew-pop', [
    digest('csrSha256', input.csrSha256),
    utf8.encode(input.nodeId),
    timestamp(input.clientTime),
  ]);
