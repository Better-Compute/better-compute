import { KeyObject, sign, verify } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  signingInput,
  SignatureSchema,
  type Signature,
  type SigningPurpose,
} from '@better-compute/protocol';
import {
  assertP256,
  base64url,
  generateP256KeyPair,
  matchesPin,
  privateKeyPem,
  randomBytesArray,
  toPem,
  toPrivateKey,
  toPublicKey,
  type PublicKeyInput,
} from './keys.js';
import { buildCertificate, distinguishedName, parseCertificate, subjectKeyId } from './x509.js';

/**
 * A control-plane signing key (JoinService signing key, later worker command keys). It signs with
 * ES256 over `signingInput(purpose, parts)` from `@better-compute/protocol`, emitting raw `r ‖ s`.
 * It carries a self-signed certificate so a verifier holding only a pin can find the key in
 * `Signature.chain` and check it against the pin.
 */
export interface SigningKey {
  /** base64url of the certificate's subject key id (`Signature.kid` for control-plane keys). */
  readonly kid: string;
  readonly publicKey: KeyObject;
  /** DER self-signed certificate of the key, sent as `Signature.chain[0]`. */
  readonly certificate: Uint8Array;
  sign(purpose: SigningPurpose, parts: readonly Uint8Array[]): Signature;
  /** PEM for storage. Handle as a secret. */
  export(): { certificatePem: string; privateKeyPem: string };
}

export interface SigningKeyOptions {
  /** Loads an existing key (and optionally its certificate) instead of generating one. */
  privateKey?: KeyObject | Uint8Array | string;
  certificate?: Uint8Array;
  commonName?: string;
  clock?: Clock;
  /** Certificate lifetime (default 10 years: the key is pinned, not the certificate). */
  validitySeconds?: number;
}

/** Signs `signingInput(purpose, parts)` with a P-256 key: 64 raw bytes (`r ‖ s`). */
export function signPurpose(
  privateKey: KeyObject,
  purpose: SigningPurpose,
  parts: readonly Uint8Array[],
): Uint8Array {
  return new Uint8Array(
    sign('sha256', signingInput(purpose, parts), { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  );
}

/** Verifies a raw `r ‖ s` ES256 signature over `signingInput(purpose, parts)`. */
export function verifyPurpose(
  publicKey: PublicKeyInput,
  purpose: SigningPurpose,
  parts: readonly Uint8Array[],
  signature: Uint8Array,
): boolean {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    return verify(
      'sha256',
      signingInput(purpose, parts),
      { key: toPublicKey(publicKey), dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    return false;
  }
}

export function createSigningKey(options: SigningKeyOptions = {}): SigningKey {
  const privateKey = options.privateKey
    ? toPrivateKey(options.privateKey)
    : generateP256KeyPair().privateKey;
  assertP256(privateKey, 'signing key');
  const publicKey = toPublicKey(privateKey);
  let certificate = options.certificate;
  if (certificate) {
    if (!parseCertificate(certificate).publicKey.equals(publicKey))
      throw new ComputeError('INVALID_INPUT', 'The signing certificate does not match the key');
  } else {
    const now = (options.clock ?? systemClock).now();
    const serial = randomBytesArray(16);
    serial[0] = (serial[0]! & 0x7f) | 0x01;
    const name = distinguishedName({
      organization: 'better-compute',
      commonName: options.commonName ?? 'better-compute signing key',
    });
    certificate = buildCertificate(
      {
        serial,
        issuer: name,
        subject: name,
        notBefore: now - 60_000,
        notAfter: now + (options.validitySeconds ?? 3650 * 86400) * 1000,
        publicKey,
      },
      privateKey,
    );
  }
  const kid = base64url(subjectKeyId(publicKey));
  const chain = [certificate];
  return {
    kid,
    publicKey,
    certificate,
    sign: (purpose, parts) =>
      create(SignatureSchema, { kid, sig: signPurpose(privateKey, purpose, parts), chain }),
    export: () => ({
      certificatePem: toPem(certificate),
      privateKeyPem: privateKeyPem(privateKey),
    }),
  };
}

/** How a verifier knows the signer: its public key, or a `sha256/<base64>` SPKI pin. */
export type SignerTrust = { publicKey: PublicKeyInput } | { pin: string };

/**
 * Verifies a `Signature` for `purpose`. With a pin, the key is taken from `signature.chain[0]` and
 * must match the pin. Returns false on any mismatch; never throws on hostile input.
 */
export function verifySignature(
  purpose: SigningPurpose,
  parts: readonly Uint8Array[],
  signature: Signature | undefined,
  trust: SignerTrust,
): boolean {
  if (!signature) return false;
  let key: KeyObject;
  try {
    if ('publicKey' in trust) key = toPublicKey(trust.publicKey);
    else {
      const leaf = signature.chain[0];
      if (!leaf) return false;
      key = parseCertificate(leaf).publicKey;
      if (!matchesPin(key, trust.pin)) return false;
    }
  } catch {
    return false;
  }
  return verifyPurpose(key, purpose, parts, signature.sig);
}
