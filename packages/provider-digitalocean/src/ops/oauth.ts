import {
  ComputeError,
  type Clock,
  type Logger,
  type ProviderContext,
  type SecretRef,
} from '@better-compute/core';

// OAuth accounts (DigitalOcean P9, DO-D13): "Connect a DigitalOcean account" stores a refresh token as the account's
// secret (`refreshToken`) instead of a personal access token. The provider exchanges it at DigitalOcean's token
// endpoint for an access token (30 days), and the refresh token rotates on every exchange, so:
// - The rotated refresh token is written back over the same secret through the host's `rotate` hook (its secret
//   store) before anything else uses it: three attempts, then `digitalocean.oauthRotateFailed` is logged and the
//   rotated token is kept in memory for the next exchange (the stored one is dead by then).
// - Every exchange reads the refresh token from the store, so a token another process rotated is the one used; an
//   `invalid_grant` re-reads the store once, in case another process rotated it between the read and the exchange.
// - One exchange at a time per secret in this process.
// - A dead grant is `INVALID_CONFIG` (`reason 'oauthGrant'`): the account must be connected again.
// The OAuth app's client id and secret are the platform's (a code-level option), never a tenant's. No token, code
// or client secret ever reaches a log line, an error message or its details. The endpoint is https only.

/** DigitalOcean's token endpoint. */
export const defaultOAuthEndpoint = 'https://cloud.digitalocean.com/v1/oauth/token';

/** The host's side of OAuth accounts (`digitaloceanProvider({ oauth })`). */
export interface DoOAuthOptions {
  /** Writes a rotated refresh token over the account's secret (`SecretStore.put(tenantId, value, { ref })`). */
  rotate(input: { ref: SecretRef; value: string; tenantId: string }): Promise<void>;
  /** The platform OAuth app's client id. */
  clientId: string;
  /** The platform OAuth app's client secret, from the host (never a tenant secret). */
  clientSecret: () => Promise<string>;
  /** Default `https://cloud.digitalocean.com/v1/oauth/token`; https only. */
  endpoint?: string;
}

export interface DoOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope?: string;
  account?: { uuid?: string; name?: string; email?: string };
}

const writeAttempts = 3;
const writeBackoffMs = [100, 300];
const exchangeTimeoutMs = 30_000;

function oauthError(
  code: 'INVALID_CONFIG' | 'INVALID_INPUT' | 'UNAVAILABLE' | 'PROVIDER_ERROR',
  message: string,
  reason: string,
  status?: number,
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean',
    reason,
    ...(status !== undefined ? { status } : {}),
  });
}

