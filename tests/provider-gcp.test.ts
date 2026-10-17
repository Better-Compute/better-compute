import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type Logger } from '@better-compute/core';
import {
  cachedTokenSource,
  gceClient,
  impersonatedTokenSource,
  instanceName,
  labelValue,
  machineId,
  metadataTokenSource,
  offerId,
  parseMachineId,
  parseOfferId,
  requestIdFor,
  serviceAccountTokenSource,
  type TokenSource,
} from '@better-compute/provider-gcp';
import { GceEmulator } from './support/gce-emulator.js';

// provider-gcp against an in-memory emulator of the Compute Engine endpoints it uses, plugged in
// through the `fetch` option.

const endpoint = 'https://compute.googleapis.com/compute/v1';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@p.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

function context(clock = manualClock(1_000_000)) {
  return { signal: new AbortController().signal, clock };
}

describe('auth & client', () => {
  it('service-account key mints a bearer token and caches it until expiry', async () => {
    const emu = new GceEmulator();
    const clock = manualClock(1_000_000);
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const client = gceClient({ fetch: emu.fetch, endpoint, projectId: 'p', tokens, clock });
    const call = () =>
      client.request('GET', '/zones/us-central1-a/instances', {
        signal: new AbortController().signal,
      });
    await call();
    await call();
    const posts = () =>
      emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/token');
    expect(posts()).toHaveLength(1);
    expect(emu.jwtClaims[0]).toMatchObject({
      iss: 'sa@p.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    // The compute requests carry the minted token.
    const compute = emu.requests.filter((r) => r.url.hostname === 'compute.googleapis.com');
    expect(
      compute.every((r) => r.headers.get('authorization') === `Bearer ${emu.mintedTokens[0]}`),
    ).toBe(true);
    clock.advance(3_600_000);
    await call();
    expect(posts()).toHaveLength(2);
  });

  it('refreshes a minute before expiry and shares one in-flight mint', async () => {
    const emu = new GceEmulator();
    const clock = manualClock(0);
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const get = () => tokens.token({ signal: new AbortController().signal, clock });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(emu.mintedTokens).toHaveLength(1);
    clock.advance(3_539_000);
    expect(await get()).toBe(a);
    clock.advance(2_000);
    expect(await get()).not.toBe(a);
  });

  it('metadata token source sends Metadata-Flavor: Google', async () => {
    const emu = new GceEmulator();
    const tokens = metadataTokenSource({ fetch: emu.fetch });
    const token = await tokens.token(context());
    expect(token).toBe(emu.mintedTokens[0]);
    expect(emu.metadataFlavors).toEqual(['Google']);
    expect(emu.requests[0]!.url.hostname).toBe('metadata.google.internal');
  });

  it("impersonation exchanges the base token for the target's", async () => {
    const emu = new GceEmulator();
    const base = metadataTokenSource({ fetch: emu.fetch });
    const tokens = impersonatedTokenSource(base, 'sa@p.iam.gserviceaccount.com', {
      fetch: emu.fetch,
    });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
    });
    await client.request('GET', '/zones/us-central1-a/instances', {
      signal: new AbortController().signal,
    });
    const exchange = emu.requests.find((r) => r.url.hostname === 'iamcredentials.googleapis.com')!;
    expect(exchange.method).toBe('POST');
    expect(exchange.url.pathname).toBe(
      '/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken',
    );
    expect(exchange.headers.get('authorization')).toBe(`Bearer ${emu.mintedTokens[0]}`);
    expect(exchange.body).toMatchObject({
      scope: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const compute = emu.requests.find((r) => r.url.hostname === 'compute.googleapis.com')!;
    expect(compute.headers.get('authorization')).toBe(`Bearer ${emu.mintedTokens[1]}`);
    expect(emu.mintedTokens[1]).toContain('imp');
  });

  it('cachedTokenSource caches a custom source for its default lifetime', async () => {
    let calls = 0;
    const custom: TokenSource = { token: async () => `custom-${++calls}` };
    const clock = manualClock(0);
    const tokens = cachedTokenSource(custom);
    const ctx = { signal: new AbortController().signal, clock };
    expect(await tokens.token(ctx)).toBe('custom-1');
    expect(await tokens.token(ctx)).toBe('custom-1');
    clock.advance(301_000);
    expect(await tokens.token(ctx)).toBe('custom-2');
  });

  it('rejects a malformed key and a refused token request', async () => {
    expect(() => serviceAccountTokenSource('not json')).toThrowError(/not valid JSON/);
    expect(() => serviceAccountTokenSource('{}')).toThrowError(/client_email/);
    const failing = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    const tokens = serviceAccountTokenSource(keyJson, { fetch: failing });
    await expect(tokens.token(context())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      details: { provider: 'gcp', status: 400, reason: 'invalid_grant' },
    });
  });

  describe('maps GCE errors to ComputeError codes', () => {
    const table: [string, number, string, string, Record<string, string>?, number?][] = [
      ['404', 404, 'notFound', 'NOT_FOUND'],
      ['409 alreadyExists', 409, 'alreadyExists', 'CONFLICT'],
      [
        '409 resourceInUseByAnotherResource',
        409,
        'resourceInUseByAnotherResource',
        'INVALID_STATE',
      ],
      [
        '400 resourceInUseByAnotherResource',
        400,
        'resourceInUseByAnotherResource',
        'INVALID_STATE',
      ],
      [
        '429 with Retry-After',
        429,
        'rateLimitExceeded',
        'RATE_LIMITED',
        { 'retry-after': '7' },
        7000,
      ],
      ['429 without Retry-After', 429, 'rateLimitExceeded', 'RATE_LIMITED', undefined, 10_000],
      ['403 rateLimitExceeded', 403, 'rateLimitExceeded', 'RATE_LIMITED', undefined, 10_000],
      [
        '403 userRateLimitExceeded',
        403,
        'userRateLimitExceeded',
        'RATE_LIMITED',
        undefined,
        10_000,
      ],
      ['403 quotaExceeded', 403, 'quotaExceeded', 'QUOTA_EXCEEDED'],
      ['403 other', 403, 'forbidden', 'ACCESS_DENIED'],
      ['400', 400, 'invalid', 'INVALID_INPUT'],
      ['503', 503, 'backendError', 'UNAVAILABLE'],
      ['500', 500, 'internalError', 'UNAVAILABLE'],
      ['412 conditionNotMet', 412, 'conditionNotMet', 'PROVIDER_ERROR'],
      ['418', 418, 'teapot', 'PROVIDER_ERROR'],
    ];
    for (const [name, status, reason, code, headers, retryAfterMs] of table)
      it(name, async () => {
        const emu = new GceEmulator();
        const tokens = metadataTokenSource({ fetch: emu.fetch });
        const client = gceClient({
          fetch: emu.fetch,
          endpoint,
          projectId: 'p',
          tokens,
          clock: manualClock(0),
        });
        await tokens.token(context());
        emu.failNext = { status, reason, message: 'boom', headers };
        const error = await client
          .request('GET', '/zones/us-central1-a/instances/x', {
            signal: new AbortController().signal,
          })
          .catch((e: unknown) => e);
        expect(isComputeError(error, code as never)).toBe(true);
        expect(error).toMatchObject({ details: { provider: 'gcp', status, reason } });
        if (retryAfterMs !== undefined)
          expect((error as { retryAfterMs: number }).retryAfterMs).toBe(retryAfterMs);
      });

    it('an unreachable endpoint is UNAVAILABLE', async () => {
      const tokens: TokenSource = { token: async () => 'x' };
      const client = gceClient({
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
        endpoint,
        projectId: 'p',
        tokens,
      });
      await expect(
        client.request('GET', '/x', { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { provider: 'gcp', status: 0 } });
    });
  });

  it('pages and aggregated iterate every page', async () => {
    const emu = new GceEmulator();
    emu.addInstance('us-central1-a', 'a1');
    emu.addInstance('us-central1-a', 'a2');
    emu.addInstance('us-central1-b', 'b1');
    emu.addInstance('europe-west4-a', 'e1');
    emu.addInstance('europe-west4-a', 'e2');
    const tokens = metadataTokenSource({ fetch: emu.fetch });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
    });
    const signal = new AbortController().signal;
    const names = async (items: AsyncIterable<{ name: string }>) => {
      const out: string[] = [];
      for await (const item of items) out.push(item.name);
      return out;
    };
    const before = emu.requests.length;
    const all = await names(
      client.aggregated<{ name: string }>('/aggregated/instances', 'instances', {
        query: { maxResults: '2' },
        signal,
      }),
    );
    expect(all.sort()).toEqual(['a1', 'a2', 'b1', 'e1', 'e2']);
    // 3 pages for the aggregated list (plus one token request).
    expect(
      emu.requests.slice(before).filter((r) => r.url.pathname.endsWith('/aggregated/instances')),
    ).toHaveLength(3);
    const zonal = await names(
      client.pages<{ name: string }>('/zones/us-central1-a/instances', 'items', { signal }),
    );
    expect(zonal.sort()).toEqual(['a1', 'a2']);
    const second = await names(
      client.pages<{ name: string }>('/zones/europe-west4-a/instances', 'items', { signal }),
    );
    expect(second.sort()).toEqual(['e1', 'e2']);
  });

  it('ids round-trip', () => {
    const input = {
      zone: 'us-central1-a',
      machineType: 'a3-highgpu-8g',
      reservation: 'projects/o/reservations/r',
    };
    expect(parseOfferId(offerId(input.zone, input.machineType, input.reservation))).toEqual(input);
    expect(parseOfferId(offerId('us-central1-a', 'a3-highgpu-8g'))).toEqual({
      zone: 'us-central1-a',
      machineType: 'a3-highgpu-8g',
    });
    expect(offerId('us-central1-a', 'a3-highgpu-8g', 'rsv-a')).toBe(
      'us-central1-a/a3-highgpu-8g@rsv-a',
    );
    expect(parseMachineId(machineId('us-central1-a', 'bc-x'))).toEqual({
      zone: 'us-central1-a',
      name: 'bc-x',
    });
    for (const bad of ['bc-conformance-missing-0', 'a/b/c', '/x', 'x/', 'US/x', '']) {
      expect(() => parseMachineId(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    }
    for (const bad of ['a3-highgpu-8g', 'z/', 'z/m@', '/m'])
      expect(() => parseOfferId(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    const name = instanceName('ins_01JZABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(name).toMatch(/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(instanceName('ins_01JZ')).toBe('bc-ins-01jz');
    expect(labelValue('Ins_01JZ Ä.x')).toMatch(/^[a-z0-9_-]*$/);
    expect(labelValue('a'.repeat(100))).toHaveLength(63);
    expect(requestIdFor('k')).toBe(requestIdFor('k'));
    expect(requestIdFor('k')).not.toBe(requestIdFor('k2'));
    expect(requestIdFor('k')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('never logs tokens', async () => {
    const emu = new GceEmulator();
    const lines: string[] = [];
    const record = (level: string) => (message: string, fields?: Record<string, unknown>) =>
      void lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    const log: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    const tokens = serviceAccountTokenSource(keyJson, { fetch: emu.fetch });
    const client = gceClient({
      fetch: emu.fetch,
      endpoint,
      projectId: 'p',
      tokens,
      clock: manualClock(0),
      log,
    });
    const signal = new AbortController().signal;
    await client.request('GET', '/zones/us-central1-a/instances', { signal });
    emu.failNext = { status: 403, reason: 'forbidden' };
    const error = await client
      .request('GET', '/zones/us-central1-a/instances', { signal })
      .catch((e: unknown) => e);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('ya29.');
    expect(String((error as Error).message)).not.toContain('ya29.');
    expect(JSON.stringify(error)).not.toContain('ya29.');
  });
});
