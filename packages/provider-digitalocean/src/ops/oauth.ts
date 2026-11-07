import {
  ComputeError,
  type Clock,
  type Logger,
  type ProviderConnect,
  type ProviderContext,
  type SecretRef,
  type SecretStore,
} from '@better-compute/core';

// OAuth accounts (DigitalOcean P9, DO-D13): "Connect a DigitalOcean account" stores a refresh token as the account's
// secret (`refreshToken`) instead of a personal access token. The provider exchanges it at DigitalOcean's token
// endpoint for an access token (30 days), and the refresh token rotates on every exchange, so:
// - The rotated refresh token is written back over the same secret through the host's `rotate` hook (its secret
//   store) before anything else uses it: three attempts, then `digitalocean.oauthRotateFailed` is logged and the
//   rotated token is kept in memory for the next exchange (the stored one is dead by then).
// - Every exchange reads the refresh token from the store, so a token another process rotated is the one used; an
//   `invalid_grant` re-reads the store a few times over about two seconds (`raceWaitMs`), in case another process
//   rotated it between the read and the exchange and has not written it back yet.
// - One exchange at a time per secret in this process, and one access token per secret: every client of the account
//   (compute, metrics, the probe, findings) shares it until a minute before it expires, or until DigitalOcean
//   refuses it (a 401), so the refresh token rotates about once a month, not once per client.
// - An `invalid_grant` while the store still holds the refused token is `UNAVAILABLE` (`reason 'oauthRace'`,
//   retryable) the first time: another process may still be writing the rotated token back. The same token refused
//   on a later exchange is a dead grant, `INVALID_CONFIG` (`reason 'oauthGrant'`): the account must be connected
//   again. So is a grant refused for the token the store changed to.
// - Only an `invalid_grant` answer (400 or 401) refuses the grant. A 429 is `RATE_LIMITED` (its `retry-after`, else
//   a minute), a 408 `UNAVAILABLE`, `invalid_client` `INVALID_CONFIG` (the platform's app), and any other 4xx
//   (`invalid_request`, an unparsable body) `PROVIDER_ERROR`: retryable, and never counted towards a dead grant, so
//   a rate-limited token endpoint can never fail an account or its instances.
// The token endpoint's parameters go in an `application/x-www-form-urlencoded` body (RFC 6749 §4.1.3, §6), never in
// the URL, which proxies and fetch wrappers log; `tokenParams: 'query'` is the fallback for DigitalOcean's documented
// query form, should the live suite find the body form refused (unverified).
// The OAuth app's client id and secret are the platform's (a code-level option), never a tenant's. No token, code
// or client secret ever reaches a log line, an error message or its details. The endpoint is https only.

/** DigitalOcean's token endpoint. */
export const defaultOAuthEndpoint = 'https://cloud.digitalocean.com/v1/oauth/token';
/** DigitalOcean's revoke endpoint (RFC 7009), for a connected account's grant when vps deletes its credential. */
export const defaultRevokeEndpoint = 'https://cloud.digitalocean.com/v1/oauth/revoke';
/** DigitalOcean's authorization endpoint (the browser goes there to connect an account). */
export const defaultAuthorizeEndpoint = 'https://cloud.digitalocean.com/v1/oauth/authorize';

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
  /**
   * The redirect URIs registered for the OAuth app: "Connect a DigitalOcean account" (`providerAccounts.connect`)
   * is offered only with at least one, and only for these, exactly as written.
   */
  redirectUris?: readonly string[];
  /** The scope the connect flow asks for (default `read write`; DO's granular OAuth scopes are unverified). */
  scope?: string;
  /** Default `https://cloud.digitalocean.com/v1/oauth/authorize`; https only. */
  authorizeEndpoint?: string;
  /** Default `https://cloud.digitalocean.com/v1/oauth/revoke`; https only. */
  revokeEndpoint?: string;
  /**
   * Where the token endpoint's parameters go: `body` (default, form-encoded) or `query` (DigitalOcean's documented
   * form, which puts the client secret and tokens in the URL; a fallback only).
   */
  tokenParams?: 'body' | 'query';
  /**
   * The waits (ms) between re-reads of the store after an `invalid_grant`, for a rotation another process has not
   * written back yet. Default `[250, 750, 1500]`.
   */
  raceWaitMs?: readonly number[];
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
  code: 'INVALID_CONFIG' | 'INVALID_INPUT' | 'UNAVAILABLE' | 'PROVIDER_ERROR' | 'RATE_LIMITED',
  message: string,
  reason: string,
  status?: number,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean',
    reason,
    ...(status !== undefined ? { status } : {}),
    ...extra,
  });
}

