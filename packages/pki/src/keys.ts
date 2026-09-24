import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
} from 'node:crypto';
import { ComputeError } from '@better-compute/core';

/**
 * better-compute's private OID arc: `2.25.<uuid>` (ITU-T X.667), which needs no registration.
 * `.1.1` is the role extension on agent certificates.
 */
export const oidArc = '2.25.121396728463777788658791269357486937304';
/** Certificate extension carrying the agent role as a UTF8String (`node`, `site`, `ramdisk`, …). */
export const roleExtensionOid = `${oidArc}.1.1`;

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** A fresh P-256 key pair: the only key type compute's PKI issues for or signs with. */
export function generateP256KeyPair(): KeyPair {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

/** Throws `INVALID_INPUT` unless `key` is a P-256 key (public or private). */
export function assertP256(key: KeyObject, what = 'key'): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new ComputeError('INVALID_INPUT', `${what} must be an ECDSA P-256 key`);
}

export type PublicKeyInput = KeyObject | Uint8Array | string;

/** A public key from a KeyObject (public or private), SPKI DER bytes or PEM. */
export function toPublicKey(input: PublicKeyInput): KeyObject {
  if (input instanceof KeyObject) return input.type === 'private' ? createPublicKey(input) : input;
  try {
    return typeof input === 'string'
      ? createPublicKey(input)
      : createPublicKey({ key: Buffer.from(input), format: 'der', type: 'spki' });
  } catch {
    throw new ComputeError('INVALID_INPUT', 'Not a public key (expected SPKI DER or PEM)');
  }
}

/** A private key from a KeyObject, PKCS#8 DER bytes or PEM. */
export function toPrivateKey(input: KeyObject | Uint8Array | string): KeyObject {
  if (input instanceof KeyObject) {
    if (input.type !== 'private') throw new ComputeError('INVALID_INPUT', 'Expected a private key');
    return input;
  }
  try {
    return typeof input === 'string'
      ? createPrivateKey(input)
      : createPrivateKey({ key: Buffer.from(input), format: 'der', type: 'pkcs8' });
  } catch {
    throw new ComputeError('INVALID_INPUT', 'Not a private key (expected PKCS#8 DER or PEM)');
  }
}

/** SubjectPublicKeyInfo DER of a key. */
export function spkiDer(key: PublicKeyInput): Uint8Array {
  return new Uint8Array(toPublicKey(key).export({ type: 'spki', format: 'der' }));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** SHA-256 of a key's SubjectPublicKeyInfo DER (`node_certs.spki_sha256`). */
export function spkiSha256(key: PublicKeyInput): Uint8Array {
  return sha256(spkiDer(key));
}

/**
 * The pin form `bcd`'s config uses: `sha256/` + standard base64 of the SPKI SHA-256
 * (`serving_ca_spki_pin`, `join_signing_key_pin`, `join_encryption_key_pin`).
 */
export function spkiPin(key: PublicKeyInput): string {
  return `sha256/${Buffer.from(spkiSha256(key)).toString('base64')}`;
}

/** Whether `key` matches a `sha256/<base64>` pin, compared in constant time. */
export function matchesPin(key: PublicKeyInput, pin: string): boolean {
  if (!pin.startsWith('sha256/')) return false;
  const expected = Buffer.from(pin.slice('sha256/'.length), 'base64');
  const actual = spkiSha256(key);
  return expected.length === actual.length && timingSafeEqualBytes(expected, actual);
}

/** `Signature.kid` of a node key: base64url (no padding) of the SPKI SHA-256. */
export function nodeKeyId(key: PublicKeyInput): string {
  return base64url(spkiSha256(key));
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new ComputeError('INVALID_INPUT', 'Not base64url (no padding)');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export function randomBytesArray(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

/** PEM armour for DER bytes. */
export function toPem(der: Uint8Array, label = 'CERTIFICATE'): string {
  const body = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Every PEM block of `label` in `text`, as DER, in order. */
export function fromPem(text: string, label = 'CERTIFICATE'): Uint8Array[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `-----BEGIN ${escaped}-----([A-Za-z0-9+/=\\s]+?)-----END ${escaped}-----`,
    'g',
  );
  return [...text.matchAll(pattern)].map(
    (match) => new Uint8Array(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64')),
  );
}

/** PKCS#8 PEM of a private key. */
export function privateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}
