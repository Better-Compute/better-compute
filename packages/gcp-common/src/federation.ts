import { ComputeError, type Clock } from '@better-compute/core';
import type { TokenSource } from './auth.js';
import { googleEndpoint, resolveUniverse } from './endpoints.js';
import { authError, cacheMinted, call, unknownLifetimeMs, type Minted } from './internal/token.js';

// Workload identity federation: the control plane signs a short-lived identity token for a tenant
// (see @better-compute/pki workloadIssuer) and Google's Security Token Service exchanges it for a
// federated access token, so a tenant's Google account is connected without any key of theirs. A
// subject token and the access token it buys are only ever returned to the caller; neither is
// logged, nor put in an error message or in `details`.

const cloudPlatform = 'https://www.googleapis.com/auth/cloud-platform';
const audiencePattern =
  /^\/\/iam\.[a-z0-9.-]+\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;

function audienceError(message: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'gcp',
    reason: 'federationAudience',
  });
}

/**
 * The audience is the workload identity pool provider's resource name. It must be well formed, and
 * its host must be the configured universe's IAM: otherwise a tenant could route its federation
 * through another universe's IAM, around the universe pin.
 */
function checkAudience(audience: unknown, universe: string): string {
  if (typeof audience !== 'string' || !audiencePattern.test(audience))
    throw audienceError(
      'The federation audience must be //iam.<universe>/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>',
    );
  const host = audience.slice(2, audience.indexOf('/', 2));
  if (host !== `iam.${universe}`)
    throw audienceError(`The federation audience must be on iam.${universe}`);
  return audience;
}

/**
 * One STS token exchange, uncached (for probes). A refusal (an attribute condition, a bad token) is
 * UNAUTHENTICATED with `details.reason` the STS `error` (`invalid_grant`); STS 5xx or an unreachable
 * STS is UNAVAILABLE. A malformed audience, or one on another universe's IAM, is INVALID_CONFIG
 * (`federationAudience`) before anything is sent.
 */
export async function stsExchange(options: {
  audience: string;
  subjectToken: string;
  fetch?: typeof fetch;
  universeDomain?: string;
  signal: AbortSignal;
}): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const universe = resolveUniverse(options.universeDomain);
  const audience = checkAudience(options.audience, universe);
  const url = `${googleEndpoint('sts', { universeDomain: universe })}/v1/token`;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const payload = await call(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: cloudPlatform,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: options.subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    }).toString(),
    signal: options.signal,
  });
  if (typeof payload.access_token !== 'string' || payload.access_token === '')
    throw authError('STS returned no access token', 200, 'no_token');
  const seconds = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    expiresInSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : unknownLifetimeMs / 1000,
  };
}

/**
 * STS token exchange: a third-party JWT (`subjectToken`, called on each exchange) for a federated
 * Google access token, cached until 60 s before it expires. The source reports its expiry, so
 * `cachedTokenSource` over it keeps the real one.
 */
export function federatedTokenSource(options: {
  audience: string;
  subjectToken: (context: { signal: AbortSignal; clock: Clock }) => Promise<string>;
  fetch?: typeof fetch;
  universeDomain?: string;
}): TokenSource {
  const universe = resolveUniverse(options.universeDomain);
  const audience = checkAudience(options.audience, universe);
  return cacheMinted(async (context): Promise<Minted> => {
    const subjectToken = await options.subjectToken({
      signal: context.signal,
      clock: context.clock,
    });
    const { accessToken, expiresInSeconds } = await stsExchange({
      audience,
      subjectToken,
      fetch: options.fetch,
      universeDomain: universe,
      signal: context.signal,
    });
    return { token: accessToken, expiresAt: context.clock.now() + expiresInSeconds * 1000 };
  }, 60_000);
}
