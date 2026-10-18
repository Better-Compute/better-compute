import { describe, expect, it, vi } from 'vitest';
import { ComputeError, manualClock } from '@better-compute/core';
import { cachedTokenSource, federatedTokenSource, stsExchange } from '@better-compute/gcp-common';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { FakeSts } from './support/gcp/sts.js';

const issuerUrl = 'https://compute.example.com/workload';
const audience =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/tenants/providers/control-plane';
const subjectAudience = `https://iam.googleapis.com/${audience.slice('//iam.googleapis.com/'.length)}`;
const subject = 'tenant:org_acme:account:acct_1';

function setup(condition: (sub: string) => boolean = () => true) {
  const issuer = workloadIssuer({
    issuer: issuerUrl,
    signingKey: generateP256KeyPair().privateKey,
  });
  const sts = new FakeSts({
    jwks: () => issuer.jwks(),
    issuer: issuerUrl,
    audience,
    condition,
    grant: (sub) => `ya29.federated-for-${sub}`,
  });
  const subjectToken = async (): Promise<string> =>
    (await issuer.mint({ subject, audience: subjectAudience })).token;
  return { issuer, sts, subjectToken };
}

const context = (clock = manualClock(1_000_000)) => ({
  signal: new AbortController().signal,
  clock,
});

async function failure(run: () => unknown): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    return error as ComputeError;
  }
  throw new Error('expected a ComputeError');
}

