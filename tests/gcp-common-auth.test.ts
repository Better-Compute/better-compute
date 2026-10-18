import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '@better-compute/core';
import * as common from '@better-compute/gcp-common';
import * as gcp from '@better-compute/provider-gcp';
import { FakeGoogle } from './support/gcp/fake-google.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const evilKeyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@p.iam.gserviceaccount.com',
  private_key: pem,
  token_uri: 'https://evil.internal/token',
});
const keyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@p.iam.gserviceaccount.com',
  private_key: pem,
});
const context = (signal = new AbortController().signal) => ({
  signal,
  clock: manualClock(1_000_000),
});
const ErrorInfo = (reason: string, metadata?: Record<string, string>) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com',
  ...(metadata ? { metadata } : {}),
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('gcp-common public surface', () => {
  it('exports exactly these names: a new helper cannot leak silently', async () => {
    const module = (await import('@better-compute/gcp-common')) as Record<string, unknown>;
    expect(Object.keys(module).sort()).toEqual([
      'cachedTokenSource',
      'defaultRetryAfterMs',
      'defaultUniverse',
      'googleClient',
      'googleEndpoint',
      'impersonatedTokenSource',
      'mapGoogleError',
      'metadataTokenSource',
      'paginate',
      'resolveUniverse',
      'rpcCodeToHttp',
      'serviceAccountTokenSource',
      'settledOperation',
      'tokenEndpoint',
    ]);
  });
});

