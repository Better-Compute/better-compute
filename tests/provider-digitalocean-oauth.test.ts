import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock, type Logger, type ProviderContext } from '@better-compute/core';
import {
  digitaloceanProvider,
  exchangeAuthorizationCode,
  resetOAuthState,
  type DoCompute,
  type DoConfig,
  type DoOAuthOptions,
} from '@better-compute/provider-digitalocean';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';
import { OAuthEmulator, oauthOrigin } from './support/do-emulator/oauth.js';
import { freshBudgets } from './support/do-harness.js';

// DigitalOcean P9 OAuth (DO-D13): an account may hold a refresh token instead of a personal access token. The
// provider exchanges it for an access token (30 days), and the refresh token rotates on every exchange, so the new
// one is written back over the account's secret through the host's `rotate` hook before it is used again.

beforeEach(() => {
  freshBudgets();
  resetOAuthState();
});

const REF = 'secret://tenant-root/do-oauth';

function world(start = Date.parse('2026-10-05T12:00:00Z')) {
  const api = new DoEmulator();
  api.validTokens = new Set();
  const oauth = new OAuthEmulator(api);
  const store = new Map<string, string>([[REF, 'refresh-0']]);
  const writes: { ref: string; value: string; tenantId: string }[] = [];
  const lines: string[] = [];
  const log: Logger = {
    debug: (...a) => void lines.push(JSON.stringify(a)),
    info: (...a) => void lines.push(JSON.stringify(a)),
    warn: (...a) => void lines.push(JSON.stringify(a)),
    error: (...a) => void lines.push(JSON.stringify(a)),
  };
  const clock = manualClock(start);
  const context: ProviderContext = {
    clock,
    log,
    secrets: {
      resolve: async (ref) => {
        const value = store.get(ref);
        if (value === undefined) throw new Error('no such secret');
        return value;
      },
    },
    account: { id: 'pacct_1', tenantId: 'tenant-root', platform: true },
  };
  let failWrites = 0;
  const hooks: DoOAuthOptions = {
    clientId: 'client-1',
    // The platform's OAuth app secret comes from the host, never from a tenant's secrets.
    clientSecret: async () => 'client-secret-1',
    rotate: async (input) => {
      if (failWrites > 0) {
        failWrites--;
        throw new Error('store down');
      }
      writes.push(input);
      store.set(input.ref, input.value);
    },
  };
  async function account(options: { oauth?: DoOAuthOptions | undefined } = { oauth: hooks }) {
    const provider = digitaloceanProvider({ fetch: oauth.fetch, ...options });
    const parsed = await provider.config['~standard'].validate({
      refreshToken: REF,
      regions: ['nyc3'],
    });
    if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
    return { provider, config: (parsed as { value: DoConfig }).value };
  }
  async function build(options: { oauth?: DoOAuthOptions | undefined } = { oauth: hooks }) {
    const { provider, config } = await account(options);
    return (await provider.create(config, context)) as DoCompute;
  }
  return {
    api,
    oauth,
    store,
    writes,
    lines,
    clock,
    context,
    hooks,
    account,
    build,
    failNext: (n: number) => (failWrites = n),
  };
}

