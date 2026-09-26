import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Operator sign-in against a stubbed better-iam, and the proxy acting as that operator. The shared connection
// stays read-only; a signed-in operator's own bearer is forwarded for every method.

type Call = { url: string; body: unknown; auth: string | null };
let calls: Call[] = [];
let mfa = false;
let lookupFails = false;
let signOutFails = false;

function stubIam() {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, auth: headers.get('authorization') });
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/iam/tenants/lookup')) return lookupFails ? reply({ error: { code: 'NOT_FOUND', message: 'no tenant nope' } }, 404) : reply({ data: { tenantId: 'ten_acme' } });
    if (url.endsWith('/api/iam/auth/signIn')) {
      if (body.password !== 'right') return reply({ error: { code: 'INVALID_CREDENTIALS', message: 'bad password for alice@acme' } }, 401);
      return reply({ data: mfa ? { mfaRequired: true, challenge: 'chal_1', enrollmentRequired: false } : { token: 'biam_ses_alice', session: {} } });
    }
    if (url.endsWith('/api/iam/auth/verifyMfa')) return reply(body.code === '123456' ? { data: { token: 'biam_ses_alice_mfa' } } : { error: { code: 'INVALID_CODE', message: 'no' } }, body.code === '123456' ? 200 : 401);
    if (url.endsWith('/api/iam/auth/getSession')) return reply({ data: { identity: { id: 'idn_alice', name: 'Alice', email: 'alice@acme' }, session: { tenantId: 'ten_acme' }, limits: { lifetimeMs: 3_600_000 } } });
    if (url.endsWith('/api/iam/auth/signOut')) return signOutFails ? Promise.reject(new Error('connect ECONNREFUSED')) : reply({ data: { success: true } });
    if (url.includes('/api/compute/')) return reply({ data: { ok: true } });
    return reply({ error: { code: 'NOT_FOUND', message: url } }, 404);
  });
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  mfa = false;
  lookupFails = false;
  signOutFails = false;
  process.env.ADMIN_COMPUTE_URL = 'http://compute.test/api/compute';
  process.env.ADMIN_COMPUTE_TENANT = 'ten_root';
  process.env.ADMIN_SESSION_SECRET = 's'.repeat(40);
  delete process.env.ADMIN_COMPUTE_TOKEN;
  stubIam();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ['ADMIN_COMPUTE_URL', 'ADMIN_COMPUTE_TENANT', 'ADMIN_SESSION_SECRET']) delete process.env[key];
});

