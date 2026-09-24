import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ComputeClientError, createComputeClient } from '@better-compute/client';
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, serverVersion } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, NODE_ID, acme, options } from './support/server.js';

// The typed client against a real server: `fetch` hands each request to `compute.handler`.

const USER = 'biam_ses_acmeuser0123456789';
const iam = fakeIam();
let db: SqlExecutor;
let compute: ReturnType<typeof build>;

function build() {
  return betterCompute({ ...options(db, iam), plugins: [acme] });
}

beforeAll(async () => {
  db = pglite();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user' });
  iam.allow({ token: USER });
  compute = build();
  await compute.initialize();
});
afterAll(async () => {
  await db.close();
});

type Compute = ReturnType<typeof build>;

/** A fetch that hands requests to the server and remembers them. */
function shim(respond?: (request: Request) => Promise<Response>) {
  const seen: { url: string; init: RequestInit; headers: Headers }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: String(input), init: init!, headers: new Headers(init!.headers) });
    return respond ? respond(request) : compute.handler(request);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen, calls: fetch };
}

function client(extra: Parameters<typeof createComputeClient>[0] = {}) {
  const transport = shim();
  return {
    ...transport,
    client: createComputeClient<Compute>({ baseURL: BASE_URL, fetch: transport.fetch, ...extra }),
  };
}

async function failure(pending: Promise<unknown>): Promise<ComputeClientError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeClientError);
    return error as ComputeClientError;
  }
  throw new Error('Expected a ComputeClientError');
}