describe('OAuth accounts', () => {
  it('exchanges the refresh token, writes the rotated one back, and calls the API with the access token', async () => {
    const w = world();
    const compute = await w.build();
    await compute.listOffers({});
    expect(w.writes).toEqual([{ ref: REF, value: 'refresh-1', tenantId: 'tenant-root' }]);
    expect(w.store.get(REF)).toBe('refresh-1');
    const apiCalls = w.api.requests.map((r) => r.headers.authorization);
    expect(new Set(apiCalls)).toEqual(new Set(['Bearer access-1']));
    // One exchange serves every request until the access token nears its expiry.
    await compute.get('1', {
      idempotencyKey: 'k',
      signal: new AbortController().signal,
      clock: w.clock,
      secrets: w.context.secrets,
      log: w.context.log,
    });
    expect(w.oauth.requests).toHaveLength(1);
    // The exchange carries the grant in a form body, never in the URL (which proxies and fetch wrappers log).
    expect(w.oauth.requests[0]!.params.get('grant_type')).toBe('refresh_token');
  });

  it('refreshes before the access token expires, from the refresh token the store holds now', async () => {
    const w = world();
    const compute = await w.build();
    await compute.listOffers({});
    w.clock.advance(30 * 86_400_000 - 30_000);
    // Force a fresh catalog read so the client makes a request.
    w.clock.advance(11 * 60_000);
    await compute.listOffers({});
    expect(w.oauth.requests).toHaveLength(2);
    expect(w.store.get(REF)).toBe('refresh-2');
    expect(w.api.requests.at(-1)!.headers.authorization).toBe('Bearer access-2');
  });

  it('takes the token another process rotated: an invalid grant re-reads the store once', async () => {
    const w = world();
    // Another process exchanged refresh-0 and stored refresh-9 between this one's read and its exchange.
    w.oauth.refreshTokens.delete('refresh-0');
    w.oauth.refreshTokens.add('refresh-9');
    let reads = 0;
    const resolve = w.context.secrets.resolve;
    w.context.secrets.resolve = async (ref, ctx) => {
      if (ref === REF && reads++ === 1) w.store.set(REF, 'refresh-9');
      return resolve(ref, ctx);
    };
    const compute = await w.build();
    await compute.listOffers({});
    expect(w.store.get(REF)).toBe('refresh-1');
  });

  it('fails closed with INVALID_CONFIG when the grant is dead, and never logs a token', async () => {
    const w = world();
    w.oauth.refreshTokens.clear();
    const oauth = { ...w.hooks, raceWaitMs: [1] };
    // The first refusal may be another process's rotation in flight; refused again, the grant is dead.
    await (await w.build({ oauth })).listOffers({}).catch(() => undefined);
    const compute = await w.build({ oauth });
    const error = await compute.listOffers({}).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INVALID_CONFIG',
      details: expect.objectContaining({ reason: 'oauthGrant' }),
    });
    const text = JSON.stringify([w.lines, error, (error as Error).message]);
    for (const secret of ['refresh-0', 'client-secret-1']) expect(text).not.toContain(secret);
  });

  it('retries a failed write-back, and keeps the rotated token for the next exchange if the store stays down', async () => {
    const w = world();
    w.failNext(2);
    const compute = await w.build();
    await compute.listOffers({});
    // Two failures, then the third attempt lands.
    expect(w.store.get(REF)).toBe('refresh-1');

    // A second, separate world under the same secret ref: forget the first one's shared access token.
    resetOAuthState();
    const v = world();
    v.failNext(10);
    const down = await v.build();
    await down.listOffers({});
    expect(v.store.get(REF)).toBe('refresh-0');
    expect(v.lines.some((line) => line.includes('digitalocean.oauthRotateFailed'))).toBe(true);
    expect(v.lines.join('\n')).not.toContain('refresh-1');
    // The next exchange uses the rotated token it holds (refresh-0 is dead), and writes again.
    v.failNext(0);
    v.clock.advance(31 * 86_400_000);
    await down.listOffers({});
    expect(v.store.get(REF)).toBe('refresh-2');
  });

  it('refuses an account with both or neither credential, and an OAuth account without a rotate hook', async () => {
    const w = world();
    const provider = digitaloceanProvider({ fetch: w.oauth.fetch, oauth: undefined });
    const check = async (config: Record<string, unknown>) => {
      const parsed = await provider.config['~standard'].validate(config);
      if ('issues' in parsed && parsed.issues) return 'INVALID';
      try {
        await provider.create((parsed as { value: DoConfig }).value, w.context);
        return 'ok';
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    expect(await check({ regions: ['nyc3'] })).toBe('INVALID_CONFIG');
    expect(await check({ token: 'secret://t/a', refreshToken: REF, regions: ['nyc3'] })).toBe(
      'INVALID_CONFIG',
    );
    expect(await check({ refreshToken: REF, regions: ['nyc3'] })).toBe('INVALID_CONFIG');
    expect(await check({ token: 'secret://t/a', regions: ['nyc3'] })).toBe('ok');
  });
});

describe('one access token per account', () => {
  it('two clients, the account check and the findings read share one exchange', async () => {
    const w = world();
    const { provider, config } = await w.account();
    const a = (await provider.create(config, w.context)) as DoCompute;
    await a.listOffers({});
    const b = (await provider.create(config, w.context)) as DoCompute;
    await b.listOffers({ regions: ['nyc3'] });
    await provider.probeAccount!(config, w.context);
    await provider.findings!(config, w.context);
    expect(w.oauth.requests).toHaveLength(1);
    expect(w.writes).toHaveLength(1);
    expect(new Set(w.api.requests.map((r) => r.headers.authorization))).toEqual(
      new Set(['Bearer access-1']),
    );
  });

  it('a 401 for the shared token exchanges once more, and every client takes the new token', async () => {
    const w = world();
    const { provider, config } = await w.account();
    const a = (await provider.create(config, w.context)) as DoCompute;
    await a.listOffers({});
    // DigitalOcean revoked the access token early.
    w.api.validTokens.delete('access-1');
    w.clock.advance(11 * 60_000);
    await expect(a.listOffers({})).rejects.toBeDefined();
    // The client that saw the 401 names the refused token, so the source does not answer it again.
    await a.listOffers({});
    expect(w.oauth.requests).toHaveLength(2);
    expect(w.api.requests.at(-1)!.headers.authorization).toBe('Bearer access-2');
    // A client created later shares the new token.
    const b = (await provider.create(config, w.context)) as DoCompute;
    await b.listOffers({ regions: ['nyc3'] });
    expect(w.oauth.requests).toHaveLength(2);
    expect(w.api.requests.at(-1)!.headers.authorization).toBe('Bearer access-2');
  });
});

