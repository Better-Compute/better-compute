import { ComputeError, type Clock } from '@better-compute/core';
import type { DoClient } from '../client/http.js';

// Short-lived DigitalOcean Container Registry (DOCR) credentials from
// `GET /v2/registry/docker-credentials`: read-only by default, minutes long, held only in memory
// and renewed before they expire. They are never logged, stored or put in an error.

/** DOCR's registry host. */
export const docrHost = 'registry.digitalocean.com';

export interface DocrCredentials {
  username: string;
  password: string;
  /** Epoch ms after which they are not used. */
  expiresAt: number;
}

export interface DocrCredentialSource {
  get(signal: AbortSignal): Promise<DocrCredentials>;
  /** Drops the cached pair (after the registry refused it). */
  forget(): void;
}

/** Renew this long before the expiry DigitalOcean was asked for. */
const renewMarginMs = 60_000;

function badCredentials(reason: string): ComputeError {
  return new ComputeError(
    'PROVIDER_ERROR',
    'DigitalOcean returned registry credentials that could not be read',
    undefined,
    { provider: 'digitalocean', service: 'registry', reason },
  );
}

export function docrCredentialSource(
  client: DoClient,
  options: { expirySeconds?: number; readWrite?: boolean; clock?: Clock } = {},
): DocrCredentialSource {
  const expirySeconds = options.expirySeconds ?? 600;
  if (!Number.isInteger(expirySeconds) || expirySeconds < 120 || expirySeconds > 3600)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Registry credentials last 120 to 3600 whole seconds',
      undefined,
      { provider: 'digitalocean', service: 'registry', reason: 'expirySeconds' },
    );
  const clock = options.clock ?? client.clock;
  let cached: DocrCredentials | undefined;
  let pending: Promise<DocrCredentials> | undefined;

  async function fetchPair(signal: AbortSignal): Promise<DocrCredentials> {
    const startedAt = clock.now();
    const reply = await client.request<{ auths?: Record<string, { auth?: unknown }> }>(
      'GET',
      '/registry/docker-credentials',
      {
        query: {
          expiry_seconds: String(expirySeconds),
          read_write: options.readWrite ? 'true' : 'false',
        },
        signal,
        budget: 'observe',
      },
    );
    const auth = reply.auths?.[docrHost]?.auth;
    if (typeof auth !== 'string') throw badCredentials('noAuth');
    let decoded: string;
    try {
      decoded = Buffer.from(auth, 'base64').toString('utf8');
    } catch {
      throw badCredentials('badAuth');
    }
    const colon = decoded.indexOf(':');
    if (colon <= 0 || colon === decoded.length - 1) throw badCredentials('badAuth');
    return {
      username: decoded.slice(0, colon),
      password: decoded.slice(colon + 1),
      expiresAt: startedAt + expirySeconds * 1000 - renewMarginMs,
    };
  }

  return {
    async get(signal) {
      if (cached && cached.expiresAt > clock.now()) return cached;
      pending ??= fetchPair(signal).finally(() => {
        pending = undefined;
      });
      cached = await pending;
      return cached;
    },
    forget() {
      cached = undefined;
    },
  };
}
