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
  | 'x509pop'
  /**
   * Operator approver key (v1.0 quorum, §13); parts [batch_id, scope_root,
   * uint32_be(scope_size), timestamp(not_after), trust_domain].
   */
  | 'batch-approval'
  /**
   * Operator approver key of the CURRENT set (v1.0 quorum, §13): a change of the trust bundle's
   * quorum fields; parts [uint64_be(approver_set_epoch), sha256(approverSetInput(...)), trust_domain].
   */
  | 'approver-set';

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

/**
 * Signing input of a `BatchApproval` signature: what k operators approve (v1.0 quorum, §13). The
 * trust domain binds it to one deployment: every verifier supplies its own.
 */
export const batchApprovalSigningInput = (approval: {
  batchId: string;
  scopeRoot: Uint8Array;
  scopeSize: number;
  notAfter: Timestamp;
  trustDomain: string;
}): Uint8Array => {
  if (!approval.trustDomain)
    throw new ProtocolError('INVALID_SIGNING_INPUT', 'a batch approval names its trust domain');
  return signingInput('batch-approval', [
    utf8.encode(approval.batchId),
    digest('scopeRoot', approval.scopeRoot),
    uint32(approval.scopeSize),
    timestamp(approval.notAfter),
    utf8.encode(approval.trustDomain),
  ]);
};

/** The quorum fields of a TrustBundle (3-6), as `approverSetInput` canonicalizes them. */
export interface ApproverSetFields {
  approverKeys: readonly { kid: string; spkiDer: Uint8Array }[];
  approverThreshold: number;
  quorumTiers: readonly { maxScopeSize: number; threshold: number }[];
  unbatchedDestructivePerHour: number;
}

/**
 * The canonical bytes of a trust bundle's quorum fields (hashed with SHA-256 by the caller for the
 * "approver-set" signature):
 * `uint32(n) ‖ (lp(kid) ‖ lp(spki_der))* by kid ascending ‖ uint32(threshold) ‖ uint32(m) ‖
 * (uint32(max_scope_size) ‖ uint32(threshold))* in order ‖ uint32(unbatched_destructive_per_hour)`.
 */
export function approverSetInput(fields: ApproverSetFields): Uint8Array {
  const keys = [...fields.approverKeys].sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
  const chunks: Uint8Array[] = [uint32(keys.length)];
  for (const key of keys)
    chunks.push(lengthPrefixed(utf8.encode(key.kid)), lengthPrefixed(key.spkiDer));
  chunks.push(uint32(fields.approverThreshold), uint32(fields.quorumTiers.length));
  for (const tier of fields.quorumTiers)
    chunks.push(uint32(tier.maxScopeSize), uint32(tier.threshold));
  chunks.push(uint32(fields.unbatchedDestructivePerHour));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Signing input of an `approver_set_signatures` entry: the set's epoch (TrustBundle.approver_set_epoch), its digest
 * and the deployment's trust domain (each verifier supplies its own), so a set signed for one deployment (staging)
 * never changes the quorum of another (prod) that shares approver keys, and an older set is never taken back.
 */
export const approverSetSigningInput = (input: {
  epoch: bigint;
  setSha256: Uint8Array;
  trustDomain: string;
}): Uint8Array => {
  if (!input.trustDomain) throw new Error('An approver-set signature names its trust domain');
  const epoch = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(0, input.epoch);
  return signingInput('approver-set', [epoch, digest('setSha256', input.setSha256), utf8.encode(input.trustDomain)]);
};

/** `uint32_be(len) ‖ bytes`. */
function lengthPrefixed(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.byteLength);
  new DataView(out.buffer).setUint32(0, value.byteLength);
  out.set(value, 4);
  return out;
}

/**
 * The bytes a batch scope leaf hashes (SHA-256 by the caller): `0x00 ‖ lp(batch_id) ‖ lp(subject)
 * ‖ lp(kind) ‖ lp(payload_sha256)`. Leaves are ordered by their hash; see `BatchApproval` in
 * session.proto. `subject` is what the command acts on: the node id for kinds a node runs on
 * itself, `bmc:<site agent node id>/<address>` for site-relayed BMC kinds, `node:<target_node_id>`
 * for `site.httpProxy`. `payloadSha256` is SHA-256 of the payload's value (32 bytes), or empty for
 * "any payload of this kind".
 */
export function batchLeafInput(
  batchId: string,
  subject: string,
  kind: string,
  payloadSha256: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (payloadSha256.byteLength !== 0 && payloadSha256.byteLength !== 32)
    throw new ProtocolError('INVALID_SIGNING_INPUT', 'payloadSha256 is 32 bytes or empty');
  const parts = [
    ...[batchId, subject, kind].map((part) => lengthPrefixed(utf8.encode(part))),
    lengthPrefixed(payloadSha256),
  ];
  const out = new Uint8Array(1 + parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 1; // out[0] = 0x00, the leaf tag
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The bytes an inner node of the batch scope tree hashes: `0x01 ‖ left ‖ right`. */
export function batchNodeInput(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x01;
  out.set(digest('left', left), 1);
  out.set(digest('right', right), 33);
  return out;
}

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
