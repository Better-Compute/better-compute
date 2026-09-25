import type { CertificateAuthority } from '@better-compute/core';
import type { SigningPurpose } from '@better-compute/protocol';

// The crypto JoinService needs, as a narrow port (PLAN.md §3.3, §7.7, §13). `@better-compute/pki`
// satisfies it: `openSealedToken`, `parseCsr`, `parseCertificate`, a `SigningKey` and a node CA.
// JoinService keeps the policy (token rules, reclaim, the PoP window and replay cache, the
// `node_certs` checks); the port only does cryptography, so the server never holds a key format.

/** What JoinService reads from a PKCS#10 request whose self-signature verified. */
export interface CsrInfo {
  /** SHA-256 of the whole DER request (`JoinResponseBody.csr_sha256`, the Renew PoP input). */
  sha256: Uint8Array;
  /** SHA-256 of the requested key's SubjectPublicKeyInfo DER (`node_certs.spki_sha256`). */
  spkiSha256: Uint8Array;
}

/** What Renew reads from a certificate a node presents (structure only; trust comes from `node_certs`). */
export interface CertificateInfo {
  /** Lower-case hex without leading zeros (`node_certs.serial`). */
  serial: string;
  spkiSha256: Uint8Array;
  notBefore: number;
  notAfter: number;
}

/** A signature by the pinned JoinService signing key (pki's `Signature` message satisfies it). */
export interface JoinSignature {
  kid: string;
  /** Raw 64-byte `r ‖ s`. */
  sig: Uint8Array;
  /** DER, leaf first: lets a daemon holding only a pin find the key. */
  chain?: readonly Uint8Array[];
}

/** The command/spec signing trust handed to a joining daemon (empty roots in v0.1). */
export interface JoinTrustBundle {
  version: bigint;
  commandSigningRoots: readonly Uint8Array[];
  /** (v1.0 quorum, §13) Operator approver keys: `kid` = base64url SHA-256 of `spkiDer`. */
  approverKeys?: readonly { kid: string; spkiDer: Uint8Array }[];
  approverThreshold?: number;
  quorumTiers?: readonly { maxScopeSize: number; threshold: number }[];
  unbatchedDestructivePerHour?: number;
  /**
   * (v1.0, review #6 H1, review #7 M1) The current approvers' "approver-set" signatures over this bundle's
   * quorum fields at `approverSetEpoch` (`better-compute batch sign-approvers --epoch`): daemons that hold
   * approver keys take a quorum change only with them. Published on every version while the set is current.
   */
  approverSetSignatures?: readonly { kid: string; sig: Uint8Array }[];
  /** The epoch of the quorum fields (`pki.approvers.epoch`, default 1 with approvers, else 0). */
  approverSetEpoch?: bigint;
}

/**
 * The public halves of JoinService's two keys, as `/.well-known/better-compute` publishes them for
 * daemons that were installed without them (PLAN.md §6 Install). A daemon accepts them only if they
 * match the pins in its config; nothing here is secret.
 */
export interface JoinPublicKeys {
  /** The P-256 encryption key join tokens are sealed to, as a public JWK (`{kty, crv, x, y}`). */
  encryptionJwk: { kty: string; crv: string; x: string; y: string };
  /** `sha256/<base64>` of its SubjectPublicKeyInfo: `bcd`'s `join_encryption_key_pin`. */
  encryptionKeyPin: string;
  /** DER certificate of the signing key (the `Signature.chain[0]` of join responses). */
  signingCertificate: Uint8Array;
  /** `sha256/<base64>` of the signing key's SubjectPublicKeyInfo: `join_signing_key_pin`. */
  signingKeyPin: string;
}

export interface JoinCrypto {
  /** SPIFFE trust domain of node certificates: `spiffe://<td>/site/<site>/node/<id>`. */
  readonly trustDomain: string;
  /** The per-region node CA: client certificates only (§13). */
  readonly nodeCa: CertificateAuthority;
  /** Handed to joining daemons in `JoinResponseBody.trust` (default: version 0, no roots). */
  readonly trustBundle?: JoinTrustBundle;
  /**
   * Opens `JoinRequest.sealed_token` (a compact JWE to the JoinService encryption key) and checks
   * that the seal names `csr`. Returns the plain `bcjt_<id>.<secret>` token; throws `ACCESS_DENIED`.
   */
  openSealedToken(sealed: Uint8Array, csr: Uint8Array, now: number): string | Promise<string>;
  /** Parses a DER PKCS#10 request and verifies its self-signature; throws `INVALID_INPUT`. */
  inspectCsr(csr: Uint8Array): CsrInfo | Promise<CsrInfo>;
  /** Parses a DER certificate; throws `INVALID_INPUT`. */
  inspectCertificate(der: Uint8Array): CertificateInfo | Promise<CertificateInfo>;
  /**
   * Whether `signature` (raw `r ‖ s`, ES256) over `statement` was made by the key `certificate`
   * certifies. `statement` is already framed (`renewPopSigningInput`). Never throws.
   */
  verifyNodeSignature(
    certificate: Uint8Array,
    statement: Uint8Array,
    signature: Uint8Array,
  ): boolean | Promise<boolean>;
  /** ES256 by the pinned JoinService signing key over `signingInput(purpose, parts)`. */
  sign(
    purpose: Extract<SigningPurpose, 'join-response' | 'trust-bundle'>,
    parts: readonly Uint8Array[],
  ): JoinSignature | Promise<JoinSignature>;
  /**
   * The public halves of the encryption and signing keys, for `/.well-known/better-compute`. Never
   * private material. Without it the well-known document carries no `join` section.
   */
  publicKeys?(): JoinPublicKeys | Promise<JoinPublicKeys>;
}
