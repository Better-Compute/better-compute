import { createHash, type KeyObject } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { anyUnpack, timestampFromMs, timestampMs, type Any } from '@bufbuild/protobuf/wkt';
import { ComputeError } from '@better-compute/core';
import {
  batchApprovalSigningInput,
  batchLeafInput,
  batchNodeInput,
  SignatureSchema,
  site,
  type BatchApproval,
  type BatchProof,
  type Signature,
} from '@better-compute/protocol';
import { base64url, generateP256KeyPair, toPublicKey, type PublicKeyInput } from './keys.js';
import { signPurpose, verifyPurpose } from './signing.js';

// The v1.0 destructive-batch quorum (PLAN.md §13). A fleet-wide destructive batch (reimage, wipe, reboot of many
// nodes) runs only with k-of-n operator approval: approver keys held off the control plane sign a Merkle root over
// the batch's (subject, kind) scope, and each command carries its inclusion proof, so the executing agent checks
// membership itself and neither a compromised api/worker nor a gateway can widen the batch. The subject is what the
// command acts on (batchSubject): the node itself, a BMC the site agent drives, or a node it proxies HTTP to. Layouts are the protocol
// package's (RFC 6962 style; golden vectors in packages/protocol/golden/batch-scope.json).

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

/** An operator approval key as the TrustBundle lists it: `kid` = base64url(SHA-256(SPKI DER)). */
export interface ApproverKey {
  kid: string;
  spkiDer: Uint8Array;
}

/** The trust-bundle entry for an approver's public key (P-256). */
export function approverKeyOf(publicKey: PublicKeyInput): ApproverKey {
  const key = toPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new ComputeError('INVALID_INPUT', 'Approver keys are ECDSA P-256');
  const spkiDer = new Uint8Array(key.export({ type: 'spki', format: 'der' }));
  return { kid: base64url(sha256(spkiDer)), spkiDer };
}

/** A new approver key pair (P-256): the private key stays with the operator (a file, an HSM). */
export function createApproverKey(): { privateKey: KeyObject; key: ApproverKey } {
  const { privateKey, publicKey } = generateP256KeyPair();
  return { privateKey, key: approverKeyOf(publicKey) };
}

export interface BatchScopeEntry {
  /** What the command acts on (see batchSubject): a node id, `bmc:<address>` or `node:<target node id>`. */
  subject: string;
  kind: string;
}

/** The kinds a site agent runs against a machine's BMC: their subject is `bmc:` + the BMC address. */
export const isBmcKind = (kind: string): boolean => kind.startsWith('bmc.');

/**
 * The subject of a command's batch leaf, computed from the signed body the way the executing agent does:
 * `bmc:` + BmcOperationRequest.address for bmc.* kinds, `node:` + HttpProxyRequest.target_node_id for
 * site.httpProxy, else the command's node_id (kinds a node runs on itself). Throws INVALID_INPUT when a relayed
 * kind's payload is not its request message or names no target.
 */
export function batchSubject(body: { nodeId: string; kind: string; payload?: Any | undefined }): string {
  const bad = (what: string) => new ComputeError('INVALID_INPUT', `${body.kind}: the payload ${what}`);
  if (isBmcKind(body.kind)) {
    const request = body.payload && anyUnpack(body.payload, site.BmcOperationRequestSchema);
    if (!request) throw bad('is not a BmcOperationRequest');
    if (!request.address) throw bad('names no BMC address');
    return `bmc:${request.address}`;
  }
  if (body.kind === 'site.httpProxy') {
    const request = body.payload && anyUnpack(body.payload, site.HttpProxyRequestSchema);
    if (!request) throw bad('is not an HttpProxyRequest');
    if (!request.targetNodeId) throw bad('names no target node');
    return `node:${request.targetNodeId}`;
  }
  if (!body.nodeId) throw new ComputeError('INVALID_INPUT', `${body.kind}: the command names no node`);
  return body.nodeId;
}

/** A batch's scope tree: the root and size approvers sign, and each entry's inclusion proof. */
export interface BatchScope {
  batchId: string;
  root: Uint8Array;
  /** Leaves (distinct (subject, kind) pairs). */
  size: number;
  /** The proof a command for `(subject, kind)` carries; undefined when it is not in the batch. */
  proofOf(subject: string, kind: string): { index: number; siblings: Uint8Array[] } | undefined;
}

