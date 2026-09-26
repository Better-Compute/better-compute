import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The operator session cookie: sealed with AES-256-GCM under ADMIN_SESSION_SECRET, so the browser holds it
// without being able to read (the bearer) or forge (the identity) it; expired or tampered cookies are refused,
// and a cookie only counts together with the browser's session key (cookies leak across localhost ports).

const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const KEY = 'k'.repeat(43);
let session: {
  token: string;
  identityId: string;
  tenantId: string;
  name: string;
  expiresAt: number;
  keyHash: string;
};

beforeEach(async () => {
  vi.resetModules();
  process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
  const { hashSessionKey } = await import('@/lib/session');
  session = { token: 'biam_ses_operator_one', identityId: 'idn_1', tenantId: 'ten_root', name: 'Ops', expiresAt: T0 + 3_600_000, keyHash: hashSessionKey(KEY)! };
});
afterEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
});

const withCookie = (cookie: string, key: string | null = KEY) =>
  new Request('http://localhost/', { headers: { cookie, ...(key ? { 'x-bc-session-key': key } : {}) } });

describe('operator session', () => {
  it('round-trips and hides the bearer from the cookie value', async () => {
    const { sealSession, openSession } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    expect(sealed).not.toContain('biam_ses');
    expect(openSession(sealed, T0)).toEqual(session);
  });

  it('refuses an expired, tampered, foreign or other-purpose value', async () => {
    const { sealSession, openSession, seal } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    expect(openSession(sealed, session.expiresAt + 1)).toBeNull();
    const [iv, tag, body] = sealed.split('.');
    const flipped = body!.slice(0, -2) + (body!.endsWith('A') ? 'B' : 'A') + body!.slice(-1);
    expect(openSession(`${iv}.${tag}.${flipped}`, T0)).toBeNull();
    expect(openSession('not.a.cookie', T0)).toBeNull();
    expect(openSession(undefined, T0)).toBeNull();
    // Same key, same shape, sealed as an MFA challenge: not a session.
    expect(openSession(seal(session, 'mfa')!, T0)).toBeNull();
    vi.resetModules();
    process.env.ADMIN_SESSION_SECRET = 'y'.repeat(40);
    const other = await import('@/lib/session');
    expect(other.openSession(sealed, T0)).toBeNull();
  });

  it('needs the browser session key with the cookie', async () => {
    const { sealSession, sessionFromRequest, SESSION_COOKIE } = await import('@/lib/session');
    const cookie = `a=1; ${SESSION_COOKIE}=${encodeURIComponent(sealSession(session)!)}; b=2`;
    expect(sessionFromRequest(withCookie(cookie), T0)?.identityId).toBe('idn_1');
    // A local server on another port got the cookie (cookies ignore ports) but not the key.
    expect(sessionFromRequest(withCookie(cookie, null), T0)).toBeNull();
    expect(sessionFromRequest(withCookie(cookie, 'z'.repeat(43)), T0)).toBeNull();
    expect(sessionFromRequest(withCookie(cookie, 'short'), T0)).toBeNull();
  });

  it('survives tossed cookies: undecodable values and decoys before the real one', async () => {
    const { sealSession, sessionFromRequest, SESSION_COOKIE, SECURE_SESSION_COOKIE } = await import('@/lib/session');
    const real = encodeURIComponent(sealSession(session)!);
    expect(() => sessionFromRequest(withCookie(`${SESSION_COOKIE}=%; ${SESSION_COOKIE}=${real}`), T0)).not.toThrow();
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=%; ${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${real}`), T0)?.identityId).toBe('idn_1');
    expect(sessionFromRequest(withCookie(`${SECURE_SESSION_COOKIE}=${real}`), T0)?.identityId).toBe('idn_1');
  });

  it('refuses a revoked session until it expires', async () => {
    const { sealSession, openSession, revokeSession } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    revokeSession(session, T0);
    expect(openSession(sealed, T0)).toBeNull();
  });

  it('builds a strict HttpOnly cookie, __Host- and Secure on https', async () => {
    const { sessionCookie, clearedSessionCookies } = await import('@/lib/session');
    const cookie = sessionCookie('v', 3600, true);
    expect(cookie).toMatch(/^__Host-bc_admin_session=v; Path=\//);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(sessionCookie('v', 3600, false)).toMatch(/^bc_admin_session=v;/);
    expect(clearedSessionCookies(true)).toHaveLength(2);
  });

  it('refuses a short secret', async () => {
    process.env.ADMIN_SESSION_SECRET = 'short';
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { sealSession, sessionsAvailable } = await import('@/lib/session');
    expect(sessionsAvailable()).toBe(false);
    expect(sealSession(session)).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('sign-in redirect', () => {
  it('keeps same-origin paths and refuses everything that could leave the site', async () => {
    const { safeNext } = await import('@/lib/redirect');
    expect(safeNext('/nodes?tab=gpu#x')).toBe('/nodes?tab=gpu#x');
    expect(safeNext('/settings%23connection')).toBe('/settings%23connection');
    // ?next=/%09/evil.example arrives decoded as '/\t/evil.example'.
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'evil', ' /x', '/a b', undefined, 42])
      expect(safeNext(bad), String(bad)).toBe('/');
    expect(safeNext('/x', 'http://127.0.0.1:4200')).toBe('/x');
  });
});