describe('gcp-common token sources', () => {
  it('provider-gcp re-exports the same token sources', () => {
    for (const name of [
      'serviceAccountTokenSource',
      'metadataTokenSource',
      'impersonatedTokenSource',
      'cachedTokenSource',
    ] as const)
      expect(gcp[name]).toBe(common[name]);
  });

  it('the token_uri pin holds through both packages', () => {
    const fetch = vi.fn();
    for (const make of [common.serviceAccountTokenSource, gcp.serviceAccountTokenSource]) {
      let caught: unknown;
      try {
        make(evilKeyJson, { fetch });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { provider: 'gcp', reason: 'tokenUri' },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('every configuration error carries details.reason', () => {
  const invalid = (reason: string) =>
    expect.objectContaining({ code: 'INVALID_CONFIG', details: { provider: 'gcp', reason } });

  it('names the reason of each key and email error, with no invented status', async () => {
    expect(() => common.serviceAccountTokenSource('not json')).toThrow(invalid('keyJson'));
    expect(() => common.serviceAccountTokenSource('{}')).toThrow(invalid('keyFields'));
    expect(() =>
      common.serviceAccountTokenSource(JSON.stringify({ client_email: 'a@b', private_key: 1 })),
    ).toThrow(invalid('keyFields'));
    expect(() => common.impersonatedTokenSource({ token: async () => 'b' }, 'a b@c.iam')).toThrow(
      invalid('impersonateEmail'),
    );
    const fetch = vi.fn();
    const unsigned = common.serviceAccountTokenSource(
      JSON.stringify({ client_email: 'sa@p.iam', private_key: 'not a pem' }),
      { fetch },
    );
    await expect(unsigned.token(context())).rejects.toThrow(invalid('keySign'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the universeDomain, tokenUri and endpoint reasons', () => {
    expect(() =>
      common.serviceAccountTokenSource(
        JSON.stringify({ client_email: 'a@b', private_key: 'k', universe_domain: 'other.goog' }),
      ),
    ).toThrow(invalid('universeDomain'));
    expect(() => common.serviceAccountTokenSource(evilKeyJson)).toThrow(invalid('tokenUri'));
    expect(() => common.googleEndpoint('Bad')).toThrow(invalid('endpoint'));
  });
});

describe('a refused token request keeps what Google said', () => {
  const target = 'target@p.iam.gserviceaccount.com';
  const impersonate = (fake: FakeGoogle) =>
    common.impersonatedTokenSource(fake.tokens(), target, { fetch: fake.fetch });
  const route = (fake: FakeGoogle, reply: Parameters<FakeGoogle['failNext']>[0]) =>
    fake.route('POST', '/v1/projects/-/serviceAccounts/{email}:generateAccessToken', () => reply);

  it('a 403 SERVICE_DISABLED from IAM Credentials names the reason and the activation link', async () => {
    const activationUrl =
      'https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview?project=1';
    const fake = route(
      new FakeGoogle({ token: 'base-secret' }),
      FakeGoogle.rpcError(403, 'PERMISSION_DENIED', 'IAM Credentials API has not been used', [
        ErrorInfo('SERVICE_DISABLED', { activationUrl }),
      ]),
    );
    const failure = await impersonate(fake)
      .token(context())
      .catch((error: unknown) => error);
    // The error code stays UNAUTHENTICATED for a 4xx, as provider-gcp's callers expect.
    expect(failure).toMatchObject({
      code: 'UNAUTHENTICATED',
      details: { provider: 'gcp', status: 403, reason: 'SERVICE_DISABLED', activationUrl },
    });
    expect(String((failure as Error).message)).not.toContain('base-secret');
  });

  it('reads error.status when there is no ErrorInfo, and falls back to token_request_failed', async () => {
    const denied = route(
      new FakeGoogle(),
      FakeGoogle.rpcError(403, 'PERMISSION_DENIED', 'no iam.serviceAccounts.getAccessToken'),
    );
    await expect(impersonate(denied).token(context())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      details: { status: 403, reason: 'PERMISSION_DENIED' },
    });
    const bare = route(new FakeGoogle(), { status: 403, body: { error: { message: 'x' } } });
    const failure = await impersonate(bare)
      .token(context())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ details: { reason: 'token_request_failed' } });
    expect((failure as { details: Record<string, unknown> }).details).not.toHaveProperty(
      'activationUrl',
    );
  });

  it('a 5xx google.rpc.Status is still UNAVAILABLE, with its reason', async () => {
    const fake = route(new FakeGoogle(), FakeGoogle.rpcError(503, 'UNAVAILABLE', 'try later'));
    await expect(impersonate(fake).token(context())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { provider: 'gcp', status: 503, reason: 'UNAVAILABLE' },
    });
  });

  it('an OAuth error code keeps being the reason', async () => {
    const source = common.serviceAccountTokenSource(keyJson, {
      fetch: (async () =>
        json(400, { error: 'invalid_grant', error_description: 'bad' })) as typeof fetch,
    });
    await expect(source.token(context())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Google refused the token request (400 invalid_grant)',
      details: { provider: 'gcp', status: 400, reason: 'invalid_grant' },
    });
  });
});

describe('a shared token request outlives any one caller', () => {
  /** A metadata server that answers when the test says so. */
  function gate() {
    const signals: AbortSignal[] = [];
    let answer: (() => void) | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        answer = () => resolve(json(200, { access_token: 'tok', expires_in: 3600 }));
      });
    }) as typeof fetch;
    return { fetchImpl, signals, answer: () => answer!() };
  }
  const reasonOf = (label: string) => new Error(`aborted by ${label}`);

  it('caller A aborting rejects A with its own reason; B still gets the token', async () => {
    const { fetchImpl, signals, answer } = gate();
    const source = common.metadataTokenSource({ fetch: fetchImpl });
    const a = new AbortController();
    const b = new AbortController();
    const first = source.token(context(a.signal));
    const second = source.token(context(b.signal));
    const reason = reasonOf('A');
    const firstRejects = expect(first).rejects.toBe(reason);
    a.abort(reason);
    await firstRejects;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    answer();
    await expect(second).resolves.toBe('tok');
  });

  it('the request is aborted once every caller has gone, and the next caller starts a new one', async () => {
    const { fetchImpl, signals, answer } = gate();
    const source = common.metadataTokenSource({ fetch: fetchImpl });
    const a = new AbortController();
    const b = new AbortController();
    const first = source.token(context(a.signal));
    const second = source.token(context(b.signal));
    const [reasonA, reasonB] = [reasonOf('A'), reasonOf('B')];
    const settled = Promise.all([
      expect(first).rejects.toBe(reasonA),
      expect(second).rejects.toBe(reasonB),
    ]);
    a.abort(reasonA);
    expect(signals[0]!.aborted).toBe(false);
    b.abort(reasonB);
    await settled;
    expect(signals[0]!.aborted).toBe(true);
    const third = source.token(context());
    expect(signals).toHaveLength(2);
    answer();
    await expect(third).resolves.toBe('tok');
  });

  it('a signal that is already aborted rejects with its reason without a request', async () => {
    const fetchImpl = vi.fn();
    const source = common.metadataTokenSource({ fetch: fetchImpl });
    const controller = new AbortController();
    const reason = reasonOf('early');
    controller.abort(reason);
    await expect(source.token(context(controller.signal))).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failed request is seen by every waiter and does not poison the next call', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? json(503, { error: { status: 'UNAVAILABLE' } })
        : json(200, { access_token: 'tok', expires_in: 3600 });
    }) as typeof fetch;
    const source = common.metadataTokenSource({ fetch: fetchImpl });
    const results = await Promise.allSettled([source.token(context()), source.token(context())]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    await expect(source.token(context())).resolves.toBe('tok');
  });
});