const entryKey = (subject: string, kind: string) => `${subject}\u0000${kind}`;

/**
 * Builds the scope tree of a batch: one leaf per distinct (subject, kind), ordered by leaf hash, inner nodes
 * H(0x01 ‖ left ‖ right), an odd node promoted unchanged.
 */
export function batchScope(batchId: string, entries: readonly BatchScopeEntry[]): BatchScope {
  if (!batchId) throw new ComputeError('INVALID_INPUT', 'A batch needs an id');
  const seen = new Map<string, BatchScopeEntry>();
  for (const entry of entries) seen.set(entryKey(entry.subject, entry.kind), entry);
  if (seen.size === 0) throw new ComputeError('INVALID_INPUT', 'A batch has at least one command');
  const leaves = [...seen.values()]
    .map((entry) => ({ ...entry, hash: sha256(batchLeafInput(batchId, entry.subject, entry.kind)) }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const proofs = leaves.map(() => [] as Uint8Array[]);
  let level = leaves.map((leaf, index) => ({ hash: leaf.hash, members: [index] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      for (const member of left.members) proofs[member]!.push(right.hash);
      for (const member of right.members) proofs[member]!.push(left.hash);
      next.push({ hash: sha256(batchNodeInput(left.hash, right.hash)), members: [...left.members, ...right.members] });
    }
    level = next;
  }
  const indexOf = new Map(leaves.map((leaf, index) => [entryKey(leaf.subject, leaf.kind), index]));
  return {
    batchId,
    root: level[0]!.hash,
    size: leaves.length,
    proofOf(subject, kind) {
      const index = indexOf.get(entryKey(subject, kind));
      return index === undefined ? undefined : { index, siblings: proofs[index]!.map((hash) => hash.slice()) };
    },
  };
}

/** Whether `(subject, kind)` of `batchId` is leaf `proof.index` of the tree with `root` and `size` leaves. */
export function verifyBatchProof(input: {
  batchId: string;
  subject: string;
  kind: string;
  proof: Pick<BatchProof, 'index' | 'siblings'>;
  root: Uint8Array;
  size: number;
}): boolean {
  const { proof, size } = input;
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(proof.index) || proof.index >= size) return false;
  if (input.root.length !== 32 || proof.siblings.some((sibling) => sibling.length !== 32)) return false;
  let hash = sha256(batchLeafInput(input.batchId, input.subject, input.kind));
  let index = proof.index;
  let width = size;
  let next = 0;
  while (width > 1) {
    if (index % 2 === 1) {
      const sibling = proof.siblings[next++];
      if (!sibling) return false;
      hash = sha256(batchNodeInput(sibling, hash));
    } else if (index + 1 < width) {
      const sibling = proof.siblings[next++];
      if (!sibling) return false;
      hash = sha256(batchNodeInput(hash, sibling));
    }
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  return next === proof.siblings.length && Buffer.compare(hash, input.root) === 0;
}

/** The approval payload operators sign (`notAfter` in epoch ms). */
export interface BatchApprovalInput {
  batchId: string;
  scopeRoot: Uint8Array;
  scopeSize: number;
  notAfter: number;
}

const signingInputOf = (approval: BatchApprovalInput) => ({
  batchId: approval.batchId,
  scopeRoot: approval.scopeRoot,
  scopeSize: approval.scopeSize,
  notAfter: timestampFromMs(approval.notAfter),
});

/** One approver's signature over a batch (what `better-compute batch approve` produces). */
export function signBatchApproval(approval: BatchApprovalInput, privateKey: KeyObject): Signature {
  const { kid } = approverKeyOf(toPublicKey(privateKey));
  // The same bytes as protocol's batchApprovalSigningInput (checked in tests/pki-quorum).
  const sig = signPurpose(
    privateKey,
    'batch-approval',
    batchApprovalParts(approval.batchId, approval.scopeRoot, approval.scopeSize, timestampFromMs(approval.notAfter)),
  );
  return create(SignatureSchema, { kid, sig });
}

/**
 * The parts of the 'batch-approval' signing input (see protocol's batchApprovalSigningInput), over the timestamp as
 * it travels (seconds, nanos): a verifier never rounds it through milliseconds, as bcd does not.
 */
function batchApprovalParts(
  batchId: string,
  scopeRoot: Uint8Array,
  scopeSize: number,
  notAfter: { seconds: bigint; nanos: number },
): Uint8Array[] {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, scopeSize);
  const time = new Uint8Array(12);
  new DataView(time.buffer).setBigInt64(0, notAfter.seconds);
  new DataView(time.buffer).setInt32(8, notAfter.nanos);
  return [new TextEncoder().encode(batchId), scopeRoot, size, time];
}

/** Approvals a batch of `size` needs: the first tier that covers it, else the threshold. */
export function requiredApprovals(
  size: number,
  threshold: number,
  tiers: readonly { maxScopeSize: number; threshold: number }[] = [],
): number {
  for (const tier of tiers) if (size <= tier.maxScopeSize) return tier.threshold;
  return threshold;
}

export interface VerifyBatchApprovalOptions {
  approverKeys: readonly ApproverKey[];
  threshold: number;
  tiers?: readonly { maxScopeSize: number; threshold: number }[];
  /** Server time, epoch ms. */
  now: number;
}

/**
 * Checks a BatchApproval: not expired, a 32-byte root and a size, and at least the required number of valid
 * signatures by DISTINCT approver keys of the set (unknown kids and duplicates count for nothing). Returns the
 * approving kids; throws ACCESS_DENIED with `details.reason`.
 */
export function verifyBatchApproval(
  approval: Pick<BatchApproval, 'batchId' | 'scopeRoot' | 'scopeSize' | 'notAfter' | 'signatures'>,
  options: VerifyBatchApprovalOptions,
): string[] {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'The batch approval does not admit this command', undefined, { reason });
  if (!approval.batchId) throw deny('no-batch-id');
  if (approval.scopeRoot.length !== 32 || !(approval.scopeSize >= 1)) throw deny('malformed-scope');
  if (!approval.notAfter || !(timestampMs(approval.notAfter) > options.now)) throw deny('expired');
  const required = requiredApprovals(approval.scopeSize, options.threshold, options.tiers);
  if (!(required >= 1)) throw deny('no-threshold');
  const keys = new Map(options.approverKeys.map((key) => [key.kid, key]));
  const parts = batchApprovalParts(approval.batchId, approval.scopeRoot, approval.scopeSize, approval.notAfter);
  const approvers = new Set<string>();
  for (const signature of approval.signatures) {
    const key = keys.get(signature.kid);
    if (!key || approvers.has(key.kid)) continue;
    // The kid must be the key's own (a trust bundle naming one key under another's kid counts for nothing).
    if (base64url(sha256(key.spkiDer)) !== key.kid) continue;
    if (verifyPurpose(key.spkiDer, 'batch-approval', parts, signature.sig)) approvers.add(key.kid);
  }
  if (approvers.size < required) throw deny('too-few-approvals');
  return [...approvers].sort();
}

/**
 * The executing agent's check of one destructive command with a batch_id: the approval is for this batch, holds,
 * and the command's (subject, kind) is in its scope (`subject` from batchSubject of the signed body). Throws
 * ACCESS_DENIED (BATCH_UNAPPROVED on the wire).
 */
export function verifyBatchCommand(
  command: { batchId: string; subject: string; kind: string },
  approval: BatchApproval | undefined,
  proof: BatchProof | undefined,
  options: VerifyBatchApprovalOptions,
): void {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'The batch approval does not admit this command', undefined, { reason });
  if (!approval || !proof) throw deny('no-approval');
  if (approval.batchId !== command.batchId) throw deny('other-batch');
  verifyBatchApproval(approval, options);
  const inScope = verifyBatchProof({
    batchId: command.batchId,
    subject: command.subject,
    kind: command.kind,
    proof,
    root: approval.scopeRoot,
    size: approval.scopeSize,
  });
  if (!inScope) throw deny('not-in-scope');
}

/** The protocol's signing input for an approval (what approvers sign, for tooling that shows or checks it). */
export const batchApprovalSigningBytes = (approval: BatchApprovalInput): Uint8Array =>
  batchApprovalSigningInput(signingInputOf(approval));
