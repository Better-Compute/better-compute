import { createHash, type KeyObject } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { ComputeError } from '@better-compute/core';
import { approverSetInput, SignatureSchema, type Signature, type TrustBundle } from '@better-compute/protocol';
import { base64url, toPublicKey } from './keys.js';
import { approverKeyOf, type ApproverKey } from './quorum.js';
import { signPurpose, verifyPurpose } from './signing.js';

// Who may change the quorum (PLAN.md §13, v1.0; review 6 H1, review 7 M1). The trust bundle is signed by the JoinService key the
// api holds, so on its own it cannot be what widens a quorum: a compromised api would publish a bundle with no
// approver keys, or its own at k = 1. A daemon that holds approver keys therefore accepts a bundle that changes any
// quorum field (keys, threshold, tiers, the unbatched cap; removal included) only when k of its CURRENT approvers
// signed the new fields, purpose "approver-set", parts [uint64_be(epoch), sha256(approverSetInput(fields)),
// trust_domain] (the verifier's own trust domain: a set signed for staging never changes prod's quorum), for an
// epoch above the one it holds (an older set is never taken back). The epoch is the set's own, separate from the
// bundle version, so its signatures stay valid on every later version and a daemon that missed one bundle still
// catches up. A daemon without keys takes the first set as it comes: that only adds restrictions.

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

/** A trust bundle's quorum fields (TrustBundle 3-6). */
export interface ApproverSet {
  approverKeys: readonly ApproverKey[];
  approverThreshold: number;
  quorumTiers: readonly { maxScopeSize: number; threshold: number }[];
  unbatchedDestructivePerHour: number;
}

/** SHA-256 of the canonical quorum fields (protocol approverSetInput): what approvers sign. */
export function approverSetDigest(set: ApproverSet): Uint8Array {
  return sha256(approverSetInput(set));
}

/** Whether two bundles carry the same quorum (keys in any order). */
export function sameApproverSet(a: ApproverSet, b: ApproverSet): boolean {
  return Buffer.compare(approverSetDigest(a), approverSetDigest(b)) === 0;
}

/** The quorum fields of a TrustBundle. */
export const approverSetOf = (bundle: Pick<TrustBundle, keyof ApproverSet>): ApproverSet => ({
  approverKeys: bundle.approverKeys.map((key) => ({ kid: key.kid, spkiDer: key.spkiDer })),
  approverThreshold: bundle.approverThreshold,
  quorumTiers: bundle.quorumTiers.map((tier) => ({ maxScopeSize: tier.maxScopeSize, threshold: tier.threshold })),
  unbatchedDestructivePerHour: bundle.unbatchedDestructivePerHour,
});

const approverSetParts = (epoch: bigint, set: ApproverSet, trustDomain: string): Uint8Array[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, epoch);
  return [bytes, approverSetDigest(set), new TextEncoder().encode(trustDomain)];
};

/**
 * One current approver's signature over a new quorum at `epoch` in the deployment of `trustDomain` (what
 * `better-compute batch sign-approvers` produces; published as approver_set_signatures with approver_set_epoch).
 */
export function signApproverSet(
  input: { epoch: bigint | number; set: ApproverSet; trustDomain: string },
  privateKey: KeyObject,
): Signature {
  if (!input.trustDomain) throw new ComputeError('INVALID_INPUT', 'An approver-set signature names its trust domain');
  if (!(BigInt(input.epoch) >= 1n)) throw new ComputeError('INVALID_INPUT', 'An approver set is signed for an epoch of at least 1');
  const { kid } = approverKeyOf(toPublicKey(privateKey));
  const sig = signPurpose(privateKey, 'approver-set', approverSetParts(BigInt(input.epoch), input.set, input.trustDomain));
  return create(SignatureSchema, { kid, sig });
}

/**
 * Whether a daemon holding `current` (at its epoch) may take `next` (from a trust bundle verified under the join key):
 * - no current approver keys: yes, the first set only adds restrictions;
 * - the same quorum fields: yes, nothing about the quorum changes;
 * - otherwise only for a higher epoch, with valid `approver_set_signatures` over (next.epoch, next's fields, the
 *   verifier's own `trustDomain`) by at least the current threshold of distinct CURRENT approver keys (kid =
 *   SHA-256 of the SPKI).
 * Returns the approving kids (empty when none were needed); throws ACCESS_DENIED with `details.reason`
 * `stale-epoch`, `approver-set-unsigned`, `no-threshold` (a current set with threshold 0 admits no change) or
 * `no-trust-domain`. When it throws, a daemon keeps its quorum and still applies the rest of the bundle.
 */
export function verifyApproverSetChange(
  current: (ApproverSet & { epoch: bigint }) | undefined,
  next: ApproverSet & {
    epoch: bigint;
    approverSetSignatures: readonly Pick<Signature, 'kid' | 'sig'>[];
    /** The verifier's own trust domain (never the bundle's word for it). */
    trustDomain?: string | undefined;
  },
): string[] {
  if (!current?.approverKeys.length) return [];
  if (sameApproverSet(current, next)) return [];
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'The trust bundle changes the quorum without its approvers', undefined, { reason });
  if (!(next.epoch > current.epoch)) throw deny('stale-epoch');
  if (!(current.approverThreshold >= 1)) throw deny('no-threshold');
  if (!next.trustDomain) throw deny('no-trust-domain');
  const parts = approverSetParts(next.epoch, next, next.trustDomain);
  const keys = new Map(current.approverKeys.map((key) => [key.kid, key]));
  const approvers = new Set<string>();
  for (const signature of next.approverSetSignatures) {
    const key = keys.get(signature.kid);
    if (!key || approvers.has(key.kid)) continue;
    // The kid must be the key's own.
    if (base64url(sha256(key.spkiDer)) !== key.kid) continue;
    if (verifyPurpose(key.spkiDer, 'approver-set', parts, signature.sig)) approvers.add(key.kid);
  }
  if (approvers.size < current.approverThreshold) throw deny('approver-set-unsigned');
  return [...approvers].sort();
}
