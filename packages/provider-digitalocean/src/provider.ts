import { ComputeError, type ProviderContext } from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { clientFor } from './client/build.js';
import { DoCompute } from './compute/droplets.js';
import { doConfig, type DoConfig, type DoProviderOptions } from './config.js';
import { deploymentTag } from './ids.js';
import { doBilling, readInvoiceCosts } from './ops/costs.js';
import { doConnect } from './ops/oauth.js';
import { withTenantProjects } from './ops/projects.js';
import { readFindings } from './ops/security.js';
import { checkReport, probeAccount } from './probe.js';

const maxInCallWaitMs = 20_000;
const discoverTagPattern = /^[a-z0-9:_-]{1,255}$/;

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
  const connect = options.oauth
    ? doConnect(options.oauth, options.fetch ?? globalThis.fetch.bind(globalThis))
    : undefined;
  return defineProvider<DoConfig>({
    id: 'digitalocean',
    version: '0.1.0',
    provides: ['vps'],
    config: doConfig as unknown as ProviderDefinition<DoConfig>['config'],
    capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'networks'],
    billing: doBilling,
    // "Connect a DigitalOcean account" (P9): only when the host registered a redirect URI for its OAuth app.
    ...(connect ? { connect } : {}),
    // providerAccounts.check (P9): the read scopes, the operations ones as optional.
    probeAccount: async (config: DoConfig, context) =>
      checkReport(await probeAccount(config, context, options, { operations: true })),
    // providerAccounts.findings (P9): the latest security scan.
    findings: (config: DoConfig, context) => readFindings(config, context, options),
    create: (config: DoConfig, context: ProviderContext) => {
      if (config.regions.length === 0)
        throw invalidConfig('A DigitalOcean account lists at least one region', 'regions');
      // A tag as DO stores it: discovery filters by it as given (`tag_name`) and matches the GPU
      // list against it, so a spelling DO would read differently is refused, not lower-cased.
      if (config.discoverTag !== undefined && !discoverTagPattern.test(config.discoverTag))
        throw invalidConfig(
          `discoverTag ${JSON.stringify(config.discoverTag)} is not a DigitalOcean tag: lower-case [a-z0-9:_-], at most 255 characters`,
          'discoverTag',
        );
      const inCallWaitMs = options.inCallWaitMs ?? 0;
      if (!Number.isInteger(inCallWaitMs) || inCallWaitMs < 0 || inCallWaitMs > maxInCallWaitMs)
        throw invalidConfig(
          `inCallWaitMs must be a whole number of milliseconds from 0 to ${maxInCallWaitMs}`,
          'inCallWaitMs',
        );
      const deployment = options.deployment ?? 'default';
      const client = clientFor(config, context, options);
      const compute = new DoCompute(config, context, { deployment, inCallWaitMs }, client);
      if (config.costs === true) {
        const tag = deploymentTag(deployment);
        compute.costs = (window, call) => readInvoiceCosts(client, tag, window, call);
      }
      if (config.projectPerTenant === true) withTenantProjects(compute, client, context.log);
      return compute;
    },
  });
}

/** The DigitalOcean provider (`vps({ providers: [digitalocean] })`). */
export const digitalocean: ProviderDefinition<DoConfig> = digitaloceanProvider();
