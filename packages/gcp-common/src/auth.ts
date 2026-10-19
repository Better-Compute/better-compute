import { createSign } from 'node:crypto';
import { ComputeError, type Clock } from '@better-compute/core';
import { defaultUniverse, googleEndpoint, resolveUniverse, tokenEndpoint } from './endpoints.js';
import {
  authError,
  cacheMinted,
  call,
  expiring,
  lifetimeMs,
  unknownLifetimeMs,
  type ExpiringTokenSource,
} from './internal/token.js';

// Google access tokens, three ways: a service-account key (a signed JWT exchanged at the OAuth
// token endpoint), the metadata server (on GCE/GKE), and impersonation of another service account.
// Every source below caches its token until shortly before it expires (the machinery is in
// internal/token.ts). A token is only ever returned to the caller; it is never logged, and never
// put in an error message.

export interface TokenSource {
  token(context: { signal: AbortSignal; clock: Clock }): Promise<string>;
}

const cloudPlatform = 'https://www.googleapis.com/auth/cloud-platform';
const defaultTokenUri = tokenEndpoint();
/**
 * The token endpoints a key may name in the default universe: Google's, and the older alias keys
 * still carry. A tenant supplies the key, and the control plane POSTs to its `token_uri`, so any
 * other URL is refused rather than fetched (SSRF into the platform's network). Another universe
 * allows exactly its own `tokenEndpoint(universe)`; the universe comes from the host's options and
 * never from the key.
 */
const allowedTokenUris: ReadonlySet<string> = new Set([
  defaultTokenUri,
  'https://accounts.google.com/o/oauth2/token',
]);
const metadataTokenUrl =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  universe_domain?: unknown;
}

/**
 * Parses a tenant-supplied key and pins what it may steer. `universe` is the host's configured
 * universe (already validated): the key's own universe_domain must equal it, and never selects it.
 */
function parseKey(keyJson: string, universe: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(keyJson) as Partial<ServiceAccountKey>;
  } catch {
    throw new ComputeError(
      'INVALID_CONFIG',
      'The service-account key is not valid JSON',
      undefined,
      { provider: 'gcp', reason: 'keyJson' },
    );
  }
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string')
    throw new ComputeError(
      'INVALID_CONFIG',
      'The service-account key needs client_email and private_key',
      undefined,
      { provider: 'gcp', reason: 'keyFields' },
    );
  // A key without universe_domain is a default-universe key. Present, it must be the configured one.
  const keyUniverse = key.universe_domain === undefined ? defaultUniverse : key.universe_domain;
  if (keyUniverse !== universe)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The service-account key belongs to another universe than the configured ${universe}`,
      undefined,
      { provider: 'gcp', reason: 'universeDomain' },
    );
  const pinned = tokenEndpoint(universe);
  const allowed = universe === defaultUniverse ? allowedTokenUris : new Set([pinned]);
  if (key.token_uri !== undefined && !allowed.has(key.token_uri))
    throw new ComputeError(
      'INVALID_CONFIG',
      `The service-account key's token_uri must be ${pinned}`,
      undefined,
      { provider: 'gcp', reason: 'tokenUri' },
    );
  return key as ServiceAccountKey;
}

/**
 * Mints tokens from a service-account key (a JWT bearer grant); cached until a minute before expiry.
 * `universeDomain` is the host's universe (default googleapis.com): the key must belong to it and
 * may name only its token endpoint.
 */
export function serviceAccountTokenSource(
  keyJson: string,
  options: { fetch?: typeof fetch; scopes?: string[]; universeDomain?: string } = {},
): TokenSource {
  const universe = resolveUniverse(options.universeDomain);
  const key = parseKey(keyJson, universe);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const scope = (options.scopes ?? [cloudPlatform]).join(' ');
  const tokenUri = key.token_uri ?? tokenEndpoint(universe);
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
      throw new ComputeError(
        'INVALID_CONFIG',
        'The service-account private key cannot sign',
        undefined,
        { provider: 'gcp', reason: 'keySign' },
      );
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
  options: { fetch?: typeof fetch; universeDomain?: string } = {},
): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const iamEndpoint = googleEndpoint('iamcredentials', { universeDomain: options.universeDomain });
  if (!/^[^/:?#\s]+$/.test(targetEmail))
    throw new ComputeError(
      'INVALID_CONFIG',
      'The impersonated service account is not an email',
      undefined,
      { provider: 'gcp', reason: 'impersonateEmail' },
    );
  const url = `${iamEndpoint}/v1/projects/-/serviceAccounts/${targetEmail}:generateAccessToken`;
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
