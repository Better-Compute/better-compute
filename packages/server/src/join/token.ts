import { createHash, timingSafeEqual } from 'node:crypto';
import { hashJoinSecret } from '@better-compute/pki';

// Join tokens (PLAN.md §3.3 step 1): `bcjt_<id>.<secret>`, shown once; `join_tokens.secret_hash`
// is SHA-256 of the secret's UTF-8 bytes. The format is `@better-compute/pki`'s (`issueJoinToken`
// mints what `joinTokens.create` hands out), so the server parses and hashes with pki's functions.

export { joinTokenPrefix, parseJoinToken } from '@better-compute/pki';

/** `join_tokens.secret_hash` of a secret (pki's `hashJoinSecret`). */
export const hashJoinTokenSecret = (secret: string): Uint8Array => hashJoinSecret(secret);

/** Constant-time comparison of two digests (false for different lengths). */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
