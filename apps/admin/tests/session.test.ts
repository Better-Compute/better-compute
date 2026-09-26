import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The operator session cookie: sealed with AES-256-GCM under ADMIN_SESSION_SECRET, so the browser holds it
// without being able to read (the bearer) or forge (the identity) it; expired or tampered cookies are refused.

const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const session = { token: 'biam_ses_operator_one', identityId: 'idn_1', tenantId: 'ten_root', name: 'Ops', expiresAt: T0 + 3_600_000 };

beforeEach(() => {
  vi.resetModules();
  process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
});
afterEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
});

describe('operator session', () => {
  it('round-trips and hides the bearer from the cookie value', async () => {
    const { sealSession, openSession } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    expect(sealed).not.toContain('biam_ses');
    expect(openSession(sealed, T0)).toEqual(session);
  });

  it('refuses an expired, tampered or foreign cookie', async () => {
    const { sealSession, openSession } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    expect(openSession(sealed, session.expiresAt + 1)).toBeNull();
    const [iv, tag, body] = sealed.split('.');
    const flipped = body!.slice(0, -2) + (body!.endsWith('A') ? 'B' : 'A') + body!.slice(-1);
    expect(openSession(`${iv}.${tag}.${flipped}`, T0)).toBeNull();
    expect(openSession('not.a.cookie', T0)).toBeNull();
    expect(openSession(undefined, T0)).toBeNull();
    vi.resetModules();
    process.env.ADMIN_SESSION_SECRET = 'y'.repeat(40);
    const other = await import('@/lib/session');
    expect(other.openSession(sealed, T0)).toBeNull();
  });

  it('reads the cookie from a request and builds a strict HttpOnly cookie', async () => {
    const { sealSession, sessionFromRequest, sessionCookie, SESSION_COOKIE } = await import('@/lib/session');
    const sealed = sealSession(session)!;
    const request = new Request('http://localhost/', { headers: { cookie: `a=1; ${SESSION_COOKIE}=${encodeURIComponent(sealed)}; b=2` } });
    expect(sessionFromRequest(request, T0)?.identityId).toBe('idn_1');
    const cookie = sessionCookie(sealed, 3600, true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('refuses a short secret', async () => {
    process.env.ADMIN_SESSION_SECRET = 'short';
    vi.stubEnv('NODE_ENV', 'production');
    const { sealSession, sessionsAvailable } = await import('@/lib/session');
    expect(sessionsAvailable()).toBe(false);
    expect(sealSession(session)).toBeNull();
    vi.unstubAllEnvs();
  });
});