describe('federatedTokenSource', () => {
  it('exchanges the subject token for an access token and caches it', async () => {
    const { sts, subjectToken } = setup();
    const clock = manualClock(Date.now());
    const source = federatedTokenSource({ audience, subjectToken, fetch: sts.fetch });
    expect(await source.token(context(clock))).toBe(`ya29.federated-for-${subject}`);
    clock.advance(30 * 60_000);
    expect(await source.token(context(clock))).toBe(`ya29.federated-for-${subject}`);
    expect(sts.exchanges).toEqual([{ sub: subject, accepted: true }]);
    // Past the lifetime less the 60 s skew, a new exchange.
    clock.advance(30 * 60_000);
    await source.token(context(clock));
    expect(sts.exchanges).toHaveLength(2);
  });

  it('cachedTokenSource over it keeps the real expiry', async () => {
    const { sts, subjectToken } = setup();
    const clock = manualClock(Date.now());
    const source = cachedTokenSource(
      federatedTokenSource({ audience, subjectToken, fetch: sts.fetch }),
    );
    await source.token(context(clock));
    // Beyond the 5-minute trust given to a source of unknown lifetime, within the real hour.
    clock.advance(20 * 60_000);
    await source.token(context(clock));
    expect(sts.exchanges).toHaveLength(1);
  });

  it('sends the token-exchange form to the universe STS endpoint', async () => {
    const { sts, subjectToken } = setup();
    const token = await subjectToken();
    const seen: { url: string; method?: string; headers: Headers; body: URLSearchParams }[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: new URLSearchParams(String(init?.body)),
      });
      return sts.fetch(input, init);
    };
    await federatedTokenSource({
      audience,
      subjectToken: async () => token,
      fetch: spy,
    }).token(context());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://sts.googleapis.com/v1/token');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(seen[0]!.body)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
  });

  it('hands the subject-token callback the signal and the clock', async () => {
    const { sts, subjectToken } = setup();
    const callback = vi.fn(async (_given: { signal: AbortSignal; clock: unknown }) =>
      subjectToken(),
    );
    const ctx = context();
    await federatedTokenSource({ audience, subjectToken: callback, fetch: sts.fetch }).token(ctx);
    expect(callback).toHaveBeenCalledTimes(1);
    const given = callback.mock.calls[0]![0];
    expect(given.clock).toBe(ctx.clock);
    expect(given.signal).toBeInstanceOf(AbortSignal);
  });

  it('an attribute-condition refusal is UNAUTHENTICATED invalid_grant', async () => {
    const { sts, subjectToken } = setup((sub) => sub !== subject);
    const error = await failure(() =>
      federatedTokenSource({ audience, subjectToken, fetch: sts.fetch }).token(context()),
    );
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.details).toMatchObject({ provider: 'gcp', status: 400, reason: 'invalid_grant' });
    expect(sts.exchanges).toEqual([{ sub: subject, accepted: false }]);
  });

  it('a malformed audience is INVALID_CONFIG before any fetch', async () => {
    const { sts, subjectToken } = setup();
    const fetch = vi.fn(sts.fetch);
    const pool =
      'projects/1/locations/global/workloadIdentityPools/tenants/providers/control-plane';
    const bad = [
      '',
      `https://iam.googleapis.com/${pool}`,
      `//iam.googleapis.com/${pool.replace('projects/1', 'projects/abc')}`,
      `//iam.googleapis.com/${pool.replace('/tenants/', '/x/')}`,
      `//iam.googleapis.com/${pool}/extra`,
      `//iam.googleapis.com/${pool}?x=1`,
    ];
    for (const value of bad) {
      const error = await failure(() =>
        federatedTokenSource({ audience: value, subjectToken, fetch }),
      );
      expect(error.code).toBe('INVALID_CONFIG');
      expect(error.details).toMatchObject({ reason: 'federationAudience' });
      const direct = await failure(() =>
        stsExchange({
          audience: value,
          subjectToken: 'x',
          fetch,
          signal: new AbortController().signal,
        }),
      );
      expect(direct.code).toBe('INVALID_CONFIG');
      expect(direct.details).toMatchObject({ reason: 'federationAudience' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an audience from another universe is INVALID_CONFIG before any fetch', async () => {
    const { sts, subjectToken } = setup();
    const fetch = vi.fn(sts.fetch);
    const other = audience.replace('iam.googleapis.com', 'iam.example-tpc.com');
    // Another universe's host, under the default universe ...
    const a = await failure(() => federatedTokenSource({ audience: other, subjectToken, fetch }));
    expect(a.code).toBe('INVALID_CONFIG');
    expect(a.details).toMatchObject({ reason: 'federationAudience' });
    // ... the default universe's host, under another universe ...
    const b = await failure(() =>
      federatedTokenSource({ audience, subjectToken, fetch, universeDomain: 'example-tpc.com' }),
    );
    expect(b.code).toBe('INVALID_CONFIG');
    expect(b.details).toMatchObject({ reason: 'federationAudience' });
    // ... and the same check at the one-shot exchange.
    const c = await failure(() =>
      stsExchange({
        audience: other,
        subjectToken: 'x',
        fetch,
        signal: new AbortController().signal,
      }),
    );
    expect(c.code).toBe('INVALID_CONFIG');
    expect(c.details).toMatchObject({ reason: 'federationAudience' });
    expect(fetch).not.toHaveBeenCalled();
    // The matching host in that universe is accepted, and goes to that universe's STS.
    const urls: string[] = [];
    const ok = federatedTokenSource({
      audience: other,
      subjectToken,
      universeDomain: 'example-tpc.com',
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
        });
      },
    });
    expect(await ok.token(context())).toBe('t');
    expect(urls).toEqual(['https://sts.example-tpc.com/v1/token']);
  });

  it('STS 503 is UNAVAILABLE', async () => {
    const { sts, subjectToken } = setup();
    sts.down = true;
    const error = await failure(() =>
      federatedTokenSource({ audience, subjectToken, fetch: sts.fetch }).token(context()),
    );
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details).toMatchObject({ status: 503 });
  });

  it('a network error is UNAVAILABLE', async () => {
    const { subjectToken } = setup();
    const error = await failure(() =>
      federatedTokenSource({
        audience,
        subjectToken,
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }).token(context()),
    );
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details).toMatchObject({ reason: 'network' });
  });

  it('a reply without an access token is UNAUTHENTICATED', async () => {
    const { subjectToken } = setup();
    const error = await failure(() =>
      federatedTokenSource({
        audience,
        subjectToken,
        fetch: async () => new Response('{}', { status: 200 }),
      }).token(context()),
    );
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.details).toMatchObject({ reason: 'no_token' });
  });

  it('the subject token never appears in logs or error messages', async () => {
    const { sts, subjectToken } = setup((sub) => sub !== subject);
    const secret = await subjectToken();
    const logs: unknown[][] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args)),
    );
    try {
      const refused = await failure(() =>
        federatedTokenSource({
          audience,
          subjectToken: async () => secret,
          fetch: sts.fetch,
        }).token(context()),
      );
      sts.down = true;
      const unavailable = await failure(() =>
        federatedTokenSource({
          audience,
          subjectToken: async () => secret,
          fetch: sts.fetch,
        }).token(context()),
      );
      const direct = await failure(() =>
        stsExchange({
          audience,
          subjectToken: secret,
          fetch: sts.fetch,
          signal: new AbortController().signal,
        }),
      );
      for (const error of [refused, unavailable, direct]) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error.details ?? {})).not.toContain(secret);
        expect(JSON.stringify(error.details ?? {})).not.toContain(secret.split('.')[1]!);
      }
      expect(JSON.stringify(logs)).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('the access token never appears in an error', async () => {
    const { subjectToken } = setup();
    const error = await failure(() =>
      federatedTokenSource({
        audience,
        subjectToken,
        fetch: async () =>
          new Response(JSON.stringify({ access_token: 'ya29.secret', error: 'x' }), {
            status: 400,
          }),
      }).token(context()),
    );
    expect(error.message).not.toContain('ya29.secret');
    expect(JSON.stringify(error.details ?? {})).not.toContain('ya29.secret');
  });
});

describe('stsExchange', () => {
  it('returns the access token and its lifetime, uncached', async () => {
    const { sts, subjectToken } = setup();
    const token = await subjectToken();
    const signal = new AbortController().signal;
    const first = await stsExchange({ audience, subjectToken: token, fetch: sts.fetch, signal });
    expect(first).toEqual({ accessToken: `ya29.federated-for-${subject}`, expiresInSeconds: 3600 });
    await stsExchange({ audience, subjectToken: token, fetch: sts.fetch, signal });
    expect(sts.exchanges).toHaveLength(2);
  });

  it('a foreign-issuer subject token is refused', async () => {
    const { sts } = setup();
    const foreign = workloadIssuer({
      issuer: 'https://other.example.com',
      signingKey: generateP256KeyPair().privateKey,
    });
    const { token } = await foreign.mint({ subject, audience: subjectAudience });
    const error = await failure(() =>
      stsExchange({
        audience,
        subjectToken: token,
        fetch: sts.fetch,
        signal: new AbortController().signal,
      }),
    );
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.details).toMatchObject({ reason: 'invalid_grant' });
    expect(sts.exchanges).toEqual([{ accepted: false }]);
  });
});
