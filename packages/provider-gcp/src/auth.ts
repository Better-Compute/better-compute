import { createSign } from 'node:crypto';
import { ComputeError, type Clock } from '@better-compute/core';

// Google access tokens, three ways: a service-account key (a signed JWT exchanged at the OAuth
// token endpoint), the metadata server (on GCE/GKE), and impersonation of another service account.
// Every source below caches its token until shortly before it expires. A token is only ever
// returned to the caller; it is never logged, and never put in an error message.

export interface TokenSource {
  token(context: { signal: AbortSignal; clock: Clock }): Promise<string>;
}

type TokenContext = Parameters<TokenSource['token']>[0];

/** A token with its expiry (epoch ms on the context clock). */
interface Minted {
  token: string;
  expiresAt: number;
}

const expiring = Symbol('bc.gcp.expiring');
/** A source that knows when its tokens expire (the ones this module builds). */
interface ExpiringTokenSource extends TokenSource {
  [expiring](context: TokenContext): Promise<Minted>;
}

const cloudPlatform = 'https://www.googleapis.com/auth/cloud-platform';
const defaultTokenUri = 'https://oauth2.googleapis.com/token';
const metadataTokenUrl =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
/** How long a token of unknown lifetime (a custom source) is trusted. */
const unknownLifetimeMs = 300_000;

function authError(message: string, status: number, reason: string): ComputeError {
  return new ComputeError('UNAUTHENTICATED', message, undefined, {
    provider: 'gcp',
    status,
    reason,
  });
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ComputeError('UNAVAILABLE', 'Google token endpoint unreachable', undefined, {
      provider: 'gcp',
      status: 0,
      reason: 'network',
    });
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A non-JSON body is reported by status below.
  }
  if (response.ok) return payload;
  const error = payload.error;
  const reason = typeof error === 'string' ? error : 'token_request_failed';
  if (response.status >= 500)
    throw new ComputeError(
      'UNAVAILABLE',
      `Google token endpoint answered ${response.status}`,
      undefined,
      { provider: 'gcp', status: response.status, reason },
    );
  throw authError(
    `Google refused the token request (${response.status} ${reason})`,
    response.status,
    reason,
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function parseKey(keyJson: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(keyJson) as Partial<ServiceAccountKey>;
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'The service-account key is not valid JSON');
  }
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string')
    throw new ComputeError(
      'INVALID_CONFIG',
      'The service-account key needs client_email and private_key',
    );
  return key as ServiceAccountKey;
}

function lifetimeMs(payload: Record<string, unknown>, now: number): number {
  const seconds = Number(payload.expires_in);
  return now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : unknownLifetimeMs);
}

/** Wraps a minting function with a cache that refreshes `skewMs` before expiry (one flight at a time). */
function cacheMinted(
  mint: (context: TokenContext) => Promise<Minted>,
  skewMs: number,
): ExpiringTokenSource {
  let current: Minted | undefined;
  let inflight: Promise<Minted> | undefined;
  const fresh = async (context: TokenContext): Promise<Minted> => {
    if (current && context.clock.now() < current.expiresAt - skewMs) return current;
    inflight ??= mint(context)
      .then((minted) => (current = minted))
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return {
    async token(context) {
      return (await fresh(context)).token;
    },
    [expiring]: fresh,
  };
}

/** Mints tokens from a service-account key (a JWT bearer grant); cached until a minute before expiry. */
export function serviceAccountTokenSource(
  keyJson: string,
  options: { fetch?: typeof fetch; scopes?: string[] } = {},
): TokenSource {
  const key = parseKey(keyJson);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const scope = (options.scopes ?? [cloudPlatform]).join(' ');
  const tokenUri = key.token_uri ?? defaultTokenUri;
  return cacheMinted(async (context) => {
    const issuedAt = Math.floor(context.clock.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
      JSON.stringify({
        iss: key.client_email,
        scope,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    )}`;
    let signature: Buffer;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
    } catch {
      throw new ComputeError('INVALID_CONFIG', 'The service-account private key cannot sign');
    }
    const payload = await call(fetchImpl, tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64url(signature)}`,
      }).toString(),
      signal: context.signal,
    });
    if (typeof payload.access_token !== 'string')
      throw authError('Google returned no access token', 200, 'no_token');
    return { token: payload.access_token, expiresAt: lifetimeMs(payload, context.clock.now()) };
  }, 60_000);
}

/** Reads tokens from the GCE/GKE metadata server; cached until a minute before expiry. */
export function metadataTokenSource(options: { fetch?: typeof fetch } = {}): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return cacheMinted(async (context) => {
    const payload = await call(fetchImpl, metadataTokenUrl, {
      method: 'GET',
      headers: { 'metadata-flavor': 'Google', accept: 'application/json' },
      signal: context.signal,
    });
    if (typeof payload.access_token !== 'string')
      throw authError('The metadata server returned no access token', 200, 'no_token');
    return { token: payload.access_token, expiresAt: lifetimeMs(payload, context.clock.now()) };
  }, 60_000);
}

/** Exchanges `base`'s token for the target service account's (IAM Credentials generateAccessToken). */
export function impersonatedTokenSource(
  base: TokenSource,
  targetEmail: string,
  options: { fetch?: typeof fetch } = {},
): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!/^[^/:?#\s]+$/.test(targetEmail))
    throw new ComputeError('INVALID_CONFIG', 'The impersonated service account is not an email');
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${targetEmail}:generateAccessToken`;
  return cacheMinted(async (context) => {
    const baseToken = await base.token(context);
    const payload = await call(fetchImpl, url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${baseToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ scope: [cloudPlatform], lifetime: '3600s' }),
      signal: context.signal,
    });
    if (typeof payload.accessToken !== 'string')
      throw authError('IAM Credentials returned no access token', 200, 'no_token');
    // The lifetime requested is measured on the context clock (expireTime is wall-clock).
    return { token: payload.accessToken, expiresAt: context.clock.now() + 3600_000 };
  }, 60_000);
}

/**
 * Caches `inner`'s token until `skewMs` before it expires. Sources built by this module report their
 * expiry; for any other source (a host's workload-identity client) the token is trusted for five
 * minutes, so a custom source should cache itself if it wants longer.
 */
export function cachedTokenSource(inner: TokenSource, skewMs = 60_000): TokenSource {
  if (expiring in inner)
    return cacheMinted((context) => (inner as ExpiringTokenSource)[expiring](context), skewMs);
  return cacheMinted(
    async (context) => ({
      token: await inner.token(context),
      expiresAt: context.clock.now() + unknownLifetimeMs + skewMs,
    }),
    skewMs,
  );
}
