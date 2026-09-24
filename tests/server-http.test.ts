import { createServer, request as nodeRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComputeError, defineMethod, definePlugin, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, maxBodyBytes, serverVersion } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, NODE_ID, OTHER, acme, memoryLogger, options } from './support/server.js';

// The HTTP convention (PLAN.md §9.1): POST {basePath}/{group}/{method} with JSON and
// X-Better-Compute: 1, the {data}/{error} envelope, the 64 KiB cap, X-Request-Id, cookies only
// when accepted and same-origin, and the two GET routes.

const USER = 'token-acme-user-0123456789';
const OUTSIDER = 'token-other-user-0123456789';
const csrf = { 'content-type': 'application/json', 'x-better-compute': '1' };

/** Throws an INTERNAL_ERROR whose message must never reach the caller. */
const oops = definePlugin({
  id: 'oops',
  catalog: { actions: ['compute:oops:read'] },
  api: () => ({
    things: {
      boom: defineMethod<{ tenantId: string }, never>({
        action: 'compute:oops:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => input as { tenantId: string },
        async handler() {
          throw new ComputeError('INTERNAL_ERROR', 'pool exhausted at db-7.internal');
        },
      }),
    },
  }),
});

let db: SqlExecutor;
const iam = fakeIam();
const log = memoryLogger();
let compute: ReturnType<typeof build>;

function build(
  extra: { basePath?: string; acceptIamCookie?: boolean; database?: SqlExecutor } = {},
) {
  return betterCompute({
    ...options(extra.database ?? db, iam),
    ...(extra.basePath ? { basePath: extra.basePath } : {}),
    ...(extra.acceptIamCookie ? { acceptIamCookie: true } : {}),
    plugins: [acme, oops],
    log,
  });
}

beforeAll(async () => {
  db = pglite();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user' });
  iam.addCaller(OUTSIDER, { tenantId: OTHER });
  iam.allow({ token: USER });
  compute = build();
  await compute.initialize();
});
afterAll(async () => {
  await db.close();
});

interface Call {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

function http(path: string, init: Call = {}, base = '/api/compute'): Request {
  const method = init.method ?? 'POST';
  return new Request(`${BASE_URL}${base}/${path}`, {
    method,
    headers: { ...csrf, ...init.headers },
    body: method === 'GET' || method === 'HEAD' ? null : (init.body ?? '{}'),
  });
}

async function send(request: Request, target = compute) {
  const response = await target.handler(request);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? (JSON.parse(text) as Record<string, any>) : undefined,
  };
}

