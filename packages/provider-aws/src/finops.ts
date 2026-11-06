import type { ProviderContext, ProviderImpl } from '@better-compute/core';
import { jsonClient } from '@better-compute/aws-core';
import type { AccountCredentials } from './account.js';
import type { AwsConfig, AwsProviderOptions } from './config.js';
import { costExplorerCosts } from './costs.js';

/**
 * The FinOps members of one account's client (A11): `costs` when the account opts in to Cost Explorer. They are
 * assigned onto the EC2 client, so a member the account does not have stays absent (vps gates on presence).
 */
export function finopsMembers(
  config: AwsConfig,
  context: ProviderContext,
  options: AwsProviderOptions,
  account: AccountCredentials,
): Partial<Pick<ProviderImpl, 'costs'>> {
  const members: Partial<Pick<ProviderImpl, 'costs'>> = {};
  if (config.costs !== undefined && config.costs !== 'off') {
    const ce = jsonClient({
      service: 'ce',
      region: config.region,
      credentials: account.source,
      fetch: options.fetch,
      clock: context.clock,
      log: context.log,
      jsonVersion: '1.1',
      targetPrefix: 'AWSInsightsIndexService',
      ...(options.endpoints?.ce !== undefined ? { endpoint: options.endpoints.ce } : {}),
      // Cost Explorer allows a few requests per second; it is read once a day.
      rateLimit: { perSecond: 2, burst: 4 },
    });
    const costs = costExplorerCosts(
      { ce, account, config, clock: context.clock },
      options.costsCacheMs !== undefined ? { cacheMs: options.costsCacheMs } : {},
    );
    if (costs) members.costs = costs;
  }
  return members;
}
