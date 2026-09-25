import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  approverKeyOf,
  batchApprovalSigningBytes,
  batchScope,
  createApproverKey,
  createSigningKey,
  requiredApprovals,
  signBatchApproval,
  signTrustBundle,
  verifyBatchApproval,
  verifyBatchCommand,
  verifyBatchProof,
  verifyTrustBundle,
} from '@better-compute/pki';
import { BatchApprovalSchema, BatchProofSchema, signingInput } from '@better-compute/protocol';

// The v1.0 destructive-batch quorum, pki half (PLAN.md §13): the scope tree must reproduce the protocol's golden
// tree byte for byte (bcd reproduces it too), proofs verify only for their own leaf, and approvals count distinct
// approver keys of the trust bundle against the threshold (or the batch size's tier).

const golden = JSON.parse(readFileSync('packages/protocol/golden/batch-scope.json', 'utf8')) as {
  batchId: string;
  root: string;
  leaves: { index: number; nodeId: string; kind: string; hash: string; siblings: string[] }[];
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const NOW = Date.UTC(2026, 8, 25, 12);

describe('batch scope', () => {
  it('reproduces the golden tree: root, leaf order and every proof', () => {
    // Entries in any order, with a duplicate: the tree sorts and dedupes.
    const entries = [...golden.leaves].reverse().map(({ nodeId, kind }) => ({ nodeId, kind }));
    const scope = batchScope(golden.batchId, [...entries, entries[0]!]);
    expect(hex(scope.root)).toBe(golden.root);
    expect(scope.size).toBe(golden.leaves.length);
    for (const leaf of golden.leaves) {
      const proof = scope.proofOf(leaf.nodeId, leaf.kind)!;
      expect(proof.index).toBe(leaf.index);
      expect(proof.siblings.map(hex)).toEqual(leaf.siblings);
      expect(
        verifyBatchProof({ batchId: golden.batchId, nodeId: leaf.nodeId, kind: leaf.kind, proof, root: scope.root, size: scope.size }),
      ).toBe(true);
    }
    expect(scope.proofOf('node_other', 'disk.wipe')).toBeUndefined();
  });

  it('refuses a proof for anything but its own leaf', () => {
    const leaf = golden.leaves[0]!;
    const base = {
      batchId: golden.batchId,
      nodeId: leaf.nodeId,
      kind: leaf.kind,
      proof: { index: leaf.index, siblings: leaf.siblings.map(fromHex) },
      root: fromHex(golden.root),
      size: golden.leaves.length,
    };
    expect(verifyBatchProof(base)).toBe(true);
    for (const wrong of [
      { nodeId: 'node_01k5w000000000000000000009' },
      { kind: 'node.reboot' },
      { batchId: 'batch_other' },
      { proof: { index: 1, siblings: base.proof.siblings } },
      { proof: { index: 0, siblings: base.proof.siblings.slice(1) } },
      { proof: { index: 0, siblings: [...base.proof.siblings, base.proof.siblings[0]!] } },
      // (The size comes from the approval the operators signed, never from the command.)
      { size: 2 },
      { root: new Uint8Array(32) },
    ])
      expect(verifyBatchProof({ ...base, ...wrong })).toBe(false);
  });

  it('proves every member of a large batch with log-sized proofs', () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({ nodeId: `node_${String(i).padStart(26, '0')}`, kind: 'deploy.image' }));
    const scope = batchScope('batch_big', entries);
    expect(scope.size).toBe(1001);
    for (const entry of entries.filter((_, i) => i % 97 === 0)) {
      const proof = scope.proofOf(entry.nodeId, entry.kind)!;
      expect(proof.siblings.length).toBeLessThanOrEqual(10);
      expect(verifyBatchProof({ batchId: 'batch_big', ...entry, proof, root: scope.root, size: scope.size })).toBe(true);
    }
  });
});

