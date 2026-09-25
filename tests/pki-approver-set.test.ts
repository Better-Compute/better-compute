import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approverSetDigest,
  approverSetTransition,
  createApproverKey,
  sameApproverSet,
  signApproverSet,
  verifyApproverSetChange,
  type ApproverSet,
} from '@better-compute/pki';
import { approverSetInput, approverSetSigningInput } from '@better-compute/protocol';

// Who may change the quorum (PLAN.md §13, review 6 H1, review 7 M1): a daemon holding approver keys takes a bundle
// that changes any quorum field only for a higher epoch, with its CURRENT approvers' signatures at its current
// threshold over the new fields, the epoch and its own trust domain; the first set, and an unchanged one, need none.

const [a, b, c] = [createApproverKey(), createApproverKey(), createApproverKey()];
const current: ApproverSet = {
  approverKeys: [a.key, b.key],
  approverThreshold: 2,
  quorumTiers: [{ maxScopeSize: 5, threshold: 1 }],
  unbatchedDestructivePerHour: 0,
};
const next: ApproverSet = { ...current, approverKeys: [a.key, b.key, c.key] };
const trustDomain = 'compute.test';

const reason = (run: () => unknown) => {
  try {
    run();
    return 'ok';
  } catch (error) {
    return (error as { details?: { reason?: string } }).details?.reason;
  }
};

describe('approver-set transitions (review 10 M3)', () => {
  const sign = (epoch: bigint, set: ApproverSet, keys: { privateKey: Parameters<typeof signApproverSet>[1] }[]) =>
    keys.map((key) => signApproverSet({ epoch, set, trustDomain: 'compute.test' }, key.privateKey));
  const held = { ...current, epoch: 1n };
  const to = (set: ApproverSet, epoch: bigint, signatures: ReturnType<typeof sign>) => ({
    ...set,
    epoch,
    approverSetSignatures: signatures,
    trustDomain: 'compute.test',
  });

  it('advances the same set only with its own signatures for a higher epoch', () => {
    expect(approverSetTransition(held, to(current, 3n, sign(3n, current, [a, b])))).toMatchObject({ adopt: true });
    expect(approverSetTransition(held, to(current, 3n, sign(3n, current, [a])))).toEqual({ adopt: false, approvers: [] });
    expect(approverSetTransition(held, to(current, 3n, []))).toEqual({ adopt: false, approvers: [] });
    expect(approverSetTransition(held, to(current, 1n, sign(1n, current, [a, b])))).toEqual({ adopt: false, approvers: [] });
  });

  it('takes a different set for a higher epoch with k-of-held, and refuses an older epoch', () => {
    expect(approverSetTransition(held, to(next, 2n, sign(2n, next, [a, b])))).toMatchObject({ adopt: true });
    expect(approverSetTransition({ ...held, epoch: 3n }, to(next, 2n, sign(2n, next, [a, b])))).toMatchObject({
      adopt: false,
      reason: 'stale-epoch',
    });
    expect(approverSetTransition(held, to(next, 2n, sign(2n, next, [c])))).toMatchObject({ adopt: false, reason: 'approver-set-unsigned' });
  });

  it('holding no keys: the first set as it comes, never at or below a held epoch', () => {
    expect(approverSetTransition(undefined, to(current, 1n, []))).toMatchObject({ adopt: true });
    const removed = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0, epoch: 4n };
    expect(approverSetTransition(removed, to(current, 2n, []))).toMatchObject({ adopt: false, reason: 'stale-epoch' });
    expect(approverSetTransition(removed, to(current, 5n, []))).toMatchObject({ adopt: true });
  });
});

describe('approver sets', () => {
  it('digests the canonical fields (keys in any order) and signs the protocol bytes', () => {
    expect(sameApproverSet(current, { ...current, approverKeys: [b.key, a.key] })).toBe(true);
    expect(sameApproverSet(current, next)).toBe(false);
    expect(sameApproverSet(current, { ...current, unbatchedDestructivePerHour: 1 })).toBe(false);
    expect(sameApproverSet(current, { ...current, quorumTiers: [] })).toBe(false);
    expect(Buffer.from(approverSetDigest(current)).toString('hex')).toBe(
      createHash('sha256').update(approverSetInput(current)).digest('hex'),
    );
    const signature = signApproverSet({ epoch: 7, set: next, trustDomain: 'compute.test' }, a.privateKey);
    expect(signature.kid).toBe(a.key.kid);
    const bytes = approverSetSigningInput({ epoch: 7n, setSha256: approverSetDigest(next), trustDomain: 'compute.test' });
    const publicKey = createPublicKey({ key: Buffer.from(a.key.spkiDer), format: 'der', type: 'spki' });
    expect(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature.sig)).toBe(true);
  });

  it('takes the first set and an unchanged one without signatures', () => {
    expect(verifyApproverSetChange(undefined, { ...current, epoch: 1n, approverSetSignatures: [], trustDomain })).toEqual([]);
    const none: ApproverSet = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    expect(verifyApproverSetChange({ ...none, epoch: 0n }, { ...current, epoch: 1n, approverSetSignatures: [], trustDomain })).toEqual([]);
    // The same set at any epoch: nothing changes.
    expect(verifyApproverSetChange({ ...current, epoch: 2n }, { ...current, epoch: 1n, approverSetSignatures: [], trustDomain })).toEqual([]);
  });

  it('needs the current threshold of distinct current approvers over this version', () => {
    // The daemon holds `current` at epoch 1; the change is signed for epoch 2.
    const held = { ...current, epoch: 1n };
    const signed = (
      signers: { privateKey: Parameters<typeof signApproverSet>[1] }[],
      epoch = 2n,
      set = next,
      domain = trustDomain,
    ) => signers.map((signer) => signApproverSet({ epoch, set, trustDomain: domain }, signer.privateKey));
    const change = (signatures: ReturnType<typeof signed>, epoch = 2n, domain: string | undefined = trustDomain) => () =>
      verifyApproverSetChange(held, { ...next, epoch, approverSetSignatures: signatures, trustDomain: domain });
    expect(change(signed([a, b]))()).toEqual([a.key.kid, b.key.kid].sort());
    expect(reason(change([]))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a])))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, a])))).toBe('approver-set-unsigned');
    // The new key cannot vote itself in.
    expect(reason(change(signed([a, c])))).toBe('approver-set-unsigned');
    // Signatures for another epoch, or another set, count for nothing; an epoch that is not higher is refused.
    expect(reason(change(signed([a, b], 3n)))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, b], 2n, current)))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, b], 1n), 1n))).toBe('stale-epoch');
    // Signed for another deployment (staging, sharing the approver keys): refused here; no domain at all, refused.
    expect(reason(change(signed([a, b], 2n, next, 'staging.test')))).toBe('approver-set-unsigned');
    expect(reason(change(signed([a, b]), 2n, ''))).toBe('no-trust-domain');
    // Removal is a change too.
    const lifted: ApproverSet = { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    expect(reason(() => verifyApproverSetChange(held, { ...lifted, epoch: 2n, approverSetSignatures: [], trustDomain }))).toBe(
      'approver-set-unsigned',
    );
    // A current set with threshold 0 admits no change.
    expect(
      reason(() =>
        verifyApproverSetChange(
          { ...held, approverThreshold: 0 },
          { ...next, epoch: 2n, approverSetSignatures: signed([a, b]), trustDomain },
        ),
      ),
    ).toBe('no-threshold');
  });
});
