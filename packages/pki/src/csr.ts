import { createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  children,
  decodeBitString,
  decodeInteger,
  decodeOid,
  der,
  expectTag,
  parseDer,
  Tag,
} from './der.js';
import { assertP256, sha256, spkiDer, toPublicKey } from './keys.js';
import { distinguishedName, ecdsaWithSha256, oids, type NameInput } from './x509.js';

export interface ParsedCsr {
  der: Uint8Array;
  /** SHA-256 of the whole DER request (`JoinResponseBody.csr_sha256`, the Renew PoP input). */
  sha256: Uint8Array;
  /** The requested subject, as DER. Informational only: issued certificates never copy it. */
  subject: Uint8Array;
  subjectPublicKeyInfo: Uint8Array;
  /** The requested key, always P-256. */
  publicKey: KeyObject;
}

function invalid(reason: string): ComputeError {
  return new ComputeError('INVALID_INPUT', `Invalid certificate request: ${reason}`, undefined, {
    reason,
  });
}

/** Largest CSR accepted; a P-256 request is under 300 bytes. */
export const maxCsrBytes = 4096;

/**
 * Parses a DER PKCS#10 request and verifies its self-signature, which proves possession of the
 * requested key. Only ECDSA P-256 with SHA-256 is accepted. Throws `INVALID_INPUT`.
 */
export function parseCsr(input: Uint8Array): ParsedCsr {
  if (!(input instanceof Uint8Array) || input.length === 0) throw invalid('empty');
  if (input.length > maxCsrBytes) throw invalid('too large');
  const bytes = input.slice();
  const structure = (() => {
    try {
      const top = children(expectTag(parseDer(bytes), Tag.sequence, 'request'));
      const [info, algorithm, signature] = top;
      if (top.length !== 3 || !info || !algorithm || !signature) return undefined;
      const fields = children(expectTag(info, Tag.sequence, 'certificationRequestInfo'));
      if (fields.length < 3 || fields.length > 4 || (fields[3] && fields[3].tag !== 0xa0))
        return undefined;
      return {
        info,
        signature: decodeBitString(signature),
        algorithm: decodeOid(children(algorithm)[0]!),
        version: decodeInteger(fields[0]!),
        subject: expectTag(fields[1], Tag.sequence, 'subject'),
        spki: expectTag(fields[2], Tag.sequence, 'subjectPKInfo'),
      };
    } catch {
      return undefined;
    }
  })();
  if (!structure) throw invalid('malformed DER');
  const { info, signature, algorithm, version, subject, spki } = structure;
  if (algorithm !== oids.ecdsaWithSha256)
    throw invalid('signature algorithm must be ecdsa-with-SHA256');
  if (version !== 0n) throw invalid('version must be 0');
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: Buffer.from(spki.bytes), format: 'der', type: 'spki' });
  } catch {
    throw invalid('unreadable public key');
  }
  try {
    assertP256(publicKey);
  } catch {
    throw invalid('the key must be ECDSA P-256');
  }
  let valid = false;
  try {
    valid = verify('sha256', info.bytes, { key: publicKey, dsaEncoding: 'der' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw invalid('bad self-signature');
  return {
    der: bytes,
    sha256: sha256(bytes),
    subject: subject.bytes.slice(),
    subjectPublicKeyInfo: spki.bytes.slice(),
    publicKey,
  };
}

/**
 * Creates a DER PKCS#10 request for `privateKey` (P-256). The daemon does this in Go; the TS
 * version serves `FakeDaemon`, the CLI and tests.
 */
export function createCsr(privateKey: KeyObject, subject: NameInput = {}): Uint8Array {
  assertP256(privateKey, 'privateKey');
  const info = der.sequence(
    der.integer(0),
    distinguishedName(subject),
    spkiDer(toPublicKey(privateKey)),
    der.implicit(0, new Uint8Array(0), true),
  );
  const signature = sign('sha256', info, { key: privateKey, dsaEncoding: 'der' });
  return der.sequence(info, ecdsaWithSha256(), der.bitString(new Uint8Array(signature)));
}
