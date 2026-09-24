import type { JsonWebKey, KeyObject } from 'node:crypto';
import { ComputeError, newId, parseId, type AgentRole } from '@better-compute/core';
import { normalizeClaim, type JoinClaims } from './claims.js';
import { openJwe, sealJwe } from './jwe.js';
import {
  base64url,
  fromBase64url,
  randomBytesArray,
  sha256,
  timingSafeEqualBytes,
  type PublicKeyInput,
} from './keys.js';

/**
 * Join tokens (PLAN.md §3.3): `bcjt_<id>.<secret>`, shown once. Only `sha256(secret)` is stored
 * (`join_tokens.secret_hash`). In transit the token is sealed to the JoinService encryption key, and
 * the seal names the CSR it was made for, so a relaying gateway can neither read the token nor
 * replay the sealed blob with its own key.
 */
export const joinTokenPrefix = 'bcjt_';

/** `join_tokens.role`. `provisioned` tokens admit a deployed OS as a node; `discovery` a ramdisk. */
export type JoinTokenRole = 'node' | 'site' | 'provisioned' | 'discovery';

export const joinTokenAdmits: Readonly<Record<JoinTokenRole, AgentRole>> = {
  node: 'node',
  site: 'site',
  provisioned: 'node',
  discovery: 'ramdisk',
};

/** Binds a token to one machine: every given identifier must be among the joining agent's claims. */
export interface JoinTokenExpect {
  productUuid?: string;
  serial?: string;
  mac?: string;
  gpuUuid?: string;
}

export interface IssuedJoinToken {
  id: string;
  /** `bcjt_<id>.<secret>`: return it once, never store it. */
  token: string;
  /** `join_tokens.secret_hash`: SHA-256 of the secret's UTF-8 bytes. */
  secretHash: Uint8Array;
}

/** Mints a join token: a `jt_` id and 256 bits of secret. */
export function issueJoinToken(options: { id?: string } = {}): IssuedJoinToken {
  const id = options.id ?? newId('jt');
  if (!parseId(id)) throw new ComputeError('INVALID_INPUT', 'A join token id is a compute id');
  const secret = base64url(randomBytesArray(32));
  return { id, token: `${joinTokenPrefix}${id}.${secret}`, secretHash: hashJoinSecret(secret) };
}

export function hashJoinSecret(secret: string): Uint8Array {
  return sha256(secret);
}

const tokenPattern = /^bcjt_([a-z][a-z0-9]{0,15}_[0-9a-hjkmnp-tv-z]{26,52})\.([A-Za-z0-9_-]{43})$/;

/** Splits a token into id and secret; undefined when it is not one. */
export function parseJoinToken(token: unknown): { id: string; secret: string } | undefined {
  if (typeof token !== 'string') return undefined;
  const match = tokenPattern.exec(token);
  return match ? { id: match[1]!, secret: match[2]! } : undefined;
}

/** A `join_tokens` row as JoinService reads it (`FOR UPDATE`) inside its transaction. */
export interface JoinTokenRecord {
  id: string;
  tenantId: string;
  role: JoinTokenRole;
  poolId?: string | null;
  siteId?: string | null;
  secretHash: Uint8Array;
  usesLeft: number;
  expect?: JoinTokenExpect | null;
  allowReclaim: boolean;
  /** Epoch milliseconds. */
  expiresAt: number;
  revokedAt?: number | null;
}

export type JoinTokenRefusal =
  | 'malformed'
  | 'unknown'
  | 'secret-mismatch'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'role-mismatch'
  | 'expect-mismatch';

export type JoinTokenVerdict =
  | {
      ok: true;
      tokenId: string;
      tenantId: string;
      role: AgentRole;
      poolId?: string;
      siteId?: string;
      allowReclaim: boolean;
    }
  | { ok: false; reason: JoinTokenRefusal };

export interface VerifyJoinTokenContext {
  /** Database time (`compute_now()`), epoch milliseconds. */
  now: number;
  /** The role the agent asks for. */
  role: AgentRole;
  claims: JoinClaims;
}

const dummyHash = new Uint8Array(32);

/**
 * Checks a token against its row: secret (constant time), revocation, expiry, remaining uses, the
 * role it admits and its `expect` binding. Pure: JoinService fetches the row by `parseJoinToken(…).id`
 * `FOR UPDATE` and, on `ok`, decrements `uses_left` in the same transaction. Refusal reasons are for
 * audit only; answer the agent with one generic denial.
 */
