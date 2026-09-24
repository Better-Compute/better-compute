import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createAuditSigningKey,
  createPkiBundle,
  exportPkiBundle,
  importPkiBundle,
  merkleConsistencyProof,
  merkleInclusionProof,
  merkleLeafHash,
  merkleRoot,
  pkiPins,
  readPkiPins,
  signCheckpoint,
  spkiPin,
  verifyCheckpoint,
  verifyMerkleConsistency,
  verifyMerkleInclusion,
} from '@better-compute/pki';

// Audit primitives (PLAN.md §13, v0.4): RFC 6962 trees and signed checkpoints, used by
// @better-compute/audit and by `better-compute audit verify|prove`.

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const leaves = (n: number, salt = 0) =>
  Array.from({ length: n }, (_, index) => merkleLeafHash(Uint8Array.of(index, n, salt)));

describe('RFC 6962 Merkle trees', () => {
  it('matches the certificate-transparency reference roots', () => {
    const inputs = [
      [],
      [0x00],
      [0x10],
      [0x20, 0x21],
      [0x30, 0x31],
      [0x40, 0x41, 0x42, 0x43],
      [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57],
      [
        0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e,
        0x6f,
      ],
    ].map((bytes) => merkleLeafHash(Uint8Array.from(bytes)));
    expect(hex(merkleRoot([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(merkleRoot(inputs.slice(0, 1)))).toBe(
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    );
    expect(hex(merkleRoot(inputs))).toBe(
      '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
    );
  });

  it('proves inclusion of every leaf in trees of every size, and nothing else', () => {
    for (let size = 1; size <= 33; size++) {
      const tree = leaves(size);
      const root = merkleRoot(tree);
      for (let index = 0; index < size; index++) {
        const proof = merkleInclusionProof(tree, index);
        expect(
          verifyMerkleInclusion(tree[index]!, index, size, proof, root),
          `${index}/${size}`,
        ).toBe(true);
        if (size > 1) {
          expect(verifyMerkleInclusion(tree[index]!, (index + 1) % size, size, proof, root)).toBe(
            false,
          );
          // Roots do not commit to the size (checkpoints sign size and root together), but a path
          // never verifies against a different tree's root.
          expect(
            verifyMerkleInclusion(tree[index]!, index, size, proof, merkleRoot(leaves(size, 1))),
          ).toBe(false);
        }
      }
    }
    expect(() => merkleInclusionProof(leaves(3), 3)).toThrow(/out of range/);
  });

  it('proves every prefix consistent with every extension, and refuses rewritten history', () => {
    for (let newSize = 1; newSize <= 20; newSize++) {
      const tree = leaves(newSize);
      const newRoot = merkleRoot(tree);
      for (let oldSize = 0; oldSize <= newSize; oldSize++) {
        const oldRoot = merkleRoot(tree.slice(0, oldSize));
        const proof = merkleConsistencyProof(tree, oldSize);
        expect(
          verifyMerkleConsistency(oldSize, newSize, oldRoot, newRoot, proof),
          `${oldSize}->${newSize}`,
        ).toBe(true);
        if (oldSize > 0 && oldSize < newSize) {
          // A log whose old part was rewritten is not an extension of the old checkpoint.
          const forged = merkleRoot([...leaves(oldSize, 9), ...tree.slice(oldSize)]);
          expect(verifyMerkleConsistency(oldSize, newSize, oldRoot, forged, proof)).toBe(false);
          expect(
            verifyMerkleConsistency(
              oldSize,
              newSize,
              merkleRoot(leaves(oldSize, 9)),
              newRoot,
              proof,
            ),
          ).toBe(false);
        }
      }
    }
  });
});

describe('signed checkpoints', () => {
  const body = {
    v: 1,
    tenantId: 'org_acme',
    sequence: 7,
    from: '100.1',
    to: '250.9',
    size: 3,
    root: 'abc',
    previous: null,
  };

  it('sign canonical JSON and verify under the pin, as stored (base64) or raw', () => {
    const key = createAuditSigningKey();
    const signed = signCheckpoint(body, key);
    expect(Buffer.from(signed.bodyBytes).toString()).toBe(canonicalJson(body));
    expect(Buffer.from(signed.bodyBytes).toString()).toBe(
      '{"from":"100.1","previous":null,"root":"abc","sequence":7,"size":3,"tenantId":"org_acme","to":"250.9","v":1}',
    );
    const trust = { pin: spkiPin(key.publicKey) };
    expect(verifyCheckpoint(signed, trust)).toEqual(body);
    const stored = JSON.parse(
      JSON.stringify({
        bodyBytes: Buffer.from(signed.bodyBytes).toString('base64'),
        signature: signed.signature,
      }),
    );
    expect(verifyCheckpoint(stored, trust)).toEqual(body);
  });

  it('refuses edited bodies, other keys and other purposes', () => {
    const key = createAuditSigningKey();
    const signed = signCheckpoint(body, key);
    const reason = (fn: () => unknown) => {
      try {
        fn();
        return 'accepted';
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
      }
    };
    const edited = {
      ...signed,
      bodyBytes: new TextEncoder().encode(canonicalJson({ ...body, size: 4 })),
    };
    expect(reason(() => verifyCheckpoint(edited, { publicKey: key.publicKey }))).toBe(
      'bad signature',
    );
    expect(
      reason(() => verifyCheckpoint(signed, { pin: spkiPin(createAuditSigningKey().publicKey) })),
    ).toBe('bad signature');
    // A join-response signature by the same key never passes as a checkpoint.
    const other = key.sign('join-response', [signed.bodyBytes]);
    const repurposed = {
      bodyBytes: signed.bodyBytes,
      signature: { ...signed.signature, sig: Buffer.from(other.sig).toString('base64url') },
    };
    expect(reason(() => verifyCheckpoint(repurposed, { publicKey: key.publicKey }))).toBe(
      'bad signature',
    );
    // Signed bytes that are not canonical JSON are refused.
    const loose = new TextEncoder().encode(JSON.stringify({ v: 1, a: 2 }));
    const signedLoose = {
      bodyBytes: loose,
      signature: {
        ...signed.signature,
        sig: Buffer.from(key.sign('audit-checkpoint', [loose]).sig).toString('base64url'),
      },
    };
    expect(reason(() => verifyCheckpoint(signedLoose, { publicKey: key.publicKey }))).toBe(
      'body is not canonical',
    );
  });

  it('keep the audit signing key in the PKI bundle and its pin in pki show', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const pins = pkiPins(bundle);
    expect(pins.auditSigningKeyPin).toMatch(/^sha256\//);
    const text = exportPkiBundle(bundle);
    expect(readPkiPins(text).auditSigningKeyPin).toBe(pins.auditSigningKeyPin);
    const loaded = importPkiBundle(text);
    const signed = signCheckpoint(body, loaded.auditSigning!);
    expect(verifyCheckpoint(signed, { pin: pins.auditSigningKeyPin! })).toEqual(body);
    // Bundles written before the audit key keep loading.
    const legacy = JSON.parse(text);
    delete legacy.auditSigningCertificate;
    delete legacy.keys.auditSigning;
    expect(importPkiBundle(JSON.stringify(legacy)).auditSigning).toBeUndefined();
    expect(readPkiPins(JSON.stringify(legacy)).auditSigningKeyPin).toBeUndefined();
  });
});