describe('a rotation another process has not written back yet', () => {
  it('waits for the store, then uses the token the other process rotated', async () => {
    const w = world();
    // Process A exchanged refresh-0 for refresh-9; its write-back lands after this process's first re-reads.
    w.oauth.refreshTokens.delete('refresh-0');
    w.oauth.refreshTokens.add('refresh-9');
    let reads = 0;
    const resolve = w.context.secrets.resolve;
    w.context.secrets.resolve = async (ref, ctx) => {
      if (ref === REF && ++reads === 4) w.store.set(REF, 'refresh-9');
      return resolve(ref, ctx);
    };
    const compute = await w.build({ oauth: { ...w.hooks, raceWaitMs: [1, 1, 1] } });
    await compute.listOffers({});
    expect(w.store.get(REF)).toBe('refresh-1');
    expect(w.api.requests.at(-1)!.headers.authorization).toBe('Bearer access-1');
  });

  it('a refusal with the store unchanged is retryable once, then a dead grant', async () => {
    const w = world();
    w.oauth.refreshTokens.clear();
    const oauth = { ...w.hooks, raceWaitMs: [1, 1] };
    const first = await (await w.build({ oauth })).listOffers({}).catch((e: unknown) => e);
    expect(first).toMatchObject({
      code: 'UNAVAILABLE',
      details: expect.objectContaining({ reason: 'oauthRace' }),
    });
    const second = await (await w.build({ oauth })).listOffers({}).catch((e: unknown) => e);
    expect(second).toMatchObject({
      code: 'INVALID_CONFIG',
      details: expect.objectContaining({ reason: 'oauthGrant' }),
    });
    const text = JSON.stringify([w.lines, first, second]);
    for (const secret of ['refresh-0', 'client-secret-1']) expect(text).not.toContain(secret);
  });
});

describe('the token endpoint request', () => {
  it('never puts the client secret, a refresh token or a code in the URL', async () => {
    const w = world();
    await (await w.build()).listOffers({});
    w.oauth.codes.set('code-7', 'https://x/cb');
    await exchangeAuthorizationCode({
      code: 'code-7',
      redirectUri: 'https://x/cb',
      clientId: 'client-1',
      clientSecret: 'client-secret-1',
      fetch: w.oauth.fetch,
      clock: w.clock,
      signal: new AbortController().signal,
    });
    expect(w.oauth.requests).toHaveLength(2);
    for (const request of w.oauth.requests) {
      expect(request.url.search).toBe('');
      for (const secret of ['client-secret-1', 'refresh-0', 'code-7'])
        expect(request.url.toString()).not.toContain(secret);
    }
    expect(w.oauth.requests[0]!.params.get('refresh_token')).toBe('refresh-0');
    expect(w.oauth.requests[1]!.params.get('code')).toBe('code-7');
  });

  it("falls back to DigitalOcean's documented query form when configured", async () => {
    const w = world();
    await (await w.build({ oauth: { ...w.hooks, tokenParams: 'query' } })).listOffers({});
    expect(w.oauth.requests[0]!.url.searchParams.get('grant_type')).toBe('refresh_token');
    expect(w.oauth.requests[0]!.body).toBe('');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('trades a code for tokens and the account it belongs to', async () => {
    const w = world();
    w.oauth.codes.set('code-1', 'https://console.example.com/providers/digitalocean/callback');
    const result = await exchangeAuthorizationCode({
      code: 'code-1',
      redirectUri: 'https://console.example.com/providers/digitalocean/callback',
      clientId: 'client-1',
      clientSecret: 'client-secret-1',
      fetch: w.oauth.fetch,
      clock: w.clock,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: w.clock.now() + 2_592_000_000,
      scope: 'read write',
      account: { uuid: 'acct-uuid-1', name: 'Sammy', email: 'sammy@example.com' },
    });
    // Single use.
    await expect(
      exchangeAuthorizationCode({
        code: 'code-1',
        redirectUri: 'https://console.example.com/providers/digitalocean/callback',
        clientId: 'client-1',
        clientSecret: 'client-secret-1',
        fetch: w.oauth.fetch,
        clock: w.clock,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('only ever talks to the configured token endpoint over https', async () => {
    const w = world();
    await expect(
      exchangeAuthorizationCode({
        code: 'c',
        redirectUri: 'https://x/cb',
        clientId: 'client-1',
        clientSecret: 'client-secret-1',
        fetch: w.oauth.fetch,
        clock: w.clock,
        signal: new AbortController().signal,
        endpoint: 'http://cloud.digitalocean.com/v1/oauth/token',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(w.oauth.requests).toHaveLength(0);
    expect(oauthOrigin).toBe('https://cloud.digitalocean.com');
  });
});

describe('conformance of the connect flow', () => {
  it('passes the connect case, refusing an unregistered redirect URI before any request', async () => {
    const w = world();
    const cases = providerConformanceCases().filter((item) => item.name.startsWith('connect '));
    expect(cases).toHaveLength(1);
    const report = await runConformance(cases, {
      provider: digitaloceanProvider({
        fetch: w.oauth.fetch,
        oauth: { ...w.hooks, redirectUris: ['https://console.example.test/cb'] },
      }),
      config: { token: 'secret://t/a', regions: ['nyc3'] },
      offerId: 'nyc3/s-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
      context: { clock: w.clock },
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(w.oauth.requests).toHaveLength(0);
  });
});
