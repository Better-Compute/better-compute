import { ComputeError, type ProviderContext } from '@better-compute/core';
import type { DoConfig, DoProviderOptions } from '../config.js';
import { budgetFor } from './budget.js';
import { oauthTokenSource } from '../ops/oauth.js';
import { doClient, type DoClient } from './http.js';

export const defaultEndpoint = 'https://api.digitalocean.com/v2';

/**
 * The client an account's provider and its probe share: no request is made and the token is not
 * resolved until the first call, and the request budget it spends from is the token's own, shared
 * with every other client of that token. An OAuth account (`refreshToken`) exchanges its refresh token for an
 * access token, and needs the host's `oauth` option; an account with both or neither credential is refused.
 */
export function clientFor(
  config: DoConfig,
  context: ProviderContext,
  options: DoProviderOptions,
): DoClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const refuse = (message: string, reason: string) =>
    new ComputeError('INVALID_CONFIG', message, undefined, { provider: 'digitalocean', reason });
  if ((config.token === undefined) === (config.refreshToken === undefined))
    throw refuse(
      'A DigitalOcean account holds exactly one of token and refreshToken',
      'credential',
    );
  let token: (hint?: {
    refused?: string;
  }) => Promise<string | { token: string; expiresAt: number }>;
  if (config.refreshToken !== undefined) {
    if (!options.oauth)
      throw refuse(
        'This host cannot keep DigitalOcean OAuth accounts: it configures no oauth option to rotate refresh tokens',
        'oauthUnsupported',
      );
    if (!context.account?.tenantId)
      throw refuse(
        'An OAuth account needs its provider account to write the rotated token to',
        'oauthAccount',
      );
    token = oauthTokenSource(config.refreshToken, context, options.oauth, fetchImpl);
  } else {
    const ref = config.token!;
    token = () => context.secrets.resolve(ref);
  }
  return doClient({
    fetch: fetchImpl,
    endpoint: options.endpoint ?? defaultEndpoint,
    token,
    budget: (hash) =>
      budgetFor(hash, {
        perMinute: options.budget?.perMinute ?? 250,
        perHour: options.budget?.perHour ?? 5000,
        clock: context.clock,
      }),
    clock: context.clock,
    log: context.log,
  });
}
