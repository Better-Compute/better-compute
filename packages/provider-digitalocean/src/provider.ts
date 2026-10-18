import { ComputeError, type ProviderContext } from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { clientFor } from './client/build.js';
import { DoCompute } from './compute/droplets.js';
import { doConfig, type DoConfig, type DoProviderOptions } from './config.js';

const maxInCallWaitMs = 20_000;

function invalidConfig(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'digitalocean',
    reason,
  });
}

/**
 * A DigitalOcean provider definition. Pass `fetch` to emulate the API; `deployment` names the
 * trust domain whose Droplets this control plane may delete.
 *
 * `create` builds a client without a request and without resolving the token (vps builds clients
 * just to validate an account): the token is resolved on the first request, and the request
 * budget it shares with every other client of that token is picked then, by the token's hash.
 */
export function digitaloceanProvider(
  options: DoProviderOptions = {},
): ProviderDefinition<DoConfig> {
  return defineProvider<DoConfig>({
    id: 'digitalocean',
    version: '0.1.0',
    provides: ['vps'],
    config: doConfig as unknown as ProviderDefinition<DoConfig>['config'],
    capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'networks'],
    create: (config: DoConfig, context: ProviderContext) => {
      if (config.regions.length === 0)
        throw invalidConfig('A DigitalOcean account lists at least one region', 'regions');
      const inCallWaitMs = options.inCallWaitMs ?? 0;
      if (!Number.isInteger(inCallWaitMs) || inCallWaitMs < 0 || inCallWaitMs > maxInCallWaitMs)
        throw invalidConfig(
          `inCallWaitMs must be a whole number of milliseconds from 0 to ${maxInCallWaitMs}`,
          'inCallWaitMs',
        );
      return new DoCompute(
        config,
        context,
        { deployment: options.deployment ?? 'default', inCallWaitMs },
        clientFor(config, context, options),
      );
    },
  });
}

/** The DigitalOcean provider (`vps({ providers: [digitalocean] })`). */
export const digitalocean: ProviderDefinition<DoConfig> = digitaloceanProvider();