const post = (path: string, input: unknown = {}, headers: Record<string, string> = {}) =>
  send(http(path, { body: JSON.stringify(input), headers }));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the envelope', () => {
  it('answers {data} with hardened headers', async () => {
    const result = await post('system/version');
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      data: {
        name: 'better-compute',
        version: serverVersion,
        basePath: '/api/compute',
        protocol: { min: 1, max: 1 },
      },
    });
    expect(result.headers.get('content-type')).toMatch(/^application\/json/);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('answers {error} with the status of the ComputeError', async () => {
    const input = { tenantId: ACME, nodeId: NODE_ID };
    const cases: [Promise<Awaited<ReturnType<typeof post>>>, number, string][] = [
      [post('inventory/get', input), 401, 'UNAUTHENTICATED'],
      [post('inventory/get', input, bearer(OUTSIDER)), 403, 'ACCESS_DENIED'],
      [post('inventory/get', { tenantId: ACME }, bearer(USER)), 400, 'INVALID_INPUT'],
      [post('inventory/get', input, bearer(USER)), 404, 'NOT_FOUND'],
      [post('inventory/history', input, bearer(USER)), 501, 'NOT_IMPLEMENTED'],
      [post('inventory/get', input, bearer('token-nobody-0123456789')), 401, 'UNAUTHENTICATED'],
    ];
    for (const [pending, status, code] of cases) {
      const result = await pending;
      expect(result.status).toBe(status);
      expect(Object.keys(result.json!)).toEqual(['error']);
      expect(result.json!.error).toMatchObject({ code, message: expect.any(String) });
      expect(['code', 'message', 'details']).toEqual(
        expect.arrayContaining(Object.keys(result.json!.error)),
      );
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect((await post('inventory/history', input, bearer(USER))).json!.error).toEqual({
      code: 'NOT_IMPLEMENTED',
      message: 'inventory.history arrives in v0.2',
      details: { feature: 'inventory.history', phase: 'v0.2' },
    });
  });

  it('carries details, and retryAfterMs with a Retry-After header', async () => {
    const conflict = await post(
      'plugins/acme/widgets/fail',
      { tenantId: ACME, widgetId: 'w-http' },
      bearer(USER),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Widget changed meanwhile',
        details: { widgetId: 'w-http' },
      },
    });
    const limited = await post(
      'plugins/acme/widgets/limited',
      { tenantId: ACME, widgetId: 'w-http-limited' },
      bearer(USER),
    );
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Slow down', retryAfterMs: 20 },
    });
    expect(limited.headers.get('retry-after')).toBe('1');
  });

  it('never leaks the message of an unexpected error', async () => {
    const before = log.entries.length;
    for (const path of ['plugins/acme/widgets/crash', 'plugins/oops/things/boom']) {
      const result = await post(path, { tenantId: ACME, widgetId: 'w-1' }, bearer(USER));
      expect(result.status).toBe(500);
      expect(result.json).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      expect(result.text).not.toMatch(/db-7/);
    }
    const logged = log.entries.slice(before);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      level: 'error',
      fields: { route: 'plugins/acme/widgets/crash', requestId: expect.stringMatching(/^req_/) },
    });
    expect(String(logged[0]!.fields!.error)).toMatch(/db-7/);
  });

  it('answers null for a handler that returns nothing', async () => {
    const quiet = definePlugin({
      id: 'quiet',
      catalog: { actions: ['compute:quiet:read'] },
      api: () => ({
        things: {
          nothing: defineMethod<{ tenantId: string }, void>({
            action: 'compute:quiet:read',
            kind: 'read',
            resource: (input) => ({ type: 'tenant', id: input.tenantId }),
            validate: (input) => input as { tenantId: string },
            handler: async () => undefined,
          }),
        },
      }),
    });
    const target = betterCompute({ ...options(db, iam), plugins: [quiet] });
    const result = await send(
      http('plugins/quiet/things/nothing', {
        body: JSON.stringify({ tenantId: ACME }),
        headers: bearer(USER),
      }),
      target as never,
    );
    expect(result.json).toEqual({ data: null });
  });
});

