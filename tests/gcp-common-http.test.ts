import { describe, expect, it, vi } from 'vitest';
import { isComputeError, type ErrorCode, type Logger } from '@better-compute/core';
import { defaultRetryAfterMs, googleClient, mapGoogleError } from '@better-compute/gcp-common';
import { mapGceError } from '@better-compute/provider-gcp';
import { FakeGoogle } from './support/gcp/fake-google.js';

// googleClient and mapGoogleError: the shared REST client every Google Cloud integration uses.

const S = (code: number, status: string, message = 'boom', details?: unknown[]) => ({
  error: { code, status, message, ...(details ? { details } : {}) },
});
const EI = (reason: string, metadata?: Record<string, string>) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com',
  ...(metadata ? { metadata } : {}),
});
const RI = (retryDelay: string) => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay,
});
const LEGACY = (code: number, reason: string, message = 'legacy boom') => ({
  error: { code, message, errors: [{ reason }] },
});
const none = new Headers();

describe('mapGoogleError', () => {
  const activationUrl = 'https://console.developers.google.com/apis/api/x/overview?project=1';
  const rows: [string, number, unknown, Headers, string, Record<string, unknown>][] = [
    ['NOT_FOUND', 404, S(404, 'NOT_FOUND'), none, 'NOT_FOUND', {}],
    ['ALREADY_EXISTS', 409, S(409, 'ALREADY_EXISTS'), none, 'CONFLICT', {}],
    ['ABORTED', 409, S(409, 'ABORTED'), none, 'CONFLICT', {}],
    ['FAILED_PRECONDITION', 400, S(400, 'FAILED_PRECONDITION'), none, 'INVALID_STATE', {}],
    ['INVALID_ARGUMENT', 400, S(400, 'INVALID_ARGUMENT'), none, 'INVALID_INPUT', {}],
    ['OUT_OF_RANGE', 400, S(400, 'OUT_OF_RANGE'), none, 'INVALID_INPUT', {}],
    ['CANCELLED', 499, S(499, 'CANCELLED'), none, 'UNAVAILABLE', {}],
    ['UNKNOWN', 500, S(500, 'UNKNOWN'), none, 'PROVIDER_ERROR', {}],
    ['UNAUTHENTICATED', 401, S(401, 'UNAUTHENTICATED'), none, 'UNAUTHENTICATED', {}],
    [
      'RESOURCE_EXHAUSTED rate',
      429,
      S(429, 'RESOURCE_EXHAUSTED', 'slow down', [RI('12s')]),
      none,
      'RATE_LIMITED',
      { retryAfterMs: 12000 },
    ],
    [
      'RetryInfo rounds a fractional delay up',
      429,
      S(429, 'RESOURCE_EXHAUSTED', 'slow down', [RI('0.5s')]),
      none,
      'RATE_LIMITED',
      { retryAfterMs: 500 },
    ],
    [
      'RESOURCE_EXHAUSTED with a quota reason is QUOTA_EXCEEDED (RESOURCE_QUOTA_EXCEEDED)',
      429,
      S(429, 'RESOURCE_EXHAUSTED', 'quota', [EI('RESOURCE_QUOTA_EXCEEDED')]),
      none,
      'QUOTA_EXCEEDED',
      { reason: 'RESOURCE_QUOTA_EXCEEDED' },
    ],
    [
      'RESOURCE_EXHAUSTED with a quota reason is QUOTA_EXCEEDED (QUOTA_EXCEEDED)',
      429,
      S(429, 'RESOURCE_EXHAUSTED', 'quota', [EI('QUOTA_EXCEEDED')]),
      none,
      'QUOTA_EXCEEDED',
      { reason: 'QUOTA_EXCEEDED' },
    ],
    [
      'Retry-After header',
      429,
      S(429, 'RESOURCE_EXHAUSTED'),
      new Headers({ 'retry-after': '7' }),
      'RATE_LIMITED',
      { retryAfterMs: 7000 },
    ],
    ['no hint', 429, S(429, 'RESOURCE_EXHAUSTED'), none, 'RATE_LIMITED', { retryAfterMs: 10000 }],
    [
      'SERVICE_DISABLED',
      403,
      S(403, 'PERMISSION_DENIED', 'API disabled', [EI('SERVICE_DISABLED', { activationUrl })]),
      none,
      'INVALID_CONFIG',
      { reason: 'SERVICE_DISABLED', activationUrl },
    ],
    [
      'VPC Service Controls',
      403,
      S(403, 'PERMISSION_DENIED', 'blocked', [EI('SECURITY_POLICY_VIOLATED')]),
      none,
      'ACCESS_DENIED',
      { reason: 'SECURITY_POLICY_VIOLATED' },
    ],
    ['PERMISSION_DENIED', 403, S(403, 'PERMISSION_DENIED'), none, 'ACCESS_DENIED', {}],
    ['UNIMPLEMENTED', 501, S(501, 'UNIMPLEMENTED'), none, 'UNSUPPORTED', {}],
    ['UNAVAILABLE', 503, S(503, 'UNAVAILABLE'), none, 'UNAVAILABLE', {}],
    ['INTERNAL', 500, S(500, 'INTERNAL'), none, 'UNAVAILABLE', {}],
    ['DEADLINE_EXCEEDED', 504, S(504, 'DEADLINE_EXCEEDED'), none, 'UNAVAILABLE', {}],
    ['an HTML 502 is UNAVAILABLE', 502, undefined, none, 'UNAVAILABLE', { reason: 'unknown' }],
    ['418', 418, undefined, none, 'PROVIDER_ERROR', {}],
  ];

  it.each(rows)('%s', (_name, status, body, headers, code, subset) => {
    const error = mapGoogleError(status, body, headers, 'GET /v1/x');
    expect(isComputeError(error)).toBe(true);
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject({ provider: 'gcp', status, ...subset });
  });

  it('takes the reason from ErrorInfo, then errors[0].reason, then status, then unknown', () => {
    const reason = (body: unknown) => mapGoogleError(400, body, none, 'x').details?.reason;
    expect(
      reason({
        error: { status: 'INVALID_ARGUMENT', errors: [{ reason: 'invalid' }], details: [EI('R')] },
      }),
    ).toBe('R');
    expect(reason({ error: { status: 'INVALID_ARGUMENT', errors: [{ reason: 'invalid' }] } })).toBe(
      'invalid',
    );
    expect(reason(S(400, 'INVALID_ARGUMENT'))).toBe('INVALID_ARGUMENT');
    expect(reason({})).toBe('unknown');
  });

  it("prefixes the message with what and uses Google's message, else the HTTP status", () => {
    expect(mapGoogleError(404, S(404, 'NOT_FOUND', 'no such key'), none, 'GET /v1/k').message).toBe(
      'GET /v1/k: no such key',
    );
    expect(mapGoogleError(502, undefined, none, 'GET /v1/k').message).toBe('GET /v1/k: HTTP 502');
  });

  it('exports the default retry delay', () => {
    expect(defaultRetryAfterMs).toBe(10_000);
  });

  // mapGoogleError reads Compute Engine's legacy error bodies the way provider-gcp's mapGceError
  // does, so a GCE failure maps the same through either. The sweep below crosses every status, every
  // legacy reason and the body shapes a proxy can produce, and requires an identical ComputeError
  // (code, details and message: both take the same `what` and build the message the same way)
  // everywhere except the cases listed in intendedDivergences, where mapGoogleError deliberately
  // differs. Each of those asserts both sides, so neither can drift unnoticed.
  describe('agrees with mapGceError on the legacy GCE shapes, except where it is meant to differ', () => {
    const statuses = [400, 401, 403, 404, 409, 418, 429, 499, 500, 501, 502, 503, 504];
    const legacyReasons = [
      'none',
      'alreadyExists',
      'resourceInUseByAnotherResource',
      'rateLimitExceeded',
      'userRateLimitExceeded',
      'resourceNotReady',
      'quotaExceeded',
      'forbidden',
      'invalid',
      'notFound',
    ];
    const shapes = [...legacyReasons, 'undefined', '{}'];
    const bodyOf = (shape: string, status: number): unknown => {
      if (shape === 'undefined') return undefined;
      if (shape === '{}') return {};
      if (shape === 'none') return { error: { code: status, message: 'legacy boom' } };
      return LEGACY(status, shape);
    };

    interface SweepDivergence {
      status: number;
      /** The sweep shapes (a legacy reason, `none`, `undefined` or `{}`) this row covers. */
      shapes: string[];
      google: ErrorCode;
      gce: ErrorCode;
      why: string;
    }
    interface BodyDivergence {
      name: string;
      status: number;
      body: unknown;
      google: { code: ErrorCode; details: Record<string, unknown> };
      gce: { code: ErrorCode; details: Record<string, unknown> };
      why: string;
    }
    const except = (...reasons: string[]) => shapes.filter((shape) => !reasons.includes(shape));

    const intendedDivergences: { sweep: SweepDivergence[]; bodies: BodyDivergence[] } = {
      sweep: [
        {
          status: 401,
          shapes,
          google: 'UNAUTHENTICATED',
          gce: 'PROVIDER_ERROR',
          why: 'A rejected credential is UNAUTHENTICATED for every Google API; mapGceError has no 401 branch.',
        },
        {
          status: 409,
          // Only alreadyExists (CONFLICT) and resourceInUseByAnotherResource (INVALID_STATE) agree.
          shapes: except('alreadyExists', 'resourceInUseByAnotherResource'),
          google: 'CONFLICT',
          gce: 'PROVIDER_ERROR',
          why: 'Any other 409 (ALREADY_EXISTS, ABORTED, a bare 409) is a conflict the caller can re-read and retry; mapGceError names only alreadyExists.',
        },
        {
          status: 499,
          shapes,
          google: 'UNAVAILABLE',
          gce: 'PROVIDER_ERROR',
          why: 'A 499 is the server cancelling the call (or a proxy giving up): the same call can succeed later.',
        },
        {
          status: 501,
          shapes,
          google: 'UNSUPPORTED',
          gce: 'UNAVAILABLE',
          why: 'UNIMPLEMENTED is permanent for this endpoint, so it is UNSUPPORTED, not a retryable 5xx.',
        },
      ],
      bodies: [
        {
          name: 'a 403 whose legacy reason is the rpc-era RATE_LIMIT_EXCEEDED',
          status: 403,
          body: LEGACY(403, 'RATE_LIMIT_EXCEEDED'),
          google: {
            code: 'RATE_LIMITED',
            details: { reason: 'RATE_LIMIT_EXCEEDED', retryAfterMs: defaultRetryAfterMs },
          },
          gce: { code: 'ACCESS_DENIED', details: { reason: 'RATE_LIMIT_EXCEEDED' } },
          why: 'RATE_LIMIT_EXCEEDED is the same rate limit as rateLimitExceeded, spelled the cross-API way; mapGceError knows only the camelCase spellings.',
        },
        {
          name: 'a 400 FAILED_PRECONDITION with a legacy invalid reason (mixed rpc and legacy shape)',
          status: 400,
          body: {
            error: {
              code: 400,
              status: 'FAILED_PRECONDITION',
              message: 'legacy boom',
              errors: [{ reason: 'invalid' }],
            },
          },
          google: { code: 'INVALID_STATE', details: { reason: 'invalid' } },
          gce: { code: 'INVALID_INPUT', details: { reason: 'invalid' } },
          why: 'The rpc status says the resource is in the wrong state, which the legacy reason alone cannot; mapGceError never reads error.status.',
        },
        {
          name: 'a 403 with legacy quotaExceeded and an ErrorInfo RATE_LIMIT_EXCEEDED (mixed shape)',
          status: 403,
          body: {
            error: {
              code: 403,
              message: 'legacy boom',
              errors: [{ reason: 'quotaExceeded' }],
              details: [EI('RATE_LIMIT_EXCEEDED')],
            },
          },
          google: {
            code: 'RATE_LIMITED',
            details: { reason: 'RATE_LIMIT_EXCEEDED', retryAfterMs: defaultRetryAfterMs },
          },
          gce: { code: 'QUOTA_EXCEEDED', details: { reason: 'quotaExceeded' } },
          why: 'ErrorInfo is the more precise reason and wins over errors[0]; mapGceError reads only the legacy list.',
        },
      ],
    };

    const sweep = statuses.flatMap((status) =>
      shapes.flatMap((shape) => [false, true].map((retryAfter) => ({ status, shape, retryAfter }))),
    );
    const divergenceOf = (status: number, shape: string) =>
      intendedDivergences.sweep.find((row) => row.status === status && row.shapes.includes(shape));

    it.each(sweep)('$status $shape retry-after=$retryAfter', ({ status, shape, retryAfter }) => {
      const body = bodyOf(shape, status);
      const headers = new Headers(retryAfter ? { 'retry-after': '7' } : {});
      const google = mapGoogleError(status, body, headers, 'GET /x');
      const gce = mapGceError(status, body, headers, 'GET /x');
      const row = divergenceOf(status, shape);
      if (row) {
        expect(google.code, row.why).toBe(row.google);
        expect(gce.code, row.why).toBe(row.gce);
      } else {
        expect(google.code).toBe(gce.code);
      }
      // Divergent rows included, everything but the code agrees: the same details and message.
      expect(google.details).toEqual(gce.details);
      expect(google.message).toBe(gce.message);
    });

    it('a rate-limited sweep case honours Retry-After (the sweep ran the header both ways)', () => {
      const google = mapGoogleError(
        429,
        bodyOf('none', 429),
        new Headers({ 'retry-after': '7' }),
        'x',
      );
      expect(google.details?.retryAfterMs).toBe(7000);
    });

    it.each(intendedDivergences.bodies)('intended divergence: $name', (row) => {
      const google = mapGoogleError(row.status, row.body, none, 'GET /x');
      const gce = mapGceError(row.status, row.body, none, 'GET /x');
      expect(google.code, row.why).toBe(row.google.code);
      expect(google.details).toEqual({
        provider: 'gcp',
        status: row.status,
        ...row.google.details,
      });
      expect(gce.code, row.why).toBe(row.gce.code);
      expect(gce.details).toEqual({ provider: 'gcp', status: row.status, ...row.gce.details });
      expect(google.message).toBe(gce.message);
    });
  });
});

function spyLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Record<
    keyof Logger,
    unknown
  >;
}

describe('googleClient', () => {
  const signal = () => new AbortController().signal;
  const base = 'https://example.googleapis.com/v1';

  it('sends the bearer, accept and JSON content type, and the quota project', async () => {
    const fake = new FakeGoogle({ token: 'secret-1' }).route(
      'POST',
      '/v1/things/{id}',
      (request, params) => ({ body: { id: params.id, echoed: request.body } }),
    );
    const client = googleClient({
      fetch: fake.fetch,
      tokens: fake.tokens(),
      quotaProject: 'billing-1',
    });
    const result = await client.request<{ id: string; echoed: unknown }>({
      method: 'POST',
      url: `${base}/things/abc`,
      body: { a: 1 },
      signal: signal(),
    });
    expect(result).toEqual({ id: 'abc', echoed: { a: 1 } });
    const [sent] = fake.requests;
    expect(sent!.method).toBe('POST');
    expect(sent!.headers.get('authorization')).toBe('Bearer secret-1');
    expect(sent!.headers.get('accept')).toBe('application/json');
    expect(sent!.headers.get('content-type')).toBe('application/json');
    expect(sent!.headers.get('x-goog-user-project')).toBe('billing-1');
  });

  it('omits content-type without a body and the quota project header without a project', async () => {
    const fake = new FakeGoogle().route('GET', '/v1/ping', () => ({ body: {} }));
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    await client.request({ method: 'GET', url: `${base}/ping`, signal: signal() });
    expect(fake.requests[0]!.headers.get('content-type')).toBeNull();
    expect(fake.requests[0]!.headers.get('x-goog-user-project')).toBeNull();
  });

  it('encodes repeated query values', async () => {
    const fake = new FakeGoogle().route('GET', '/v1/things', () => ({ body: {} }));
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    await client.request({
      method: 'GET',
      url: `${base}/things`,
      query: { fields: ['a', 'b'], pageSize: '5' },
      signal: signal(),
    });
    expect(fake.requests[0]!.url.search).toBe('?fields=a&fields=b&pageSize=5');
  });

  it('maps an error reply through mapGoogleError with the default what', async () => {
    const fake = new FakeGoogle().route('GET', '/v1/things/{id}', () =>
      FakeGoogle.rpcError(404, 'NOT_FOUND', 'no such thing'),
    );
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    const error = await client
      .request({ method: 'GET', url: `${base}/things/x?secret=1`, signal: signal() })
      .catch((e: unknown) => e);
    expect(isComputeError(error) && error.code).toBe('NOT_FOUND');
    expect((error as Error).message).toBe('GET /v1/things/x: no such thing');
  });

  it('uses the what option as the message prefix', async () => {
    const fake = new FakeGoogle();
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    const error = await client
      .request({ method: 'GET', url: `${base}/none`, what: 'read the key', signal: signal() })
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^read the key: /);
  });

  it('an unreachable host is UNAVAILABLE with reason network', async () => {
    const client = googleClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      tokens: new FakeGoogle().tokens(),
    });
    const error = await client
      .request({ method: 'GET', url: `${base}/x`, signal: signal() })
      .catch((e: unknown) => e);
    expect(isComputeError(error) && error.code).toBe('UNAVAILABLE');
    expect((error as { details?: unknown }).details).toMatchObject({
      provider: 'gcp',
      status: 0,
      reason: 'network',
    });
  });

  it('an aborted signal rethrows the abort, not UNAVAILABLE', async () => {
    const fake = new FakeGoogle().route('GET', '/v1/x', () => ({ body: {} }));
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(
      client.request({ method: 'GET', url: `${base}/x`, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it('an empty 200 body is {}', async () => {
    const fake = new FakeGoogle().route('DELETE', '/v1/x', () => ({ raw: '' }));
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    await expect(
      client.request({ method: 'DELETE', url: `${base}/x`, signal: signal() }),
    ).resolves.toEqual({});
  });

  it('a non-JSON error page is UNAVAILABLE with reason unknown', async () => {
    const fake = new FakeGoogle().failNext({ status: 502, raw: '<html>Bad Gateway</html>' });
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
    const error = await client
      .request({ method: 'GET', url: `${base}/x`, signal: signal() })
      .catch((e: unknown) => e);
    expect(isComputeError(error) && error.code).toBe('UNAVAILABLE');
    expect((error as { details?: unknown }).details).toMatchObject({
      reason: 'unknown',
      status: 502,
    });
  });

  it('a wrong bearer is UNAUTHENTICATED', async () => {
    const fake = new FakeGoogle({ token: 'right' });
    const client = googleClient({ fetch: fake.fetch, tokens: { token: async () => 'wrong' } });
    const error = await client
      .request({ method: 'GET', url: `${base}/x`, signal: signal() })
      .catch((e: unknown) => e);
    expect(isComputeError(error) && error.code).toBe('UNAUTHENTICATED');
  });

  it('never logs the bearer', async () => {
    const token = 'ya29.super-secret-token';
    const fake = new FakeGoogle({ token })
      .route('GET', '/v1/ok', () => ({ body: { ok: true } }))
      .route('GET', '/v1/forbidden', () => FakeGoogle.rpcError(403, 'PERMISSION_DENIED', 'no'));
    const log = spyLogger();
    const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens(), log });
    await client.request({ method: 'GET', url: `${base}/ok?key=1`, signal: signal() });
    await client
      .request({ method: 'GET', url: `${base}/forbidden`, signal: signal() })
      .catch(() => undefined);
    const down = googleClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      tokens: fake.tokens(),
      log,
    });
    await down
      .request({ method: 'GET', url: `${base}/ok?key=1`, signal: signal() })
      .catch(() => undefined);
    const logged = JSON.stringify([
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    expect(log.debug).toHaveBeenCalledWith('google.request', {
      method: 'GET',
      host: 'example.googleapis.com',
      path: '/v1/ok',
      status: 200,
    });
    expect(log.warn).toHaveBeenCalledWith('google.unreachable', {
      method: 'GET',
      host: 'example.googleapis.com',
      path: '/v1/ok',
    });
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('key=1');
  });
});