const KEY = 'browser-key-'.padEnd(43, 'a');
const ours = { host: 'localhost:4200', 'x-better-compute': '1', 'content-type': 'application/json', 'x-bc-session-key': KEY };
const post = async (body: unknown, headers: Record<string, string> = ours) => {
  const { POST } = await import('@/app/api/session/route');
  return POST(new Request('http://localhost:4200/api/session', { method: 'POST', headers, body: JSON.stringify(body) }));
};
const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('operator sign-in', () => {
  it('signs in, seals the operator session into an HttpOnly cookie bound to the browser key, never returning the token', async () => {
    const response = await post({ organization: 'acme', email: 'alice@acme', password: 'right' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('biam_ses');
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toContain('biam_ses');
    expect(calls.find((c) => c.url.endsWith('auth/signIn'))!.body).toMatchObject({ tenantId: 'ten_acme', email: 'alice@acme' });
    const { sessionFromRequest } = await import('@/lib/session');
    const withKey = (key?: string) => new Request('http://x/', { headers: { cookie: cookieOf(response), ...(key ? { 'x-bc-session-key': key } : {}) } });
    expect(sessionFromRequest(withKey(KEY))).toMatchObject({ identityId: 'idn_alice', tenantId: 'ten_acme', token: 'biam_ses_alice' });
    expect(sessionFromRequest(withKey())).toBeNull();
  });

  it('refuses to start without a browser key, and over plain http beyond loopback', async () => {
    const { 'x-bc-session-key': _, ...keyless } = ours;
    expect((await post({ email: 'alice@acme', password: 'right' }, keyless)).status).toBe(400);
    process.env.ADMIN_ALLOWED_HOSTS = 'admin.example.com';
    try {
      expect((await post({ email: 'alice@acme', password: 'right' }, { ...ours, host: 'admin.example.com' })).status).toBe(403);
      expect((await post({ email: 'alice@acme', password: 'right' }, { ...ours, host: 'admin.example.com', 'x-forwarded-proto': 'https' })).status).toBe(200);
    } finally {
      delete process.env.ADMIN_ALLOWED_HOSTS;
    }
  });

  it('answers wrong credentials and unknown organizations with one generic message (no probing)', async () => {
    const response = await post({ email: 'alice@acme', password: 'wrong' });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Those credentials did not work.');
    expect(JSON.stringify(body)).not.toContain('alice@acme');
    lookupFails = true;
    const unknown = await post({ organization: 'nope', email: 'alice@acme', password: 'right' });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe('Those credentials did not work.');
  });

  it('throttles password attempts per account', async () => {
    for (let i = 0; i < 10; i++) expect((await post({ email: 'mallory@acme', password: `guess${i}` })).status).toBe(401);
    expect((await post({ email: 'mallory@acme', password: 'right' })).status).toBe(429);
    expect((await post({ email: 'alice@acme', password: 'right' })).status).toBe(200);
  });

  it('takes a second factor through a sealed, one-use challenge bound to the browser', async () => {
    mfa = true;
    const first = await post({ email: 'alice@acme', password: 'right' });
    const step = (await first.json()) as { step: string; challenge: string };
    expect(step.step).toBe('code');
    expect(step.challenge).not.toContain('chal_1');
    const wrong = await post({ challenge: step.challenge, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toBe('That code did not work.');
    // Another browser (another key) can't use it.
    expect((await post({ challenge: step.challenge, code: '123456' }, { ...ours, 'x-bc-session-key': 'other-key-'.padEnd(43, 'b') })).status).toBe(400);
    const second = await post({ challenge: step.challenge, code: '123456' });
    expect(second.status).toBe(200);
    expect(calls.find((c) => c.url.endsWith('auth/verifyMfa'))!.body).toMatchObject({ tenantId: 'ten_root', challenge: 'chal_1' });
    // Signed in once: the challenge is spent.
    expect((await post({ challenge: step.challenge, code: '123456' })).status).toBe(400);
  });

  it('spends a challenge after five wrong codes', async () => {
    mfa = true;
    const step = (await (await post({ email: 'alice@acme', password: 'right' })).json()) as { challenge: string };
    for (let i = 0; i < 5; i++) expect((await post({ challenge: step.challenge, code: `00000${i}` })).status).toBe(401);
    expect((await post({ challenge: step.challenge, code: '123456' })).status).toBe(400);
  });

  it('refuses a forged challenge, a session sealed as a challenge, and callers that are not the admin page', async () => {
    expect((await post({ challenge: 'forged.challenge.value', code: '123456' })).status).toBe(400);
    const signedIn = await post({ email: 'alice@acme', password: 'right' });
    const sealedSession = decodeURIComponent(cookieOf(signedIn).split('=')[1]!);
    expect((await post({ challenge: sealedSession, code: '123456' })).status).toBe(400);
    expect((await post({ email: 'a@b', password: 'right' }, { host: 'localhost:4200', 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ email: 'a@b', password: 'right' }, { ...ours, host: 'evil.example' })).status).toBe(403);
  });

  it('signs out at the identity service, revokes the cookie here and clears it', async () => {
    const signedIn = await post({ email: 'alice@acme', password: 'right' });
    const { DELETE } = await import('@/app/api/session/route');
    // Sign-out works from the cookie alone (ending a session is always safe), even behind a tossed "%" cookie.
    const out = await DELETE(new Request('http://localhost:4200/api/session', { method: 'DELETE', headers: { ...ours, cookie: `bc_admin_session=%; ${cookieOf(signedIn)}` } }));
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(await out.json()).toEqual({ ok: true });
    expect(calls.find((c) => c.url.endsWith('auth/signOut'))!.auth).toBe('Bearer biam_ses_alice');
    const { sessionFromRequest } = await import('@/lib/session');
    expect(sessionFromRequest(new Request('http://x/', { headers: { cookie: cookieOf(signedIn), 'x-bc-session-key': KEY } }))).toBeNull();
  });

  it('says so when the identity service could not end the session', async () => {
    const signedIn = await post({ email: 'alice@acme', password: 'right' });
    signOutFails = true;
    const { DELETE } = await import('@/app/api/session/route');
    const out = await DELETE(new Request('http://localhost:4200/api/session', { method: 'DELETE', headers: { ...ours, cookie: cookieOf(signedIn) } }));
    expect(((await out.json()) as { warning?: string }).warning).toMatch(/could not be reached/);
  });
});

describe('the proxy acting as the operator', () => {
  it('forwards the operator bearer and allows changes; without a session (or the key) changes stay refused', async () => {
    const signedIn = await post({ email: 'alice@acme', password: 'right' });
    const { POST } = await import('@/app/api/upstream/[...path]/route');
    const call = (headers: Record<string, string>) =>
      POST(new Request('http://localhost:4200/api/upstream/nodes/cordon', { method: 'POST', headers, body: '{"nodeId":"n-1"}' }), {
        params: Promise.resolve({ path: ['nodes', 'cordon'] }),
      });
    expect((await call(ours)).status).toBe(403);
    // The cookie replayed from elsewhere (curl, no Origin) without the browser key.
    const { 'x-bc-session-key': _, ...keyless } = ours;
    expect((await call({ ...keyless, cookie: cookieOf(signedIn) })).status).toBe(403);
    const response = await call({ ...ours, cookie: cookieOf(signedIn) });
    expect(response.status).toBe(200);
    const forwarded = calls.find((c) => c.url === 'http://compute.test/api/compute/nodes/cordon')!;
    expect(forwarded.auth).toBe('Bearer biam_ses_alice');
  });
});