const defaultRetryAfterMs = 60_000;
const maxRetryAfterMs = 3_600_000;

/** How long a 429 of the token endpoint says to wait: `retry-after` (seconds or a date), else a minute. */
function retryAfterOf(response: Response, now: number): number {
  const raw = response.headers.get('retry-after')?.trim();
  if (raw) {
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
    if (Number.isFinite(ms)) return Math.min(maxRetryAfterMs, Math.max(0, Math.round(ms)));
  }
  return defaultRetryAfterMs;
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

/** One POST to the token endpoint; parameters form-encoded in the body (or in the query, the fallback). */
async function tokenRequest(
  params: Record<string, string>,
  options: {
    fetch: typeof fetch;
    endpoint?: string;
    clock: Clock;
    signal: AbortSignal;
    tokenParams?: 'body' | 'query';
  },
  invalidGrant: 'INVALID_CONFIG' | 'INVALID_INPUT',
): Promise<DoOAuthTokens> {
  const url = endpointOf(options.endpoint);
  const form = new URLSearchParams(params);
  const inQuery = options.tokenParams === 'query';
  if (inQuery) for (const [key, value] of form) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await options.fetch(url.toString(), {
      method: 'POST',
      headers: inQuery
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      ...(inQuery ? {} : { body: form.toString() }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw oauthError('UNAVAILABLE', 'DigitalOcean OAuth unreachable', 'network', 0);
  }
  let body: Record<string, unknown> = {};
  try {
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
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
  if (response.status === 429)
    throw oauthError(
      'RATE_LIMITED',
      'DigitalOcean OAuth is rate limiting the token request: try again later',
      'oauthRateLimit',
      429,
      { retryAfterMs: retryAfterOf(response, options.clock.now()) },
    );
  if (response.status === 408)
    throw oauthError('UNAVAILABLE', 'DigitalOcean OAuth timed out', 'oauthTimeout', 408);
  if (!response.ok) {
    const error = typeof body.error === 'string' ? body.error : '';
    if (error === 'invalid_client')
      throw oauthError(
        'INVALID_CONFIG',
        'DigitalOcean refused the OAuth client id or secret',
        'oauthClient',
        response.status,
      );
    // Anything but an invalid grant is not the token's fault: retryable, never a dead grant.
    if (error !== 'invalid_grant' || (response.status !== 400 && response.status !== 401))
      throw oauthError(
        'PROVIDER_ERROR',
        'DigitalOcean OAuth refused the token request',
        'oauthRequest',
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
  tokenParams?: 'body' | 'query';
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
      ...(input.tokenParams !== undefined ? { tokenParams: input.tokenParams } : {}),
      clock: input.clock,
      signal: input.signal,
    },
    'INVALID_INPUT',
  );
}

/** Exchanges in flight, by secret ref: one at a time per secret in this process. */
const inFlight = new Map<SecretRef, Promise<{ token: string; expiresAt: number }>>();
/** The account's current access token, by secret ref (memory only), shared by every client of the account. */
const accessTokens = new Map<SecretRef, { token: string; expiresAt: number }>();
/** Rotated refresh tokens the store did not take yet, by secret ref (memory only). */
const unwritten = new Map<SecretRef, string>();
/** A refresh token refused once while the store still held it, by secret ref: refused again, the grant is dead. */
const suspect = new Map<SecretRef, string>();
/**
 * Secret refs whose credential is being revoked (vps is deleting it): no new exchange starts, and an exchange still in
 * flight keeps what it got in memory, for the revoke to withdraw, instead of writing it back (which would seal the
 * deleted ref again). A ref is never reused, so the set only grows by the connected accounts deleted here.
 */
const revokedRefs = new Set<SecretRef>();

const revokedError = () =>
  oauthError(
    'INVALID_CONFIG',
    'The account’s DigitalOcean grant was revoked: connect the account again',
    'oauthRevoked',
  );

/** A cached access token is answered while it has more than this left (the same margin as the client's). */
const freshMarginMs = 60_000;
const defaultRaceWaitMs = [250, 750, 1500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isGrantRefused = (error: unknown) =>
  error instanceof ComputeError && error.details?.reason === 'oauthGrant';

/**
 * The access-token source of an OAuth account, for the API client: answers the account's shared access token while
 * it has more than a minute left and the client did not just see it refused; otherwise exchanges the stored (or the
 * unwritten rotated) refresh token and answers the new access token with its expiry.
 */
export function oauthTokenSource(
  ref: SecretRef,
  context: Pick<ProviderContext, 'secrets' | 'clock' | 'log' | 'account'>,
  options: DoOAuthOptions,
  fetchImpl: typeof fetch,
): (hint?: { refused?: string }) => Promise<{ token: string; expiresAt: number }> {
  const tenantId = context.account?.tenantId;
  const log: Logger = context.log;

  async function persist(value: string): Promise<void> {
    unwritten.set(ref, value);
    if (revokedRefs.has(ref)) return;
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
          ...(options.tokenParams !== undefined ? { tokenParams: options.tokenParams } : {}),
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
      if (!isGrantRefused(error)) throw error;
      // Another process may have rotated it between the read and the exchange, and still be writing it back.
      let again = await context.secrets.resolve(ref);
      for (const wait of options.raceWaitMs ?? defaultRaceWaitMs) {
        if (again !== first) break;
        await sleep(wait);
        again = await context.secrets.resolve(ref);
      }
      if (again === first) {
        // Refused before, with nothing rotated since: the grant is dead.
        if (suspect.get(ref) === first) throw error;
        suspect.set(ref, first);
        log.warn('digitalocean.oauthRace', { account: context.account?.id });
        throw oauthError(
          'UNAVAILABLE',
          'DigitalOcean refused the account’s refresh token while it may be rotating: try again',
          'oauthRace',
        );
      }
      tokens = await grant(again);
    }
    suspect.delete(ref);
    await persist(tokens.refreshToken);
    log.info('digitalocean.oauthExchanged', { account: context.account?.id });
    const access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    accessTokens.set(ref, access);
    if (revokedRefs.has(ref)) throw revokedError();
    return { ...access };
  }

  return (hint) => {
    if (revokedRefs.has(ref)) return Promise.reject(revokedError());
    const cached = accessTokens.get(ref);
    if (cached && hint?.refused === cached.token) accessTokens.delete(ref);
    else if (cached && cached.expiresAt - context.clock.now() > freshMarginMs)
      return Promise.resolve({ ...cached });
    const pending = inFlight.get(ref);
    if (pending) return pending;
    const started = exchange().finally(() => {
      if (inFlight.get(ref) === started) inFlight.delete(ref);
    });
    inFlight.set(ref, started);
    return started;
  };
}

/** Forgets the in-process OAuth state of one account's secret (its credential is being deleted). */
function forgetOAuthState(ref: SecretRef): void {
  revokedRefs.add(ref);
  inFlight.delete(ref);
  accessTokens.delete(ref);
  unwritten.delete(ref);
  suspect.delete(ref);
}

/** What this process holds for a secret ref, as booleans (never a token): diagnostics and tests. */
export function oauthStateOf(ref: SecretRef): {
  accessToken: boolean;
  unwritten: boolean;
  suspect: boolean;
} {
  return {
    accessToken: accessTokens.has(ref),
    unwritten: unwritten.has(ref),
    suspect: suspect.has(ref),
  };
}

/**
 * Revokes tokens of a connected account at DigitalOcean (RFC 7009: `token` and the client's id and secret in a
 * form body, never the URL); an unknown or already revoked token is a 200 there. One request per token; a refusal
 * or an unreachable endpoint throws (the caller deletes the credential anyway).
 */
export async function revokeTokens(input: {
  tokens: readonly string[];
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  endpoint?: string;
  signal: AbortSignal;
}): Promise<void> {
  const url = endpointOf(input.endpoint ?? defaultRevokeEndpoint);
  let failed: ComputeError | undefined;
  for (const token of input.tokens) {
    let status = 0;
    try {
      const response = await input.fetch(url.toString(), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          token,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        }).toString(),
        signal: input.signal,
      });
      await response.text().catch(() => '');
      status = response.status;
      if (response.ok) continue;
    } catch (error) {
      if (input.signal.aborted) throw error;
    }
    failed ??= oauthError(
      status >= 500 || status === 0 ? 'UNAVAILABLE' : 'PROVIDER_ERROR',
      'DigitalOcean did not revoke the account’s OAuth grant',
      'oauthRevoke',
      status,
    );
  }
  if (failed) throw failed;
}

/** Forgets the in-process OAuth state (tests). */
export function resetOAuthState(): void {
  inFlight.clear();
  accessTokens.clear();
  unwritten.clear();
  suspect.clear();
  revokedRefs.clear();
}

/**
 * The host's `rotate` hook over its secret store: the rotated refresh token is written over the account's own
 * secret ref (`SecretStore.put(tenantId, value, { ref })`), so the account keeps naming the same ref.
 */
export function rotateInto(store: Pick<SecretStore, 'put'>): DoOAuthOptions['rotate'] {
  return async ({ ref, value, tenantId }) => {
    await store.put(tenantId, value, { ref });
  };
}

/**
 * "Connect a DigitalOcean account" (`ProviderInput.connect`, P9): the authorization URL for a registered redirect
 * URI, and the code exchange whose refresh token vps seals as the account's `refreshToken`. The access token the
 * exchange also answers is dropped: the account's first request exchanges the refresh token (and rotates it).
 * Undefined unless the host registered at least one redirect URI.
 */
export function doConnect(
  options: DoOAuthOptions,
  fetchImpl: typeof fetch,
): ProviderConnect | undefined {
  const allowed = new Set(options.redirectUris ?? []);
  if (allowed.size === 0) return undefined;
  const registered = (redirectUri: string) => {
    if (!allowed.has(redirectUri))
      throw oauthError(
        'INVALID_INPUT',
        'The redirect URI is not one the platform registered for DigitalOcean',
        'redirectUri',
      );
  };
  return {
    field: 'refreshToken',
    authorizeUrl({ redirectUri, state }) {
      registered(redirectUri);
      const url = endpointOf(options.authorizeEndpoint ?? defaultAuthorizeEndpoint);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', options.scope ?? 'read write');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchange({ code, redirectUri, clock, signal }) {
      registered(redirectUri);
      const tokens = await exchangeAuthorizationCode({
        code,
        redirectUri,
        clientId: options.clientId,
        clientSecret: await options.clientSecret(),
        fetch: fetchImpl,
        ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
        ...(options.tokenParams !== undefined ? { tokenParams: options.tokenParams } : {}),
        clock,
        signal,
      });
      return {
        secret: tokens.refreshToken,
        ...(tokens.account ? { account: { ...tokens.account } } : {}),
      };
    },
    // The account's credential is being deleted: its refresh token (a rotated one not written back yet first) and
    // the access token this process holds are revoked, and the process forgets them whatever DigitalOcean answers.
    async revoke({ ref, secret, signal }) {
      // No exchange starts from here on; one in flight finishes first, so its tokens are withdrawn too.
      revokedRefs.add(ref);
      await inFlight.get(ref)?.catch(() => undefined);
      const tokens = [
        ...new Set(
          [unwritten.get(ref), secret, accessTokens.get(ref)?.token].filter(
            (token): token is string => typeof token === 'string' && token !== '',
          ),
        ),
      ];
      try {
        if (tokens.length === 0) return;
        await revokeTokens({
          tokens,
          clientId: options.clientId,
          clientSecret: await options.clientSecret(),
          fetch: fetchImpl,
          ...(options.revokeEndpoint !== undefined ? { endpoint: options.revokeEndpoint } : {}),
          signal,
        });
      } finally {
        forgetOAuthState(ref);
      }
    },
  };
}
