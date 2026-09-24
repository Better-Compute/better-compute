import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { ComputeError, type Clock } from '@better-compute/core';
import { SignatureSchema } from '@better-compute/protocol';
import { base64url, fromBase64url } from './keys.js';
import { createSigningKey, verifySignature, type SignerTrust, type SigningKey } from './signing.js';

// Audit primitives (PLAN.md §13 "Supply chain and audit", v0.4): RFC 6962 / RFC 9162 Merkle trees
// and signed checkpoints. `@better-compute/audit` owns the table, the commit-order cursor and the
// hourly job and builds on these; `better-compute audit verify` and third parties check proofs with
// the audit key's pin alone. No database access here.

const sha256 = (...parts: (Uint8Array | string)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const equal = (a: Uint8Array, b: Uint8Array) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Canonical JSON: sorted keys, no whitespace, `undefined` members dropped. What is hashed and signed. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new ComputeError('INVALID_INPUT', 'Not JSON');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** RFC 6962 leaf hash: SHA-256(0x00 ‖ data). */
export function merkleLeafHash(data: Uint8Array | string): Uint8Array {
  return sha256(Uint8Array.of(0), data);
}

const nodeHash = (left: Uint8Array, right: Uint8Array) => sha256(Uint8Array.of(1), left, right);

/** The largest power of two below `n` (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 Merkle tree hash of leaf hashes (SHA-256 of nothing for an empty tree). */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256('');
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** RFC 6962 §2.1.1 audit path of leaf `index`. */
export function merkleInclusionProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!(Number.isInteger(index) && index >= 0 && index < leaves.length))
    throw new ComputeError('INVALID_INPUT', 'Leaf index out of range');
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...merkleInclusionProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))]
    : [...merkleInclusionProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

/** RFC 9162 §2.1.3.2: whether `proof` shows `leaf` at `index` in the tree of `size` with `root`. */
export function verifyMerkleInclusion(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!(Number.isInteger(index) && Number.isInteger(size) && index >= 0 && index < size))
    return false;
  let fn = index;
  let sn = size - 1;
  let hash = leaf;
  for (const sibling of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      hash = nodeHash(sibling, hash);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else hash = nodeHash(hash, sibling);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equal(hash, root);
}

function subproof(m: number, leaves: readonly Uint8Array[], complete: boolean): Uint8Array[] {
  const n = leaves.length;
  if (m === n) return complete ? [] : [merkleRoot(leaves)];
  const k = split(n);
  return m <= k
    ? [...subproof(m, leaves.slice(0, k), complete), merkleRoot(leaves.slice(k))]
    : [...subproof(m - k, leaves.slice(k), false), merkleRoot(leaves.slice(0, k))];
}

/**
 * RFC 6962 §2.1.2 consistency proof that the first `oldSize` leaves are a prefix of `leaves`, so a
 * log checkpointed twice is provably append-only.
 */
export function merkleConsistencyProof(
  leaves: readonly Uint8Array[],
  oldSize: number,
): Uint8Array[] {
  if (!(Number.isInteger(oldSize) && oldSize >= 0 && oldSize <= leaves.length))
    throw new ComputeError('INVALID_INPUT', 'oldSize out of range');
  if (oldSize === 0 || oldSize === leaves.length) return [];
  return subproof(oldSize, leaves, true);
}

/** RFC 9162 §2.1.4.2: whether the tree of `oldSize` with `oldRoot` is a prefix of the newer one. */
export function verifyMerkleConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: Uint8Array,
  newRoot: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (
    !(Number.isInteger(oldSize) && Number.isInteger(newSize) && oldSize >= 0 && oldSize <= newSize)
  )
    return false;
  if (oldSize === newSize) return proof.length === 0 && equal(oldRoot, newRoot);
  if (oldSize === 0) return proof.length === 0;
  if (proof.length === 0) return false;
  const path = [...proof];
  if ((oldSize & (oldSize - 1)) === 0) path.unshift(oldRoot);
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else sr = nodeHash(sr, c);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return equal(fr, oldRoot) && equal(sr, newRoot) && sn === 0;
}

// --- Signed checkpoints ---------------------------------------------------------------------------

/** A checkpoint as stored: the exact signed bytes and a JSON-friendly `Signature`. */
export interface SignedCheckpoint<Body = Record<string, unknown>> {
  body: Body;
  /** Canonical JSON of `body`, UTF-8: the signed bytes. */
  bodyBytes: Uint8Array;
  signature: { kid: string; sig: string; chain: string[] };
}

/** Signs a checkpoint body (as canonical JSON) for purpose `audit-checkpoint`. */
export function signCheckpoint<Body extends object>(
  body: Body,
  key: SigningKey,
): SignedCheckpoint<Body> {
  const bodyBytes = new TextEncoder().encode(canonicalJson(body));
  const signature = key.sign('audit-checkpoint', [bodyBytes]);
  return {
    body,
    bodyBytes,
    signature: {
      kid: signature.kid,
      sig: base64url(signature.sig),
      chain: signature.chain.map((der) => Buffer.from(der).toString('base64')),
    },
  };
}

/**
 * Verifies a stored checkpoint under the audit key (a pin from `pki show`, or the key) and returns
 * the body parsed from the signed bytes, which must be canonical. `bodyBytes` may be raw or base64.
 * Throws `ACCESS_DENIED`.
 */
export function verifyCheckpoint<Body = Record<string, unknown>>(
  signed: { bodyBytes: Uint8Array | string; signature: SignedCheckpoint['signature'] },
  trust: SignerTrust,
): Body {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Checkpoint rejected', undefined, { reason });
  let bytes: Uint8Array;
  let signature;
  try {
    bytes =
      typeof signed.bodyBytes === 'string'
        ? new Uint8Array(Buffer.from(signed.bodyBytes, 'base64'))
        : signed.bodyBytes;
    signature = create(SignatureSchema, {
      kid: signed.signature.kid,
      sig: fromBase64url(signed.signature.sig),
      chain: signed.signature.chain.map((der) => new Uint8Array(Buffer.from(der, 'base64'))),
    });
  } catch {
    throw deny('malformed checkpoint');
  }
  if (!verifySignature('audit-checkpoint', [bytes], signature, trust)) throw deny('bad signature');
  const text = Buffer.from(bytes).toString('utf8');
  let body: Body;
  try {
    body = JSON.parse(text) as Body;
  } catch {
    throw deny('unreadable body');
  }
  if (canonicalJson(body) !== text) throw deny('body is not canonical');
  return body;
}

/** The audit signing key (kept in the PKI bundle as `auditSigning`; verifiers pin it). */
export function createAuditSigningKey(options: { clock?: Clock } = {}): SigningKey {
  return createSigningKey({
    commonName: 'better-compute audit signing',
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