describe('createComputeClient()', () => {
  it('posts JSON with the CSRF header, no ambient credentials and no redirects', async () => {
    const { client: api, seen } = client();
    expect(await api.system.version()).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/api/compute',
      protocol: { min: 1, max: 1 },
    });
    const [call] = seen;
    expect(call!.url).toBe(`${BASE_URL}/api/compute/system/version`);
    expect(call!.init).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(call!.headers.get('content-type')).toBe('application/json');
    expect(call!.headers.get('x-better-compute')).toBe('1');
    expect(call!.headers.has('authorization')).toBe(false);
  });

  it('reads the bearer token at every request', async () => {
    let token: string | undefined = USER;
    const { client: api, seen } = client({ token: async () => token });
    expect(await api.system.whoami()).toMatchObject({ authenticated: true, tenantId: ACME });
    token = undefined;
    expect(await api.system.whoami()).toEqual({ authenticated: false });
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${USER}`);
    expect(seen[1]!.headers.has('authorization')).toBe(false);
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const withJwt = client({ token: jwt });
    await withJwt.client.system.version();
    expect(withJwt.seen[0]!.headers.get('authorization')).toBe(`Bearer ${jwt}`);
  });

  it('refuses malformed tokens before any request', async () => {
    for (const token of [
      'has spaces in it',
      'short',
      `${'a'.repeat(600)}`,
      'Bearer abcdefghijklmnopq',
    ]) {
      const { client: api, calls } = client({ token });
      const error = await failure(api.system.version());
      expect(error).toMatchObject({ code: 'INVALID_TOKEN', status: 0 });
      expect(calls).not.toHaveBeenCalled();
    }
  });

  it('reaches plugin methods under plugins[id] and any route through $request', async () => {
    const { client: api, seen } = client({ token: USER });
    expect(
      await api.plugins.acme.widgets.poke({ tenantId: ACME, widgetId: 'w-client' }),
    ).toMatchObject({ poked: 'w-client' });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/compute/plugins/acme/widgets/poke`);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      tenantId: ACME,
      widgetId: 'w-client',
    });
    expect(
      await api.$request<{ exists: boolean }>('plugins/acme/widgets/get', {
        tenantId: ACME,
        widgetId: 'w-client',
      }),
    ).toEqual({
      widgetId: 'w-client',
      exists: true,
    });
    for (const path of [
      '',
      '../system/version',
      'system//version',
      'system/__proto__',
      '/system/version',
    ]) {
      const error = await failure(api.$request(path));
      expect(error).toMatchObject({ code: 'INVALID_PATH', status: 0 });
    }
    expect(seen).toHaveLength(2);
  });

  it('raises ComputeClientError with the code, status, details and request id', async () => {
    const { client: api } = client({ token: USER });
    const error = await failure(
      api.plugins.acme.widgets.fail({ tenantId: ACME, widgetId: 'w-client-error' }),
    );
    expect(error).toMatchObject({
      name: 'ComputeClientError',
      code: 'CONFLICT',
      message: 'Widget changed meanwhile',
      status: 409,
      details: { widgetId: 'w-client-error' },
      requestId: expect.stringMatching(/^req_/),
    });
  });

  it('calls onUnauthenticated once for UNAUTHENTICATED, and never lets it change the error', async () => {
    const onUnauthenticated = vi.fn(() => {
      throw new Error('hook failed');
    });
    const { client: api } = client({ onUnauthenticated });
    const error = await failure(api.inventory.get({ tenantId: ACME, nodeId: NODE_ID }));
    expect(error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
    expect(onUnauthenticated).toHaveBeenCalledWith(error);
    const denied = client({ token: USER, onUnauthenticated });
    iam.deny({ action: 'compute:nodes:read' });
    // An earlier test's allow is cached for 10 s; the IAM bridge drops it on the policy event.
    compute.caches.dropDecisions();
    expect(
      (await failure(denied.client.inventory.get({ tenantId: ACME, nodeId: NODE_ID }))).code,
    ).toBe('ACCESS_DENIED');
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('retries RATE_LIMITED once when asked and the wait is short enough', async () => {
    const retrying = client({ token: USER, retryRateLimited: true });
    expect(
      await retrying.client.plugins.acme.widgets.limited({ tenantId: ACME, widgetId: 'w-retry' }),
    ).toEqual({ widgetId: 'w-retry' });
    expect(retrying.calls).toHaveBeenCalledTimes(2);

    const plain = client({ token: USER });
    const error = await failure(
      plain.client.plugins.acme.widgets.limited({ tenantId: ACME, widgetId: 'w-plain' }),
    );
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterMs: 20 });
    expect(plain.calls).toHaveBeenCalledOnce();

    const impatient = client({ token: USER, retryRateLimited: { maxWaitMs: 10 } });
    await failure(
      impatient.client.plugins.acme.widgets.limited({ tenantId: ACME, widgetId: 'w-short' }),
    );
    expect(impatient.calls).toHaveBeenCalledOnce();

    const aborting = client({ token: USER, retryRateLimited: true });
    const controller = new AbortController();
    const pending = aborting.client.plugins.acme.widgets.limited(
      { tenantId: ACME, widgetId: 'w-abort' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('user gave up')), 1);
    await expect(pending).rejects.toThrow('user gave up');
    expect(aborting.calls).toHaveBeenCalledOnce();
  });

  it('sends X-Request-Id when asked and reports it on errors', async () => {
    const { client: api, seen } = client({ requestId: true });
    const error = await failure(api.inventory.get({ tenantId: ACME, nodeId: NODE_ID }));
    const sent = seen[0]!.headers.get('x-request-id');
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.requestId).toBe(sent);
    const custom = client({ requestId: () => 'trace-7' });
    await custom.client.system.version();
    expect(custom.seen[0]!.headers.get('x-request-id')).toBe('trace-7');
    const bad = client({ requestId: () => 'not ok' });
    expect(await failure(bad.client.system.version())).toMatchObject({
      code: 'INVALID_CONFIG',
      status: 0,
    });
    expect(bad.calls).not.toHaveBeenCalled();
  });

  it('merges configured and per-call headers but keeps the CSRF headers invariant', async () => {
    const { client: api, seen } = client({
      headers: async () => ({
        'x-better-compute': '0',
        'content-type': 'text/plain',
        'x-trace': 'a',
      }),
    });
    await api.system.version({}, { headers: { 'x-trace': 'b', 'x-better-compute': 'no' } });
    expect(seen[0]!.headers.get('x-better-compute')).toBe('1');
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
    expect(seen[0]!.headers.get('x-trace')).toBe('b');
  });

  it('sends cookies only with credentials same-origin or include', async () => {
    const { client: api, seen } = client({ credentials: 'same-origin' });
    await api.system.version();
    expect(seen[0]!.init.credentials).toBe('same-origin');
    expect(() =>
      createComputeClient({ baseURL: BASE_URL, credentials: 'always' as never }),
    ).toThrow(/credentials/);
  });

  it('honours a custom basePath', async () => {
    const custom = betterCompute({ ...options(db, iam), basePath: '/compute/v1' });
    const transport = shim((request) => custom.handler(request));
    const api = createComputeClient<typeof custom>({
      baseURL: `${BASE_URL}/ignored/path`,
      basePath: '/compute/v1',
      fetch: transport.fetch,
    });
    expect((await api.system.version()).basePath).toBe('/compute/v1');
    expect(transport.seen[0]!.url).toBe(`${BASE_URL}/compute/v1/system/version`);
  });

  it('validates its options', () => {
    const invalid = (options: Parameters<typeof createComputeClient>[0]) => {
      try {
        createComputeClient(options);
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_CONFIG', status: 0 });
        return;
      }
      throw new Error('Expected INVALID_CONFIG');
    };
    invalid({});
    invalid({ baseURL: 'not a url' });
    invalid({ baseURL: 'ftp://files.example' });
    invalid({ baseURL: 'https://user:secret@compute.example' });
    invalid({ baseURL: 'https://compute.example/?q=1' });
    invalid({ baseURL: BASE_URL, basePath: 'api/compute' });
    invalid({ baseURL: BASE_URL, basePath: '/api/compute/' });
  });

  it('never routes reserved names and is not thenable', async () => {
    const { client: api, calls } = client();
    const loose = api as unknown as Record<string | symbol, unknown>;
    for (const key of [
      'then',
      'catch',
      'finally',
      'toJSON',
      'constructor',
      '__proto__',
      'prototype',
      '9lives',
      'with space',
    ])
      expect(loose[key], key).toBeUndefined();
    expect(loose[Symbol.iterator]).toBeUndefined();
    expect(Object.prototype.toString.call(api)).toBe('[object BetterComputeClient]');
    expect(await api).toBe(api);
    const group = api.system as unknown as Record<string, unknown>;
    expect(group.then).toBeUndefined();
    expect(typeof group.anything).toBe('function');
    expect((api.plugins as unknown as Record<string, unknown>).then).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it('refuses responses that are not the envelope', async () => {
    const answers: [Response, string, number][] = [
      [new Response('<html>oops</html>', { status: 502 }), 'INVALID_RESPONSE', 502],
      [Response.json([1, 2]), 'INVALID_RESPONSE', 200],
      [Response.json({ result: 1 }), 'INVALID_RESPONSE', 200],
      [Response.json({ error: 'nope' }, { status: 500 }), 'INVALID_RESPONSE', 500],
      [Response.json({}, { status: 502 }), 'HTTP_ERROR', 502],
    ];
    for (const [response, code, status] of answers) {
      const transport = shim(async () => response);
      const api = createComputeClient<Compute>({ baseURL: BASE_URL, fetch: transport.fetch });
      expect(await failure(api.system.version())).toMatchObject({ code, status });
    }
    const limited = shim(async () =>
      Response.json(
        { error: { code: 'RATE_LIMITED', message: 'Later' } },
        { status: 429, headers: { 'retry-after': '3' } },
      ),
    );
    const api = createComputeClient<Compute>({ baseURL: BASE_URL, fetch: limited.fetch });
    expect(await failure(api.system.version())).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 3000,
    });
  });
});