describe('batch approvals', () => {
  const approvers = [createApproverKey(), createApproverKey(), createApproverKey()];
  const approverKeys = approvers.map((approver) => approver.key);
  const scope = batchScope(golden.batchId, golden.leaves);
  const input = { batchId: golden.batchId, scopeRoot: scope.root, scopeSize: scope.size, notAfter: NOW + 3_600_000 };
  const approvalWith = (signers: number[], override: Partial<typeof input> = {}) =>
    create(BatchApprovalSchema, {
      batchId: input.batchId,
      scopeRoot: input.scopeRoot,
      scopeSize: input.scopeSize,
      notAfter: timestampFromMs(input.notAfter),
      ...(override.notAfter !== undefined ? { notAfter: timestampFromMs(override.notAfter) } : {}),
      signatures: signers.map((i) => signBatchApproval({ ...input, ...override }, approvers[i]!.privateKey)),
    });

  it('signs exactly the protocol signing input, under the approver kid', () => {
    const signature = signBatchApproval(input, approvers[0]!.privateKey);
    expect(signature.kid).toBe(approverKeyOf(approvers[0]!.privateKey).kid);
    expect(signature.sig).toHaveLength(64);
    const parts = new Uint8Array(12);
    new DataView(parts.buffer).setBigInt64(0, BigInt(Math.floor(input.notAfter / 1000)));
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, input.scopeSize);
    expect(hex(batchApprovalSigningBytes(input))).toBe(
      hex(signingInput('batch-approval', [new TextEncoder().encode(input.batchId), input.scopeRoot, size, parts])),
    );
  });

  it('needs the threshold of distinct approver keys, unexpired', () => {
    const options = { approverKeys, threshold: 2, now: NOW };
    expect(verifyBatchApproval(approvalWith([0, 2]), options)).toHaveLength(2);
    const reason = (approval: ReturnType<typeof approvalWith>, extra: Partial<typeof options> = {}) => {
      try {
        verifyBatchApproval(approval, { ...options, ...extra });
        return 'ok';
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
      }
    };
    expect(reason(approvalWith([0]))).toBe('too-few-approvals');
    // The same key twice counts once.
    expect(reason(approvalWith([1, 1]))).toBe('too-few-approvals');
    // A key outside the bundle counts for nothing.
    const outsider = createApproverKey();
    const withOutsider = approvalWith([0]);
    withOutsider.signatures.push(signBatchApproval(input, outsider.privateKey));
    expect(reason(withOutsider)).toBe('too-few-approvals');
    expect(reason(approvalWith([0, 1]), { now: NOW + 3_600_000 })).toBe('expired');
    // A signature over another size (the operators approved "3 nodes", not 4) does not count.
    const resized = approvalWith([0, 1]);
    resized.scopeSize = 4;
    expect(reason(resized)).toBe('too-few-approvals');
    // Small batches may need fewer (an auto-approver tier), large ones the full threshold.
    expect(requiredApprovals(3, 2, [{ maxScopeSize: 5, threshold: 1 }])).toBe(1);
    expect(requiredApprovals(50, 2, [{ maxScopeSize: 5, threshold: 1 }])).toBe(2);
    expect(reason(approvalWith([0]), { tiers: [{ maxScopeSize: 5, threshold: 1 }] })).toBe('ok');
  });

  it('admits a command only for its own batch and scope', () => {
    const options = { approverKeys, threshold: 2, now: NOW };
    const approval = approvalWith([0, 1]);
    const leaf = golden.leaves[1]!;
    const proof = create(BatchProofSchema, scope.proofOf(leaf.nodeId, leaf.kind)!);
    expect(() =>
      verifyBatchCommand({ batchId: golden.batchId, nodeId: leaf.nodeId, kind: leaf.kind }, approval, proof, options),
    ).not.toThrow();
    const reason = (command: { batchId: string; nodeId: string; kind: string }, withProof = proof) => {
      try {
        verifyBatchCommand(command, approval, withProof, options);
        return 'ok';
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
      }
    };
    expect(reason({ batchId: golden.batchId, nodeId: leaf.nodeId, kind: 'node.reboot' })).toBe('not-in-scope');
    expect(reason({ batchId: 'batch_other', nodeId: leaf.nodeId, kind: leaf.kind })).toBe('other-batch');
    expect(() =>
      verifyBatchCommand({ batchId: golden.batchId, nodeId: leaf.nodeId, kind: leaf.kind }, undefined, proof, options),
    ).toThrow();
  });

  it('travels in the join-key-signed trust bundle', () => {
    const joinKey = createSigningKey();
    const signed = signTrustBundle(
      { version: 3, approverKeys, approverThreshold: 2, quorumTiers: [{ maxScopeSize: 5, threshold: 1 }], unbatchedDestructivePerHour: 0 },
      joinKey,
    );
    const bundle = verifyTrustBundle(signed, { publicKey: joinKey.publicKey });
    expect(bundle.approverKeys.map((key) => key.kid)).toEqual(approverKeys.map((key) => key.kid));
    expect(bundle).toMatchObject({ approverThreshold: 2, unbatchedDestructivePerHour: 0 });
    expect(bundle.quorumTiers).toMatchObject([{ maxScopeSize: 5, threshold: 1 }]);
  });
});
