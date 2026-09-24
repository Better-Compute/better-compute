import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  KeyObject,
  type JsonWebKey,
} from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  assertP256,
  base64url,
  fromBase64url,
  randomBytesArray,
  toPublicKey,
  type PublicKeyInput,
} from './keys.js';

/**
 * Compact JWE with `alg: ECDH-ES+A256KW` and `enc: A256GCM` (RFC 7516, RFC 7518 §4.6, §5.3) to a
 * P-256 key: sealed join tokens (to the JoinService encryption key) and `SecretResponse.jwe` (to a
 * `SecretRequest.epk`). Only this one algorithm pair is produced or accepted.
 */
export const jweAlgorithm = 'ECDH-ES+A256KW';
export const jweEncryption = 'A256GCM';

/** Protected header members a caller may set; `alg`, `enc` and `epk` are fixed. */
export interface JweHeaderInput {
  kid?: string;
  typ?: string;
  cty?: string;
  /** Extra members (authenticated, not encrypted). Must not collide with the fixed ones. */
  [member: string]: unknown;
}

export interface JweProtectedHeader extends JweHeaderInput {
  alg: typeof jweAlgorithm;
  enc: typeof jweEncryption;
  epk: JsonWebKey;
}

const reserved = new Set(['alg', 'enc', 'epk', 'zip', 'crit', 'apu', 'apv']);
const utf8 = new TextEncoder();
const aesKwIv = Buffer.from('a6a6a6a6a6a6a6a6', 'hex');
/** Bound on accepted compact JWEs; sealed tokens and secrets are small. */
export const maxJweLength = 256 * 1024;

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function lengthPrefixed(value: Uint8Array): Uint8Array[] {
  return [uint32(value.length), value];
}

/**
 * Concat KDF (NIST SP 800-56A §5.8.1) as RFC 7518 §4.6.2 uses it, for keys of at most 256 bits
 * (one SHA-256 round). This package always calls it with `ECDH-ES+A256KW`, empty `apu`/`apv` and
 * 256 bits; the parameters exist for the RFC 7518 Appendix C test vector.
 */
export function concatKdf(
  sharedSecret: Uint8Array,
  algorithm: string = jweAlgorithm,
  keyBits = 256,
  apu: Uint8Array = new Uint8Array(0),
  apv: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (keyBits <= 0 || keyBits > 256 || keyBits % 8)
    throw new ComputeError('INVALID_INPUT', 'concatKdf derives 8 to 256 bits');
  const hash = createHash('sha256');
  hash.update(uint32(1));
  hash.update(sharedSecret);
  for (const part of [
    ...lengthPrefixed(utf8.encode(algorithm)),
    ...lengthPrefixed(apu),
    ...lengthPrefixed(apv),
    uint32(keyBits),
  ])
    hash.update(part);
  return new Uint8Array(hash.digest()).slice(0, keyBits / 8);
}

function failure(): ComputeError {
  // One message for every failure, so a decryption oracle learns nothing about which check failed.
  return new ComputeError('INVALID_INPUT', 'Cannot open JWE');
}

/** Encrypts `plaintext` to `recipient` (P-256 public key) as a compact JWE. */
export function sealJwe(
  plaintext: Uint8Array | string,
  recipient: PublicKeyInput | JsonWebKey,
  header: JweHeaderInput = {},
): string {
  for (const member of Object.keys(header))
    if (reserved.has(member))
      throw new ComputeError('INVALID_INPUT', `JWE header member ${member} is reserved`);
  const recipientKey = isJwk(recipient)
    ? createPublicKey({ key: recipient, format: 'jwk' })
    : toPublicKey(recipient);
  assertP256(recipientKey, 'JWE recipient');
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const epk = ephemeral.publicKey.export({ format: 'jwk' });
  const kek = concatKdf(
    new Uint8Array(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey })),
  );
  const cek = randomBytesArray(32);
  const wrap = createCipheriv('id-aes256-wrap', kek, aesKwIv);
  const encryptedKey = Buffer.concat([wrap.update(cek), wrap.final()]);
  const protectedHeader: JweProtectedHeader = {
    ...header,
    alg: jweAlgorithm,
    enc: jweEncryption,
    epk: { kty: 'EC', crv: 'P-256', x: epk.x!, y: epk.y! },
  };
  const encodedHeader = base64url(utf8.encode(JSON.stringify(protectedHeader)));
  const iv = randomBytesArray(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(encodedHeader, 'ascii'));
  const content = typeof plaintext === 'string' ? utf8.encode(plaintext) : plaintext;
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    encodedHeader,
    base64url(encryptedKey),
    base64url(iv),
    base64url(ciphertext),
    base64url(tag),
  ].join('.');
}

export interface OpenedJwe {
  header: JweProtectedHeader;
  plaintext: Uint8Array;
}

/**
 * Decrypts a compact JWE with the recipient's private key. With `typ`, the header's `typ` must
 * equal it, so a JWE sealed for one purpose never opens as another. Throws `INVALID_INPUT` with one
 * generic message for every failure.
 */
export function openJwe(
  jwe: string,
  privateKey: KeyObject,
  options: { typ?: string } = {},
): OpenedJwe {
  if (typeof jwe !== 'string' || jwe.length > maxJweLength) throw failure();
  const parts = jwe.split('.');
  if (parts.length !== 5) throw failure();
  const [encodedHeader, encodedKey, encodedIv, encodedCiphertext, encodedTag] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  try {
    const header = JSON.parse(
      Buffer.from(fromBase64url(encodedHeader)).toString('utf8'),
    ) as JweProtectedHeader;
    if (typeof header !== 'object' || header === null) throw failure();
    if (header.alg !== jweAlgorithm || header.enc !== jweEncryption) throw failure();
    if ('zip' in header || 'crit' in header) throw failure();
    if (options.typ !== undefined && header.typ !== options.typ) throw failure();
    const epk = header.epk;
    if (
      !epk ||
      epk.kty !== 'EC' ||
      epk.crv !== 'P-256' ||
      typeof epk.x !== 'string' ||
      typeof epk.y !== 'string' ||
      'd' in epk
    )
      throw failure();
    // Importing validates that the point lies on the curve (invalid-curve attacks).
    const ephemeral = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: epk.x, y: epk.y },
      format: 'jwk',
    });
    const kek = concatKdf(new Uint8Array(diffieHellman({ privateKey, publicKey: ephemeral })));
    const unwrap = createDecipheriv('id-aes256-wrap', kek, aesKwIv);
    const cek = Buffer.concat([unwrap.update(fromBase64url(encodedKey)), unwrap.final()]);
    if (cek.length !== 32) throw failure();
    const iv = fromBase64url(encodedIv);
    const tag = fromBase64url(encodedTag);
    if (iv.length !== 12 || tag.length !== 16) throw failure();
    const decipher = createDecipheriv('aes-256-gcm', cek, iv);
    decipher.setAAD(Buffer.from(encodedHeader, 'ascii'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(fromBase64url(encodedCiphertext)),
      decipher.final(),
    ]);
    return { header, plaintext: new Uint8Array(plaintext) };
  } catch {
    throw failure();
  }
}

/** A P-256 public key as a JWK (`{kty, crv, x, y}`), for publishing an encryption key. */
export function publicJwk(key: PublicKeyInput): JsonWebKey {
  const jwk = toPublicKey(key).export({ format: 'jwk' });
  return { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! };
}

function isJwk(value: unknown): value is JsonWebKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof KeyObject) &&
    !(value instanceof Uint8Array) &&
    'kty' in value
  );
}