export function verifyJoinToken(
  token: string,
  record: JoinTokenRecord | undefined,
  context: VerifyJoinTokenContext,
): JoinTokenVerdict {
  const parsed = parseJoinToken(token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const presented = hashJoinSecret(parsed.secret);
  if (!record || record.id !== parsed.id) {
    timingSafeEqualBytes(presented, dummyHash);
    return { ok: false, reason: 'unknown' };
  }
  if (!timingSafeEqualBytes(presented, record.secretHash))
    return { ok: false, reason: 'secret-mismatch' };
  if (record.revokedAt !== undefined && record.revokedAt !== null)
    return { ok: false, reason: 'revoked' };
  if (!(context.now < record.expiresAt)) return { ok: false, reason: 'expired' };
  if (!(record.usesLeft > 0)) return { ok: false, reason: 'exhausted' };
  if (joinTokenAdmits[record.role] !== context.role) return { ok: false, reason: 'role-mismatch' };
  if (record.expect && !matchesExpect(record.expect, context.claims))
    return { ok: false, reason: 'expect-mismatch' };
  return {
    ok: true,
    tokenId: record.id,
    tenantId: record.tenantId,
    role: context.role,
    ...(record.poolId ? { poolId: record.poolId } : {}),
    ...(record.siteId ? { siteId: record.siteId } : {}),
    allowReclaim: record.allowReclaim,
  };
}

/**
 * Whether the claims satisfy an `expect` binding: every given value must equal a claim after
 * format normalization (case, MAC separators, the `GPU-` prefix). `serial` may match the product,
 * board or chassis serial. An empty expect value never matches. Rejecting placeholder values is
 * `joinTokens.create`'s job (with inventory's blocklist), not this check's.
 */
export function matchesExpect(expect: JoinTokenExpect, claims: JoinClaims): boolean {
  const given = (value: string | undefined) => value !== undefined;
  const blank = (value: string | undefined) => value !== undefined && value.trim() === '';
  if ([expect.productUuid, expect.serial, expect.mac, expect.gpuUuid].some(blank)) return false;
  if (
    given(expect.productUuid) &&
    (claims.productUuid === undefined ||
      normalizeClaim.uuid(claims.productUuid) !== normalizeClaim.uuid(expect.productUuid!))
  )
    return false;
  if (given(expect.serial)) {
    const serials = [claims.serial, claims.boardSerial, claims.chassisSerial]
      .filter((value): value is string => value !== undefined)
      .map(normalizeClaim.serial);
    if (!serials.includes(normalizeClaim.serial(expect.serial!))) return false;
  }
  if (
    given(expect.mac) &&
    !(claims.macs ?? []).map(normalizeClaim.mac).includes(normalizeClaim.mac(expect.mac!))
  )
    return false;
  if (
    given(expect.gpuUuid) &&
    !(claims.gpuUuids ?? [])
      .map(normalizeClaim.gpuUuid)
      .includes(normalizeClaim.gpuUuid(expect.gpuUuid!))
  )
    return false;
  return true;
}

/** `typ` of a sealed join token: nothing else sealed to the JoinService key opens as one. */
export const sealedJoinTokenType = 'bcjt+jwe';

export interface SealJoinTokenOptions {
  /** The CSR the agent sends with this token (DER); the seal carries its SHA-256. */
  csr: Uint8Array;
  /** `kid` of the JoinService encryption key, when it has one. */
  kid?: string;
  /** Epoch milliseconds (default now); JoinService may bound the seal's age. */
  issuedAt?: number;
}

/**
 * `JoinRequest.sealed_token`: a compact JWE of the token to the JoinService encryption key. The
 * protected header carries `csr` (base64url SHA-256 of the request's CSR) and `iat`, authenticated
 * by the JWE, so the blob is useless with any other CSR.
 */
export function sealJoinToken(
  token: string,
  joinEncryptionKey: PublicKeyInput | JsonWebKey,
  options: SealJoinTokenOptions,
): string {
  if (!parseJoinToken(token)) throw new ComputeError('INVALID_INPUT', 'Not a join token');
  return sealJwe(token, joinEncryptionKey, {
    typ: sealedJoinTokenType,
    csr: base64url(sha256(options.csr)),
    iat: Math.floor((options.issuedAt ?? Date.now()) / 1000),
    ...(options.kid !== undefined ? { kid: options.kid } : {}),
  });
}

export interface OpenSealedTokenOptions {
  /** `JoinRequest.csr`: must be the CSR the token was sealed with. */
  csr: Uint8Array;
  /** With `maxAgeMs`: refuses seals older than that (clock skew of ±60 s tolerated). */
  now?: number;
  maxAgeMs?: number;
}

/**
 * Opens `JoinRequest.sealed_token` with the JoinService encryption key and checks its CSR binding.
 * Returns the plain token for `verifyJoinToken`. Throws `ACCESS_DENIED` with a `reason` detail.
 */
export function openSealedToken(
  sealed: string | Uint8Array,
  joinEncryptionPrivateKey: KeyObject,
  options: OpenSealedTokenOptions,
): { token: string; tokenId: string; issuedAt?: number } {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Join refused', undefined, { reason });
  const text = typeof sealed === 'string' ? sealed : new TextDecoder().decode(sealed);
  let opened;
  try {
    opened = openJwe(text, joinEncryptionPrivateKey, { typ: sealedJoinTokenType });
  } catch {
    throw deny('sealed token does not open');
  }
  const binding = typeof opened.header.csr === 'string' ? opened.header.csr : '';
  let bound: Uint8Array;
  try {
    bound = fromBase64url(binding);
  } catch {
    throw deny('sealed token has no CSR binding');
  }
  if (!timingSafeEqualBytes(bound, sha256(options.csr))) throw deny('sealed for another CSR');
  const iat = opened.header.iat;
  const issuedAt = typeof iat === 'number' && Number.isFinite(iat) ? iat * 1000 : undefined;
  if (options.maxAgeMs !== undefined) {
    const now = options.now ?? Date.now();
    if (issuedAt === undefined) throw deny('sealed token has no iat');
    if (issuedAt > now + 60_000 || now - issuedAt > options.maxAgeMs + 60_000)
      throw deny('sealed token is too old');
  }
  const token = new TextDecoder().decode(opened.plaintext);
  const parsed = parseJoinToken(token);
  if (!parsed) throw deny('sealed payload is not a join token');
  return { token, tokenId: parsed.id, ...(issuedAt !== undefined ? { issuedAt } : {}) };
}
