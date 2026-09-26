import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callerAllowed, isReadMethod, safeMessage, upstreamConfig } from '@/lib/upstream';
import { POST } from '@/app/api/upstream/[...path]/route';
import { GET as status } from '@/app/api/upstream/status/route';
import { decodeDashboard } from '@/components/widgets/layout';
import { linkKind } from '@/components/overview/notes-widget';

// The admin's live proxy holds a server credential, so its refusals are the security boundary: only the admin's
// own page (Host/Origin allowlist + CSRF header) may call it, and only read methods are forwarded until
// operator sign-in exists. Plus the untrusted-input paths the review found: share links and note links.

const env = { ...process.env };
beforeEach(() => {
  process.env.ADMIN_COMPUTE_URL = 'http://127.0.0.1:9/api/compute';
  process.env.ADMIN_COMPUTE_TOKEN = 'biam_ses_secret_value';
  delete process.env.ADMIN_ALLOWED_HOSTS;
});
afterEach(() => {
  process.env = { ...env };
});

const call = (path: string, headers: Record<string, string>, body = '{}') =>
  POST(new Request(`http://localhost:4200/api/upstream/${path}`, { method: 'POST', headers, body }), {
    params: Promise.resolve({ path: path.split('/') }),
  });
const ours = { host: 'localhost:4200', 'x-better-compute': '1', 'content-type': 'application/json' };

describe('callerAllowed', () => {
  const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
  it('allows loopback names and refuses other hosts (DNS rebinding)', () => {
    expect(callerAllowed(req({ host: 'localhost:4200' }))).toBe(true);
    expect(callerAllowed(req({ host: '127.0.0.1:4200' }))).toBe(true);
    expect(callerAllowed(req({ host: 'admin.localhost:4200' }))).toBe(true);
    expect(callerAllowed(req({ host: 'evil.example:4200' }))).toBe(false);
    expect(callerAllowed(req({ host: '10.0.0.5:4200' }))).toBe(false);
    expect(callerAllowed(req({}))).toBe(false);
  });
  it('refuses a cross-origin Origin', () => {
    expect(callerAllowed(req({ host: 'localhost:4200', origin: 'http://localhost:4200' }))).toBe(true);
    expect(callerAllowed(req({ host: 'localhost:4200', origin: 'https://evil.example' }))).toBe(false);
    expect(callerAllowed(req({ host: 'localhost:4200', origin: 'null' }))).toBe(false);
  });
  it('allows names from ADMIN_ALLOWED_HOSTS', () => {
    process.env.ADMIN_ALLOWED_HOSTS = 'admin.example.com';
    expect(callerAllowed(req({ host: 'admin.example.com' }))).toBe(true);
    expect(callerAllowed(req({ host: 'other.example.com' }))).toBe(false);
  });
});

describe('isReadMethod', () => {
  it('forwards getters and listings only', () => {
    for (const path of ['capacity/summary', 'nodes/list', 'nodes/get', 'system/version', 'nodes/listSshCerts', 'capacity/timeline', 'usage/list']) expect(isReadMethod(path), path).toBe(true);
    for (const path of ['nodes/cordon', 'nodes/drain', 'nodes/delete', 'reservations/create', 'reservations/cancel', 'quotas/set', 'metal/wipe', 'nodes/getaway', 'getx'])
      expect(isReadMethod(path), path).toBe(false);
  });
  it('refuses names that read and write, but not words that merely start like a verb', () => {
    for (const path of ['keys/getOrCreate', 'jobs/listAndPrune', 'locks/findAndLock', 'nodes/getThenDrain', 'certs/getRotate', 'tokens/getIssue'])
      expect(isReadMethod(path), path).toBe(false);
    for (const path of ['nodes/listRunning', 'org/getSettings', 'capacity/listBookings', 'nodes/getLocks', 'tickets/listIssues', 'nodes/getOrphans', 'reservations/getReservation'])
      expect(isReadMethod(path), path).toBe(true);
  });
  it('refuses anything that is not a method path', () => {
    for (const path of ['../health', 'nodes/../list', 'nodes/list%2F..', 'nodes\\list', 'nodes/list?x=1', '']) expect(isReadMethod(path), path).toBe(false);
  });
});

