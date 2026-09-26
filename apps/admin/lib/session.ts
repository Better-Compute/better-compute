// Server-side only: the operator's session, kept in an HttpOnly cookie sealed with AES-256-GCM. It carries the
// operator's own better-iam bearer, which the proxy forwards instead of any shared credential, so every call
// to the compute API is made — and audited, and authorized — as the person who clicked.
//
// Key: ADMIN_SESSION_SECRET (at least 32 characters). In development only (NODE_ENV !== 'production') a
// random key is generated into apps/admin/.admin-secret (gitignored) when the variable is unset.
//
// Cookies are not isolated by port: on localhost every local server the operator's browser visits receives
// them. So a cookie alone is not a session. It is bound to a random key that only this admin's origin can read
// (localStorage, per scheme+host+port; lib/session-key.ts), sent as the x-bc-session-key header on every call;
// the sealed payload keeps the key's hash. A copied cookie without the key opens nothing.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_COOKIE = 'bc_admin_session';
/** The cookie's name on https: the __Host- prefix makes the browser refuse it from other hosts and paths. */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
export const SESSION_KEY_HEADER = 'x-bc-session-key';
const SESSION_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** What a sealed value is for; bound into the ciphertext (AAD), so one can't be passed off as another. */
export type SealPurpose = 'session' | 'mfa';

export interface OperatorSession {
  /** The operator's better-iam bearer (biam_ses_…); never sent to the browser. */
  token: string;
  identityId: string;
  tenantId: string;
  name?: string;
  email?: string;
  /** ms since epoch; the cookie is refused after this even if the browser keeps it. */
  expiresAt: number;
  /** sha256 of the browser's session key (see above). */
  keyHash: string;
}

let cachedKey: Buffer | null = null;

function key(): Buffer | null {
  if (cachedKey) return cachedKey;
  let secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret && process.env.NODE_ENV !== 'production') {
    const file = join(process.cwd(), '.admin-secret');
    try {
      if (existsSync(file)) secret = readFileSync(file, 'utf8').trim();
      else {
        secret = randomBytes(32).toString('base64url');
        writeFileSync(file, secret, { mode: 0o600 });
      }
    } catch {
      return null;
    }
  }
  if (!secret || secret.length < 32) return null;
  cachedKey = createHash('sha256').update(secret).digest();
  return cachedKey;
}

const aad = (purpose: SealPurpose) => Buffer.from(`bc-admin/${purpose}/v1`);

/** True when sessions can be sealed (a key is configured, or generated in development). */
export const sessionsAvailable = () => key() !== null;

/** Seal a JSON value for one purpose (the session cookie, a sign-in challenge): the browser carries it, can't read it. */
export function seal(value: unknown, purpose: SealPurpose): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  cipher.setAAD(aad(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** The sealed value, or null when missing, tampered, sealed for another purpose or under another key. */
export function unseal<T>(sealed: string | undefined, purpose: SealPurpose): T | null {
  const k = key();
  if (!k || !sealed || sealed.length > 16 * 1024) return null;
  try {
    const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** sha256 of a browser session key (base64url), or null when the key is missing or malformed. */
export function hashSessionKey(value: string | null | undefined): string | null {
  if (!value || !SESSION_KEY.test(value)) return null;
  return createHash('sha256').update(value).digest('base64url');
}

/** Constant-time comparison of two hashes. */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The session-key hash a request carries (x-bc-session-key), or null. */
export const requestKeyHash = (request: Request) => hashSessionKey(request.headers.get(SESSION_KEY_HEADER));

export const sealSession = (session: OperatorSession): string | null => seal(session, 'session');

// Sessions signed out here, until they expire: a copy of the cookie stays refused even when better-iam could
// not be reached to end the session there. Keyed by the bearer's hash (in memory: one admin process).
const revoked = new Map<string, number>();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');

export function revokeSession(session: OperatorSession, now = Date.now()) {
  for (const [hash, until] of revoked) if (until <= now) revoked.delete(hash);
  revoked.set(tokenHash(session.token), session.expiresAt);
}

/** A sealed session cookie's payload if it is valid, unexpired and not signed out (the browser key is not checked). */
export function openSession(sealed: string | undefined, now = Date.now()): OperatorSession | null {
  const session = unseal<OperatorSession>(sealed, 'session');
  if (!session || typeof session.token !== 'string' || typeof session.identityId !== 'string' || typeof session.tenantId !== 'string') return null;
  if (typeof session.keyHash !== 'string') return null;
  if (typeof session.expiresAt !== 'number' || session.expiresAt <= now) return null;
  if (revoked.has(tokenHash(session.token))) return null;
  return session;
}

/**
 * Every session cookie in a request that opens (either name, any path; a sibling port can toss in its own
 * cookies, so never trust just the first). Values that don't decode or open are skipped.
 */
export function sessionsInRequest(request: Request, now = Date.now()): OperatorSession[] {
  const out: OperatorSession[] = [];
  for (const part of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    if (eq < 0 || (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE)) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    const session = openSession(value, now);
    if (session) out.push(session);
  }
  return out;
}

/** The request's operator session: a cookie that opens *and* matches the browser's session key header. */
export function sessionFromRequest(request: Request, now = Date.now()): OperatorSession | null {
  const keyHash = requestKeyHash(request);
  if (!keyHash) return null;
  return sessionsInRequest(request, now).find((session) => sameHash(session.keyHash, keyHash)) ?? null;
}

/** Set-Cookie for the session: HttpOnly, SameSite=Strict, Path=/; on https Secure and the __Host- name. */
export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`, ...(secure ? ['Secure'] : [])].join('; ');
}

/** Set-Cookie headers that clear the session under both names. */
export const clearedSessionCookies = (secure: boolean): string[] => [
  sessionCookie('', 0, secure),
  ...(secure ? [[`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', 'Secure'].join('; ')] : []),
];
