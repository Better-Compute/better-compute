import { PROTOCOL_VERSION } from '@better-compute/protocol';
import type { JoinPublicKeys } from './join/crypto.js';

/** This release of `@better-compute/server`; equal to its package.json version (a test checks). */
export const serverVersion = '0.1.1';

/** What `system.version` and `GET {basePath}/.well-known/better-compute` report. */
export interface ServerInfo {
  name: 'better-compute';
  version: string;
  /** Where the API is mounted, e.g. `/api/compute`. */
  basePath: string;
  /** The agent protocol versions this control plane speaks (`Hello.proto_min`/`proto_max`). */
  protocol: { min: number; max: number };
  /**
   * The well-known document only, when `pki.join` can publish its public keys: the join-key
   * fallback of PLAN.md §6 Install for daemons installed without `/etc/bcd/join-encryption.jwk`.
   * A daemon accepts these only when they match the pins in its config.
   */
  join?: WellKnownJoinKeys;
  /**
   * The well-known document only, when `gateway.url` is set: where daemons dial and the serving CA
   * they pin, so `bcd join --server <control plane>` writes its own config (PLAN.md §6 Install).
   */
  gateway?: WellKnownGateway;
}

/** The gateway section of the well-known document. */
export interface WellKnownGateway {
  /** https URL of the gateway daemons dial. */
  url: string;
  /** The TLS server name, when it differs from the URL's host. */
  serverName?: string;
  /** `sha256/<base64>` SPKI pin of the serving CA (`serving_ca_spki_pin`); absent without one. */
  servingCaPin?: string;
}

/** JoinService's public keys as the well-known document carries them; nothing here is secret. */
export interface WellKnownJoinKeys {
  /** The public JWK join tokens are sealed to (`{kty, crv, x, y}`). */
  encryptionJwk: JoinPublicKeys['encryptionJwk'];
  /** `sha256/<base64>` SPKI pin of the encryption key (`join_encryption_key_pin`). */
  encryptionKeyPin: string;
  /** Standard base64 of the signing key's DER certificate. */
  signingCertificate: string;
  /** `sha256/<base64>` SPKI pin of the signing key (`join_signing_key_pin`). */
  signingKeyPin: string;
}

export function serverInfo(basePath: string): ServerInfo {
  return {
    name: 'better-compute',
    version: serverVersion,
    basePath,
    protocol: { min: PROTOCOL_VERSION.min, max: PROTOCOL_VERSION.max },
  };
}

const pinPattern = /^sha256\/[A-Za-z0-9+/]{43}=$/;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * The wire form of `keys`: exactly the four public fields (a JWK's other members, such as a
 * private `d`, never pass), the certificate as base64 DER. Throws on a malformed port answer.
 */
export function wellKnownJoinKeys(keys: JoinPublicKeys): WellKnownJoinKeys {
  const jwk = keys?.encryptionJwk;
  if (
    !jwk ||
    ![jwk.kty, jwk.crv, jwk.x, jwk.y].every(isText) ||
    !pinPattern.test(String(keys.encryptionKeyPin)) ||
    !pinPattern.test(String(keys.signingKeyPin)) ||
    !(keys.signingCertificate instanceof Uint8Array) ||
    !keys.signingCertificate.length
  )
    throw new Error('pki.join.publicKeys() returned malformed public keys');
  return {
    encryptionJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    encryptionKeyPin: keys.encryptionKeyPin,
    signingCertificate: Buffer.from(keys.signingCertificate).toString('base64'),
    signingKeyPin: keys.signingKeyPin,
  };
}
