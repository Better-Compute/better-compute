import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  googleEndpoint,
  impersonatedTokenSource,
  serviceAccountTokenSource,
  tokenEndpoint,
} from '@better-compute/gcp-common';
import { gcpProvider, type GcpConfig } from '@better-compute/provider-gcp';
import { FakeGoogle } from './support/gcp/fake-google.js';

// Universe domains: endpoints derive from a host-configured universe, and the token_uri pin follows it.

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyWith = (extra: Record<string, unknown>) =>
  JSON.stringify({
    type: 'service_account',
    client_email: 'sa@p.iam.gserviceaccount.com',
    private_key: pem,
    ...extra,
  });

/** A fetch that records each URL and answers a token. */
function recording() {
  const posted: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    posted.push(String(url));
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { posted, fetchImpl };
}

const context = () => ({ signal: new AbortController().signal, clock: manualClock(1_000_000) });

describe('endpoints', () => {
  it('googleEndpoint builds and validates', () => {
    expect(googleEndpoint('compute')).toBe('https://compute.googleapis.com');
    expect(googleEndpoint('sts', { universeDomain: 'example-tpc.goog' })).toBe(
      'https://sts.example-tpc.goog',
    );
    expect(tokenEndpoint()).toBe('https://oauth2.googleapis.com/token');
    expect(tokenEndpoint('example-tpc.goog')).toBe('https://oauth2.example-tpc.goog/token');
    const invalid = expect.objectContaining({
      code: 'INVALID_CONFIG',
      details: { provider: 'gcp', reason: 'endpoint' },
    });
    expect(() => googleEndpoint('evil.com/x')).toThrow(invalid);
    expect(() => googleEndpoint('compute', { universeDomain: '.com' })).toThrow(invalid);
    expect(() => googleEndpoint('compute', { universeDomain: '' })).toThrow(invalid);
    expect(() => googleEndpoint('compute', { universeDomain: 'a.b/evil' })).toThrow(invalid);
    expect(() => googleEndpoint('Compute')).toThrow(invalid);
    expect(() => tokenEndpoint('localhost')).toThrow(invalid);
  });

  it('the default universe keeps the old alias', async () => {
    const { posted, fetchImpl } = recording();
    const tokens = serviceAccountTokenSource(
      keyWith({ token_uri: 'https://accounts.google.com/o/oauth2/token' }),
      { fetch: fetchImpl },
    );
    expect(await tokens.token(context())).toBe('tok');
    expect(posted).toEqual(['https://accounts.google.com/o/oauth2/token']);
    // Naming the default universe explicitly is the same.
    const explicit = serviceAccountTokenSource(
      keyWith({ token_uri: 'https://accounts.google.com/o/oauth2/token' }),
      { fetch: fetchImpl, universeDomain: 'googleapis.com' },
    );
    await explicit.token(context());
    expect(posted).toHaveLength(2);
  });

  it("a key whose token_uri is the configured universe's endpoint is accepted", async () => {
    const { posted, fetchImpl } = recording();
    const tokens = serviceAccountTokenSource(
      keyWith({
        token_uri: 'https://oauth2.example-tpc.goog/token',
        universe_domain: 'example-tpc.goog',
      }),
      { fetch: fetchImpl, universeDomain: 'example-tpc.goog' },
    );
    expect(await tokens.token(context())).toBe('tok');
    expect(posted).toEqual(['https://oauth2.example-tpc.goog/token']);
  });

  it('another universe pins exactly its own token endpoint', () => {
    const { posted, fetchImpl } = recording();
    const universe = 'example-tpc.goog';
    for (const tokenUri of [
      'https://oauth2.googleapis.com/token',
      'https://accounts.google.com/o/oauth2/token',
      'https://oauth2.example-tpc.goog.evil.example/token',
      'https://oauth2.other-tpc.goog/token',
      'http://oauth2.example-tpc.goog/token',
      'https://oauth2.example-tpc.goog/token?x=1',
    ])
      expect(
        () =>
          serviceAccountTokenSource(keyWith({ token_uri: tokenUri, universe_domain: universe }), {
            fetch: fetchImpl,
            universeDomain: universe,
          }),
        tokenUri,
      ).toThrow(
        expect.objectContaining({
          code: 'INVALID_CONFIG',
          details: { provider: 'gcp', reason: 'tokenUri' },
        }),
      );
    expect(posted).toEqual([]);
  });

  it("a key's universe_domain must match the configured universe", () => {
    const { posted, fetchImpl } = recording();
    const refused = expect.objectContaining({
      code: 'INVALID_CONFIG',
      details: { provider: 'gcp', reason: 'universeDomain' },
    });
    // A default-universe host refuses a key from another universe.
    expect(() =>
      serviceAccountTokenSource(keyWith({ universe_domain: 'example-tpc.goog' }), {
        fetch: fetchImpl,
      }),
    ).toThrow(refused);
    // A key without universe_domain counts as the default universe, so a TPC host refuses it.
    expect(() =>
      serviceAccountTokenSource(keyWith({ token_uri: 'https://oauth2.example-tpc.goog/token' }), {
        fetch: fetchImpl,
        universeDomain: 'example-tpc.goog',
      }),
    ).toThrow(refused);
    // Present but empty (or not a string) is refused rather than read as the default.
    for (const value of ['', 7, null])
      expect(
        () => serviceAccountTokenSource(keyWith({ universe_domain: value }), { fetch: fetchImpl }),
        String(value),
      ).toThrow(refused);
    // A key with the default universe_domain works on a default host.
    expect(() =>
      serviceAccountTokenSource(keyWith({ universe_domain: 'googleapis.com' }), {
        fetch: fetchImpl,
      }),
    ).not.toThrow();
    expect(posted).toEqual([]);
  });

  it("a key's universe_domain never selects the universe", () => {
    const { posted, fetchImpl } = recording();
    let caught: unknown;
    try {
      serviceAccountTokenSource(
        keyWith({
          universe_domain: 'evil.example',
          token_uri: 'https://oauth2.evil.example/token',
        }),
        { fetch: fetchImpl },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(['universeDomain', 'tokenUri']).toContain(
      (caught as { details: { reason: string } }).details.reason,
    );
    expect(posted).toEqual([]);
  });

  it('an invalid configured universe is INVALID_CONFIG when the source is built', () => {
    const invalid = expect.objectContaining({
      code: 'INVALID_CONFIG',
      details: { provider: 'gcp', reason: 'endpoint' },
    });
    expect(() => serviceAccountTokenSource(keyWith({}), { universeDomain: 'evil/x' })).toThrow(
      invalid,
    );
    expect(() =>
      impersonatedTokenSource({ token: async () => 'b' }, 'a@b.iam', { universeDomain: '.com' }),
    ).toThrow(invalid);
    expect(() => gcpProvider({ universeDomain: 'nodots' })).toThrow(invalid);
  });

  it("impersonation uses the configured universe's IAM Credentials host", async () => {
    const universe = 'example-tpc.goog';
    const fake = new FakeGoogle({ token: 'base' });
    fake.route('POST', '/v1/projects/-/serviceAccounts/{email}', (_request, params) => ({
      body: { accessToken: `imp-${params.email}` },
    }));
    const target = 'target@p.iam.gserviceaccount.com';
    const tokens = impersonatedTokenSource(fake.tokens(), target, {
      fetch: fake.fetch,
      universeDomain: universe,
    });
    expect(await tokens.token(context())).toBe(`imp-${target}:generateAccessToken`);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url.hostname).toBe('iamcredentials.example-tpc.goog');
    expect(fake.requests[0]!.headers.get('authorization')).toBe('Bearer base');
    // The default stays on googleapis.com.
    const plain = new FakeGoogle({ token: 'base' });
    plain.route('POST', '/v1/projects/-/serviceAccounts/{email}', () => ({
      body: { accessToken: 'x' },
    }));
    await impersonatedTokenSource(plain.tokens(), target, { fetch: plain.fetch }).token(context());
    expect(plain.requests[0]!.url.hostname).toBe('iamcredentials.googleapis.com');
  });
});

describe('provider in another universe', () => {
  const account = { id: 'pacct_platform', tenantId: 'root', platform: true };
  const build = async (options: Parameters<typeof gcpProvider>[0]) => {
    const provider = gcpProvider(options);
    const parsed = await provider.config['~standard'].validate({
      projectId: 'p',
      zones: ['us-central1-a'],
    });
    return provider.create((parsed as { value: GcpConfig }).value, {
      clock: manualClock(1_000_000),
      secrets: { resolve: async () => '' },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      account,
    });
  };
  const callContext = () => ({
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
    clock: manualClock(1_000_000),
    secrets: { resolve: async () => '' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  it('a provider in another universe calls compute.<universe>', async () => {
    const fake = new FakeGoogle();
    const impl = await build({
      fetch: fake.fetch,
      universeDomain: 'example-tpc.goog',
      tokenSource: fake.tokens(),
    });
    expect(await impl.get('us-central1-a/vm-1', callContext())).toBeUndefined();
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(new Set(fake.requests.map((r) => r.url.hostname))).toEqual(
      new Set(['compute.example-tpc.goog']),
    );
    expect(fake.requests[0]!.url.pathname).toMatch(/^\/compute\/v1\//);
  });

  it('an explicit endpoint still wins over the universe', async () => {
    const fake = new FakeGoogle();
    const impl = await build({
      fetch: fake.fetch,
      universeDomain: 'example-tpc.goog',
      endpoint: 'https://compute.private.example/compute/v1',
      tokenSource: fake.tokens(),
    });
    await impl.get('us-central1-a/vm-1', callContext());
    expect(new Set(fake.requests.map((r) => r.url.hostname))).toEqual(
      new Set(['compute.private.example']),
    );
  });

  it('the default universe still calls compute.googleapis.com', async () => {
    const fake = new FakeGoogle();
    const impl = await build({ fetch: fake.fetch, tokenSource: fake.tokens() });
    await impl.get('us-central1-a/vm-1', callContext());
    expect(new Set(fake.requests.map((r) => r.url.hostname))).toEqual(
      new Set(['compute.googleapis.com']),
    );
  });
});
