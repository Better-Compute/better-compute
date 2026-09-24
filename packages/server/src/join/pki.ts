import { verify, type KeyObject } from 'node:crypto';
import type { CertificateAuthority } from '@better-compute/core';
import {
  openSealedToken,
  parseCertificate,
  parseCsr,
  sha256,
  type SigningKey,
} from '@better-compute/pki';
import type { JoinCrypto, JoinTrustBundle } from './crypto.js';

export interface PkiJoinCryptoOptions {
  /** SPIFFE trust domain of node certificates (`spiffe://<td>/site/<site>/node/<id>`). */
  trustDomain: string;
  /** The per-region node CA (`createNodeCa`), client certificates only. */
  nodeCa: CertificateAuthority;
  /** The JoinService signing key (`createSigningKey`) whose pin install scripts carry. */
  signingKey: Pick<SigningKey, 'sign'>;
  /** The private half of the JoinService encryption key that join tokens are sealed to. */
  encryptionKey: KeyObject;
  /** Oldest seal accepted, from its `iat` (default 10 minutes; ±60 s of skew on top). */
  sealMaxAgeMs?: number;
  trustBundle?: JoinTrustBundle;
}

/**
 * `JoinCrypto` over `@better-compute/pki`: JWE-sealed join tokens bound to their CSR, PKCS#10
 * parsing with its self-signature check, certificate parsing, ES256 node signatures (raw `r ‖ s`)
 * and the pinned signing key.
 *
 * ```ts
 * betterCompute({ …, pki: { nodeCa, join: pkiJoinCrypto({ trustDomain, nodeCa, signingKey,
 *   encryptionKey }) } });
 * ```
 */
export function pkiJoinCrypto(options: PkiJoinCryptoOptions): JoinCrypto {
  const sealMaxAgeMs = options.sealMaxAgeMs ?? 10 * 60_000;
  return Object.freeze({
    trustDomain: options.trustDomain,
    nodeCa: options.nodeCa,
    ...(options.trustBundle ? { trustBundle: options.trustBundle } : {}),
    openSealedToken: (sealed: Uint8Array, csr: Uint8Array, now: number) =>
      openSealedToken(sealed, options.encryptionKey, { csr, now, maxAgeMs: sealMaxAgeMs }).token,
    inspectCsr(csr: Uint8Array) {
      const parsed = parseCsr(csr);
      return { sha256: parsed.sha256, spkiSha256: sha256(parsed.subjectPublicKeyInfo) };
    },
    inspectCertificate(der: Uint8Array) {
      const parsed = parseCertificate(der);
      return {
        serial: parsed.serial,
        spkiSha256: sha256(parsed.subjectPublicKeyInfo),
        notBefore: parsed.notBefore,
        notAfter: parsed.notAfter,
      };
    },
    verifyNodeSignature(der: Uint8Array, statement: Uint8Array, signature: Uint8Array) {
      try {
        const key = parseCertificate(der).publicKey;
        return verify('sha256', statement, { key, dsaEncoding: 'ieee-p1363' }, signature);
      } catch {
        return false;
      }
    },
    sign: (purpose: 'join-response' | 'trust-bundle', parts: readonly Uint8Array[]) =>
      options.signingKey.sign(purpose, parts),
  } satisfies JoinCrypto);
}