/** The endpoint as a URL, refused unless https. */
function endpointOf(endpoint: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(endpoint ?? defaultOAuthEndpoint);
  } catch {
    throw oauthError(
      'INVALID_CONFIG',
      'The DigitalOcean OAuth endpoint is not a URL',
      'oauthEndpoint',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw oauthError(
      'INVALID_CONFIG',
      'The DigitalOcean OAuth endpoint must be https',
      'oauthEndpoint',
    );
  return url;
}

/** One POST to the token endpoint; parameters in the query, as DigitalOcean documents them. */
async function tokenRequest(
  params: Record<string, string>,
  options: { fetch: typeof fetch; endpoint?: string; clock: Clock; signal: AbortSignal },
  invalidGrant: 'INVALID_CONFIG' | 'INVALID_INPUT',
): Promise<DoOAuthTokens> {
  const url = endpointOf(options.endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await options.fetch(url.toString(), {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw oauthError('UNAVAILABLE', 'DigitalOcean OAuth unreachable', 'network', 0);
  }
  let body: Record<string, unknown> = {};
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (response.status >= 500)
    throw oauthError(
      'UNAVAILABLE',
      'DigitalOcean OAuth is unavailable',
      'oauthServer',
      response.status,
    );
  if (!response.ok) {
    const error = typeof body.error === 'string' ? body.error : '';
    if (error === 'invalid_client')
      throw oauthError(
        'INVALID_CONFIG',
        'DigitalOcean refused the OAuth client id or secret',
        'oauthClient',
        response.status,
      );
    throw oauthError(
      invalidGrant,
      invalidGrant === 'INVALID_CONFIG'
        ? 'DigitalOcean refused the account’s refresh token: connect the account again'
        : 'DigitalOcean refused the authorization code',
      'oauthGrant',
      response.status,
    );
  }
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const expiresIn = Number(body.expires_in);
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    typeof refreshToken !== 'string' ||
    !refreshToken
  )
    throw oauthError(
      'PROVIDER_ERROR',
      'DigitalOcean OAuth answered without tokens',
      'badBody',
      response.status,
    );
  const info = (body.info ?? {}) as Record<string, unknown>;
  const account = Object.fromEntries(
    (['uuid', 'name', 'email'] as const)
      .filter((key) => typeof info[key] === 'string')
      .map((key) => [key, info[key] as string]),
  );
  return {
    accessToken,
    refreshToken,
    // A missing lifetime is taken as one hour, so the token is refreshed early rather than late.
    expiresAt:
      options.clock.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    ...(Object.keys(account).length ? { account } : {}),
  };
}

/**
 * The connect flow's server side: trades an authorization code (single use) for tokens. The caller seals the
 * refresh token as the new account's secret and drops the rest. `INVALID_INPUT` for a code DigitalOcean refuses.
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  endpoint?: string;
  clock: Clock;
  signal: AbortSignal;
}): Promise<DoOAuthTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    },
    {
      fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      clock: input.clock,
      signal: input.signal,
    },
    'INVALID_INPUT',
  );
}

/** Exchanges in flight, by secret ref: one at a time per secret in this process. */
const inFlight = new Map<SecretRef, Promise<{ token: string; expiresAt: number }>>();
/** Rotated refresh tokens the store did not take yet, by secret ref (memory only). */
const unwritten = new Map<SecretRef, string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The access-token source of an OAuth account, for the API client: each call exchanges the stored (or the unwritten
 * rotated) refresh token and answers the access token with its expiry; the client keeps it until then.
 */
export function oauthTokenSource(
  ref: SecretRef,
  context: Pick<ProviderContext, 'secrets' | 'clock' | 'log' | 'account'>,
  options: DoOAuthOptions,
  fetchImpl: typeof fetch,
): () => Promise<{ token: string; expiresAt: number }> {
  const tenantId = context.account?.tenantId;
  const log: Logger = context.log;

  async function persist(value: string): Promise<void> {
    unwritten.set(ref, value);
    for (let attempt = 0; attempt < writeAttempts; attempt++) {
      try {
        await options.rotate({ ref, value, tenantId: tenantId! });
        if (unwritten.get(ref) === value) unwritten.delete(ref);
        return;
      } catch {
        if (attempt < writeAttempts - 1) await sleep(writeBackoffMs[attempt] ?? 300);
      }
    }
    log.error('digitalocean.oauthRotateFailed', { account: context.account?.id });
  }

  async function exchange(): Promise<{ token: string; expiresAt: number }> {
    const signal = AbortSignal.timeout(exchangeTimeoutMs);
    const clientSecret = await options.clientSecret();
    const grant = (refresh: string) =>
      tokenRequest(
        {
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: options.clientId,
          client_secret: clientSecret,
        },
        {
          fetch: fetchImpl,
          ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
          clock: context.clock,
          signal,
        },
        'INVALID_CONFIG',
      );
    const held = unwritten.get(ref);
    const first = held ?? (await context.secrets.resolve(ref));
    let tokens: DoOAuthTokens;
    try {
      tokens = await grant(first);
    } catch (error) {
      if (!(error instanceof ComputeError) || error.details?.reason !== 'oauthGrant') throw error;
      // Another process may have rotated it between the read and the exchange.
      const again = await context.secrets.resolve(ref);
      if (again === first) throw error;
      tokens = await grant(again);
    }
    await persist(tokens.refreshToken);
    log.info('digitalocean.oauthExchanged', { account: context.account?.id });
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  return () => {
    const pending = inFlight.get(ref);
    if (pending) return pending;
    const started = exchange().finally(() => {
      if (inFlight.get(ref) === started) inFlight.delete(ref);
    });
    inFlight.set(ref, started);
    return started;
  };
}

/** Forgets the in-process OAuth state (tests). */
export function resetOAuthState(): void {
  inFlight.clear();
  unwritten.clear();
}