describe('CSRF and credentials', () => {
  it('requires JSON and X-Better-Compute: 1 on every POST', async () => {
    for (const headers of [
      { 'x-better-compute': '' } as Record<string, string>,
      { 'x-better-compute': '2' },
      { 'x-better-compute': 'true' },
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      const result = await send(http('system/version', { headers }));
      expect(result.status).toBe(403);
      expect(result.json!.error.code).toBe('CSRF_REJECTED');
    }
    const missing = new Request(`${BASE_URL}/api/compute/system/version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect((await send(missing)).json!.error.code).toBe('CSRF_REJECTED');
    const charset = await send(
      http('system/version', { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }),
    );
    expect(charset.status).toBe(200);
  });

  it('ignores the IAM cookie by default', async () => {
    iam.reset();
    const cookie = { cookie: `better-iam.session=${USER}` };
    const whoami = await post('system/whoami', {}, cookie);
    expect(whoami.json).toEqual({ data: { authenticated: false } });
    const crossSite = await post(
      'system/whoami',
      {},
      { ...cookie, origin: 'https://evil.example' },
    );
    expect(crossSite.json).toEqual({ data: { authenticated: false } });
    const read = await post('inventory/get', { tenantId: ACME, nodeId: NODE_ID }, cookie);
    expect(read.json!.error.code).toBe('UNAUTHENTICATED');
    expect(iam.calls).toEqual([]);
  });

  it('accepts the IAM cookie, when enabled, only with this deployment exact Origin', async () => {
    const accepting = build({ acceptIamCookie: true });
    const cookie = { cookie: `better-iam.session=${USER}` };
    const without = await send(http('system/whoami', { headers: cookie }), accepting);
    expect(without.status).toBe(403);
    expect(without.json!.error.code).toBe('CSRF_REJECTED');
    for (const origin of [
      'https://evil.example',
      `${BASE_URL}:443x`,
      'http://compute.example.test',
      'null',
    ]) {
      const foreign = await send(
        http('system/whoami', { headers: { ...cookie, origin } }),
        accepting,
      );
      expect(foreign.status).toBe(403);
      expect(foreign.json!.error.code).toBe('UNTRUSTED_ORIGIN');
    }
    iam.reset();
    const same = await send(
      http('system/whoami', { headers: { ...cookie, origin: BASE_URL } }),
      accepting,
    );
    expect(same.json).toMatchObject({ data: { authenticated: true, tenantId: ACME } });
    expect(new Headers(iam.calls[0]!.credential!.headers).get('cookie')).toBe(cookie.cookie);
    // Bearer requests carry no ambient credential: a foreign Origin does not matter to them.
    const bearerCall = await send(
      http('system/whoami', { headers: { ...bearer(USER), origin: 'https://app.example' } }),
      accepting,
    );
    expect(bearerCall.json).toMatchObject({ data: { authenticated: true } });
  });

  it('passes the bearer and the effective request id to IAM', async () => {
    iam.reset();
    const result = await post('system/whoami', {}, { ...bearer(USER), 'x-request-id': 'trace-42' });
    expect(result.json).toMatchObject({ data: { authenticated: true, identityId: 'id-user' } });
    const headers = new Headers(iam.calls[0]!.credential!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${USER}`);
    expect(headers.get('x-request-id')).toBe('trace-42');
  });
});

describe('request bodies', () => {
  const padded = (size: number) => {
    const shell = '{"pad":""}';
    return `{"pad":"${'x'.repeat(size - shell.length)}"}`;
  };

  it('caps bodies at 64 KiB', async () => {
    expect(maxBodyBytes).toBe(65_536);
    const atLimit = await send(http('system/version', { body: padded(maxBodyBytes) }));
    expect(atLimit.status).toBe(400); // read in full, then refused by validation
    expect(atLimit.json!.error.message).toMatch(/Unknown field pad/);
    const over = await send(http('system/version', { body: padded(maxBodyBytes + 1) }));
    expect(over.status).toBe(413);
    expect(over.json!.error.code).toBe('PAYLOAD_TOO_LARGE');

    // Without a Content-Length the cap applies while reading.
    const chunk = new TextEncoder().encode(' '.repeat(16_384));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = new Request(`${BASE_URL}/api/compute/system/version`, {
      method: 'POST',
      headers: csrf,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.headers.get('content-length')).toBeNull();
    const result = await send(streamed);
    expect(result.status).toBe(413);
    expect(sent).toBeLessThan(8);
  });

  it('requires a JSON object; an empty body counts as {}', async () => {
    for (const [body, message] of [
      ['[]', 'The body must be a JSON object'],
      ['null', 'The body must be a JSON object'],
      ['"text"', 'The body must be a JSON object'],
      ['42', 'The body must be a JSON object'],
      ['{', 'The body is not valid JSON'],
      ['{"a":1}{}', 'The body is not valid JSON'],
    ] as const) {
      const result = await send(http('system/version', { body }));
      expect(result.status).toBe(400);
      expect(result.json!.error).toEqual({ code: 'INVALID_INPUT', message });
    }
    const invalidUtf8 = await send(
      http('system/version', { body: new Uint8Array([0x7b, 0xff, 0x7d]) }),
    );
    expect(invalidUtf8.json!.error.message).toBe('The body is not valid UTF-8');
    for (const body of ['', '  \n', '{}'])
      expect((await send(http('system/version', { body }))).status).toBe(200);
  });
});

describe('routes', () => {
  it('answers NOT_FOUND for anything the registry does not hold', async () => {
    for (const path of [
      'system/nope',
      'nope/version',
      'system',
      'system/version/extra',
      'system/version/',
      'system//version',
      'system%2Fversion',
      '__proto__/version',
      'system/__proto__',
      'system/constructor',
      'system/toString',
      'system/hasOwnProperty',
      'toString/valueOf',
      'plugins/acme/widgets',
      'plugins/acme/widgets/poke/extra',
      'plugins/nope/widgets/poke',
      'plugins/acme/__proto__/poke',
      'widgets/poke',
      'health',
      '.well-known/better-compute',
    ]) {
      const result = await send(http(path));
      expect(result.status, path).toBe(404);
      expect(result.json!.error.code).toBe('NOT_FOUND');
    }
    for (const url of [
      `${BASE_URL}/api/compute`,
      `${BASE_URL}/api/other/system/version`,
      `${BASE_URL}/`,
    ]) {
      const result = await send(new Request(url, { method: 'POST', headers: csrf, body: '{}' }));
      expect(result.status, url).toBe(404);
    }
  });

  it('serves GET only for /health and /.well-known/better-compute', async () => {
    const health = await send(http('health', { method: 'GET' }));
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({
      status: 'ok',
      database: 'ok',
      latencyMs: expect.any(Number),
    });
    const wellKnown = await send(http('.well-known/better-compute', { method: 'GET' }));
    expect(wellKnown.json).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/api/compute',
      protocol: { min: 1, max: 1 },
    });
    for (const path of ['system/version', 'metrics', 'watch', 'health/x']) {
      const result = await send(http(path, { method: 'GET' }));
      expect(result.status, path).toBe(404);
    }
  });

  it('answers 503 from /health when the store does not', async () => {
    const broken = build({
      database: {
        ...db,
        dialect: 'postgres',
        kind: 'pglite',
        query: () => Promise.reject(new Error('connection refused')),
        transaction: () => Promise.reject(new Error('connection refused')),
        migrate: () => Promise.reject(new Error('connection refused')),
        close: async () => {},
      },
    });
    const result = await send(http('health', { method: 'GET' }), broken);
    expect(result.status).toBe(503);
    expect(result.json).toEqual({
      status: 'unavailable',
      database: 'error',
      time: expect.any(Number),
    });
  });

  it('refuses other methods with METHOD_NOT_ALLOWED', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const response = await compute.handler(http('system/version', { method }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, POST');
      if (method !== 'HEAD')
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'METHOD_NOT_ALLOWED',
        );
    }
  });

  it('mounts under a custom basePath', async () => {
    const custom = build({ basePath: '/compute/v1' });
    expect(
      (await send(http('system/version', {}, '/compute/v1'), custom)).json!.data.basePath,
    ).toBe('/compute/v1');
    expect((await send(http('system/version'), custom)).status).toBe(404);
    expect(
      (await send(http('.well-known/better-compute', { method: 'GET' }, '/compute/v1'), custom))
        .json!.basePath,
    ).toBe('/compute/v1');
  });
});

