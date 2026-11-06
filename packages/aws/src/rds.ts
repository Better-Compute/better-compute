import { ComputeError, systemClock } from '@better-compute/core';
import type { AwsServiceOptions } from './common.js';
import { presignUrl } from './internal/sigv4.js';
import { assertRegion } from './internal/transport.js';

export interface RdsAuthTokenOptions extends AwsServiceOptions {
  hostname: string;
  /** Default 5432. */
  port?: number;
  username: string;
}

const lifetimeSeconds = 900;
const refreshBeforeMs = 3 * 60_000;
const hostnamePattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function check(options: RdsAuthTokenOptions): { hostname: string; port: number } {
  assertRegion(options.region);
  if (typeof options.hostname !== 'string' || options.hostname.length > 253 || !hostnamePattern.test(options.hostname))
    throw new ComputeError('INVALID_CONFIG', 'not a database host name');
  const port = options.port ?? 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ComputeError('INVALID_CONFIG', 'not a port');
  if (typeof options.username !== 'string' || !/^[A-Za-z0-9_.@+-]{1,63}$/.test(options.username))
    throw new ComputeError('INVALID_CONFIG', 'not a database user name');
  return { hostname: options.hostname.toLowerCase(), port };
}

/**
 * A 15-minute RDS IAM authentication token: a SigV4-presigned `connect` URL for service `rds-db`,
 * without the scheme. It is a password: never log it.
 */
export async function rdsAuthToken(options: RdsAuthTokenOptions): Promise<string> {
  return (await mintRdsAuthToken(options)).token;
}

/** The token and when the credentials that signed it expire (temporary credentials only). */
async function mintRdsAuthToken(options: RdsAuthTokenOptions): Promise<{ token: string; credentialsExpireAt?: number }> {
  const { hostname, port } = check(options);
  const clock = options.clock ?? systemClock;
  const credentials = await options.credentials.credentials({ signal: new AbortController().signal, clock });
  const url = new URL(`https://${hostname}:${port}/`);
  url.searchParams.set('Action', 'connect');
  url.searchParams.set('DBUser', options.username);
  const signed = presignUrl({
    method: 'GET',
    url,
    headers: {},
    service: 'rds-db',
    region: options.region,
    credentials,
    now: clock.now(),
    expiresInSeconds: lifetimeSeconds,
  });
  return {
    token: signed.replace(/^https:\/\//, ''),
    ...(credentials.expiresAt !== undefined ? { credentialsExpireAt: credentials.expiresAt } : {}),
  };
}

/**
 * A memoizing provider for `pg`'s `password: () => Promise<string>`: one token at a time
 * (single-flight), refreshed three minutes before it expires, or before the temporary credentials
 * that signed it expire (IRSA, ECS, IMDS) when that is sooner: a token stops working with them.
 */
export function rdsAuthTokenProvider(options: RdsAuthTokenOptions): () => Promise<string> {
  check(options);
  const clock = options.clock ?? systemClock;
  let current: { token: string; refreshAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return () => {
    if (current && clock.now() < current.refreshAt) return Promise.resolve(current.token);
    pending ??= (async () => {
      const minted = clock.now();
      try {
        const { token, credentialsExpireAt } = await mintRdsAuthToken(options);
        const tokenRefresh = minted + lifetimeSeconds * 1000 - refreshBeforeMs;
        current = {
          token,
          refreshAt:
            credentialsExpireAt === undefined ? tokenRefresh : Math.min(tokenRefresh, credentialsExpireAt - refreshBeforeMs),
        };
        return token;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
