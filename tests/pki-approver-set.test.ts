import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approverSetDigest,
  createApproverKey,
  sameApproverSet,
  signApproverSet,
  verifyApproverSetChange,
  type ApproverSet,
} from '@better-compute/pki';
import { approverSetInput, approverSetSigningInput } from '@better-compute/protocol';

// Who may change the quorum (PLAN.md §13, review 6 H1): a daemon holding approver keys takes a bundle that changes
// any quorum field only with its CURRENT approvers' signatures at its current threshold, over the new fields and the
// bundle version; the first set, and an unchanged one, need none.

const [a, b, c] = [createApproverKey(), createApproverKey(), createApproverKey()];
const current: ApproverSet = {
  approverKeys: [a.key, b.key],
  approverThreshold: 2,
  quorumTiers: [{ maxScopeSize: 5, threshold: 1 }],
  unbatchedDestructivePerHour: 0,
};
const next: ApproverSet = { ...current, approverKeys: [a.key, b.key, c.key] };

const reason = (run: () => unknown) => {
  try {
    run();
    return 'ok';
  } catch (error) {
    return (error as { details?: { reason?: string } }).details?.reason;
  }
};

describe('approver sets', () => {
  it('digests the canonical fields (keys in any order) and signs the protocol bytes', () => {
    expect(sameApproverSet(current, { ...current, approverKeys: [b.key, a.key] })).toBe(true);
    expect(sameApproverSet(current, next)).toBe(false);
    expect(sameApproverSet(current, { ...current, unbatchedDestructivePerHour: 1 })).toBe(false);
    expect(sameApproverSet(current, { ...current, quorumTiers: [] })).toBe(false);
    expect(Buffer.from(approverSetDigest(current)).toString('hex')).toBe(
      createHash('sha256').update(approverSetInput(current)).digest('hex'),
    );
    const signature = signApproverSet({ version: 7, set: next }, a.privateKey);
    expect(signature.kid).toBe(a.key.kid);
    const bytes = approverSetSigningInput({ version: 7n, setSha256: approverSetDigest(next) });
    const publicKey = createPublicKey({ key: Buffer.from(a.key.spkiDer), format: 'der', type: 'spki' });
    expect(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature.sig)).toBe(true);
  });

  it('takes the first set and an unchanged one without signatures', () => {
    expect(verifyApproverSetChange(undefined, { ...current, version: 2n, approverSetSignatures: [] })).toEqual([]);
    const none: ApproverSet = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    expect(verifyApproverSetChange(none, { ...current, version: 2n, approverSetSignatures: [] })).toEqual([]);
    expect(verifyApproverSetChange(current, { ...current, version: 9n, approverSetSignatures: [] })).toEqual([]);
  });

  it('needs the current threshold of distinct current approvers over this version', () => {
    const signed = (signers: { privateKey: Parameters<typeof signApproverSet>[1] }[], version = 3n, set = next) =>
      signers.map((signer) => signApproverSet({ version, set }, signer.privateKey));
    const change = (signatures: ReturnType<typeof signed>, version = 3n) => () =>
      verifyApproverSetChange(current, { ...next, version, approverSetSignatures: signatures });
    expect(change(signed([a, b]))()).toEqual([a.key.kid, b.key.kid].sort());
    expect(reason(change([]))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a])))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, a])))).toBe('approver-set-unsigned');
    // The new key cannot vote itself in.
    expect(reason(change(signed([a, c])))).toBe('approver-set-unsigned');
    // Signatures for another version, or another set, count for nothing.
    expect(reason(change(signed([a, b], 2n)))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, b], 3n, current)))).toBe('approver-set-unsigned');
    // Removal is a change too.
    const lifted: ApproverSet = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    expect(reason(() => verifyApproverSetChange(current, { ...lifted, version: 3n, approverSetSignatures: [] }))).toBe(
      'approver-set-unsigned',
    );
    // A current set with threshold 0 admits no change.
    expect(
      reason(() =>
        verifyApproverSetChange({ ...current, approverThreshold: 0 }, { ...next, version: 3n, approverSetSignatures: signed([a, b]) }),
      ),
    ).toBe('no-threshold');
  });
});