describe('upstreamConfig', () => {
  it('refuses credentials, queries and fragments in the URL and trims it', () => {
    expect(upstreamConfig()?.url).toBe('http://127.0.0.1:9/api/compute');
    process.env.ADMIN_COMPUTE_URL = 'http://user:pass@127.0.0.1:9/api/compute';
    expect(upstreamConfig()).toBeNull();
    process.env.ADMIN_COMPUTE_URL = 'http://127.0.0.1:9/api/compute?token=x';
    expect(upstreamConfig()).toBeNull();
    process.env.ADMIN_COMPUTE_URL = 'file:///etc/passwd';
    expect(upstreamConfig()).toBeNull();
    process.env.ADMIN_COMPUTE_URL = 'http://127.0.0.1:9/api/compute///';
    expect(upstreamConfig()?.url).toBe('http://127.0.0.1:9/api/compute');
  });
  it('strips URLs from error messages', () => {
    expect(safeMessage(new Error('fetch failed for http://user:pw@host/x\nstack'))).toBe('fetch failed for <url>');
  });
});

describe('the proxy route', () => {
  it('refuses a caller without the header or from another host', async () => {
    expect((await call('nodes/list', { host: 'localhost:4200' })).status).toBe(403);
    expect((await call('nodes/list', { ...ours, host: 'evil.example:4200' })).status).toBe(403);
    expect((await call('nodes/list', { ...ours, origin: 'https://evil.example' })).status).toBe(403);
  });
  it('refuses mutations while there is no operator sign-in', async () => {
    const response = await call('nodes/cordon', ours, '{"nodeId":"n-1"}');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('READ_ONLY');
  });
  it('refuses non-method paths and oversized bodies', async () => {
    expect((await call('nodes/..', ours)).status).toBe(400);
    expect((await call('nodes/list', ours, 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
  });
  it('answers 502 without leaking the upstream URL or token when it is unreachable', async () => {
    const response = await call('nodes/list', ours);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('127.0.0.1:9');
    expect(text).not.toContain('biam_ses_secret_value');
  });
  it('says 503 when nothing is configured', async () => {
    delete process.env.ADMIN_COMPUTE_URL;
    expect((await call('nodes/list', ours)).status).toBe(503);
  });
  it('status never returns the token', async () => {
    const response = await status(new Request('http://localhost:4200/api/upstream/status', { headers: { host: 'localhost:4200' } }));
    const text = await response.text();
    expect(text).not.toContain('biam_ses_secret_value');
    expect(JSON.parse(text)).toMatchObject({ configured: true, authenticated: true, ok: false });
    expect((await status(new Request('http://x/', { headers: { host: 'evil.example' } }))).status).toBe(403);
  });
});

describe('untrusted inputs', () => {
  it('share links regenerate duplicate keys and skip junk entries', () => {
    const raw = btoa(JSON.stringify({ v: 1, name: 'x', items: [null, 7, { key: 'a', widget: 'overview.kpis', w: 4, h: 2 }, { key: 'a', widget: 'overview.kpis', w: 4, h: 2 }] }));
    const decoded = decodeDashboard(raw)!;
    expect(decoded.items).toHaveLength(2);
    expect(new Set(decoded.items.map((i) => i.key)).size).toBe(2);
  });
  it('note links stay in the app or go to http(s); nothing else becomes a link', () => {
    expect(linkKind('/nodes')).toBe('internal');
    expect(linkKind('https://runbook.example/x')).toBe('external');
    for (const href of ['//evil.example', '/\\evil.example', 'javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'ftp://x', 'nodes']) expect(linkKind(href), href).toBeNull();
  });
});