describe('X-Request-Id', () => {
  it('echoes a valid id and replaces anything else', async () => {
    const valid = await post('system/version', {}, { 'x-request-id': 'Trace_1.2:3-4' });
    expect(valid.headers.get('x-request-id')).toBe('Trace_1.2:3-4');
    for (const value of ['has space', 'x'.repeat(129), 'semi;colon', '']) {
      const replaced = await post('system/version', {}, { 'x-request-id': value });
      expect(replaced.headers.get('x-request-id')).toMatch(/^req_[0-9a-z]{26}$/);
    }
    const absent = await post('system/version');
    expect(absent.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('is echoed on errors and GET routes too', async () => {
    const headers = { 'x-request-id': 'err-1' };
    expect((await post('nope/nope', {}, headers)).headers.get('x-request-id')).toBe('err-1');
    expect(
      (await send(http('health', { method: 'GET', headers }))).headers.get('x-request-id'),
    ).toBe('err-1');
    expect(
      (await send(http('system/version', { method: 'PUT', headers }))).headers.get('x-request-id'),
    ).toBe('err-1');
  });
});

describe('nodeHandler', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => void compute.nodeHandler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the same routes over node:http', async () => {
    const version = await fetch(`${origin}/api/compute/system/version`, {
      method: 'POST',
      headers: { ...csrf, 'x-request-id': 'node-1' },
      body: '{}',
    });
    expect(version.status).toBe(200);
    expect(version.headers.get('x-request-id')).toBe('node-1');
    expect(((await version.json()) as { data: { version: string } }).data.version).toBe(
      serverVersion,
    );
    const poke = await fetch(`${origin}/api/compute/plugins/acme/widgets/poke`, {
      method: 'POST',
      headers: { ...csrf, ...bearer(USER) },
      body: JSON.stringify({ tenantId: ACME, widgetId: 'w-node' }),
    });
    expect(((await poke.json()) as { data: { poked: string } }).data.poked).toBe('w-node');
    const health = await fetch(`${origin}/api/compute/health`);
    expect(((await health.json()) as { status: string }).status).toBe('ok');
    const csrfRefusal = await fetch(`${origin}/api/compute/system/version`, {
      method: 'POST',
      body: '{}',
    });
    expect(csrfRefusal.status).toBe(403);
  });

  it('refuses oversized bodies while reading and TRACE outright', async () => {
    const big = await fetch(`${origin}/api/compute/system/version`, {
      method: 'POST',
      headers: csrf,
      body: 'x'.repeat(maxBodyBytes + 1024),
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    const trace = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = nodeRequest(`${origin}/api/compute/health`, { method: 'TRACE' }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(trace.status).toBe(405);
    expect(JSON.parse(trace.body).error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
