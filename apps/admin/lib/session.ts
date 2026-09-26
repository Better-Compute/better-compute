// Server-side only: the operator's session, kept in an HttpOnly cookie sealed with AES-256-GCM. It carries the
// operator's own better-iam bearer, which the proxy forwards instead of any shared credential, so every call
// to the compute API is made — and audited, and authorized — as the person who clicked.
//
// Key: ADMIN_SESSION_SECRET (at least 32 characters). In development only (NODE_ENV !== 'production') a
// random key is generated into apps/admin/.admin-secret (gitignored) when the variable is unset.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_COOKIE = 'bc_admin_session';

export interface OperatorSession {
  /** The operator's better-iam bearer (biam_ses_…); never sent to the browser. */
  token: string;
  identityId: string;
  tenantId: string;
  name?: string;
  email?: string;
  /** ms since epoch; the cookie is refused after this even if the browser keeps it. */
  expiresAt: number;
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

/** True when sessions can be sealed (a key is configured, or generated in development). */
export const sessionsAvailable = () => key() !== null;

/** Seal any JSON value (the session cookie, a sign-in challenge) so the browser can carry but not read it. */
export function seal(value: unknown): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** The sealed value, or null when missing, tampered or sealed under another key. */
export function unseal<T>(sealed: string | undefined): T | null {
  const k = key();
  if (!k || !sealed) return null;
  try {
    const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export const sealSession = (session: OperatorSession): string | null => seal(session);

export function openSession(sealed: string | undefined, now = Date.now()): OperatorSession | null {
  const session = unseal<OperatorSession>(sealed);
  if (!session || typeof session.token !== 'string' || typeof session.identityId !== 'string' || typeof session.tenantId !== 'string') return null;
  if (typeof session.expiresAt !== 'number' || session.expiresAt <= now) return null;
  return session;
}

/** The session cookie from a request's Cookie header. */
export function sessionFromRequest(request: Request, now = Date.now()): OperatorSession | null {
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return openSession(match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : undefined, now);
}

/** Set-Cookie attributes: HttpOnly, SameSite=Strict, Secure on https, scoped to the whole app. */
export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export const clearedSessionCookie = (secure: boolean) => sessionCookie('', 0, secure);
