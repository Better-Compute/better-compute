import { ec2Client } from '@better-compute/aws-core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { accountCredentials } from './account.js';
import { AwsCompute } from './compute.js';
import { awsConfig, validateAwsConfig, type AwsConfig, type AwsProviderOptions } from './config.js';
import { awsBilling } from './costs.js';
import { finopsMembers } from './finops.js';
import { instanceTypeCache, zoneCache } from './shapes.js';

/**
 * The Amazon EC2 provider. One account is one AWS account in one region (AD3). Pass `fetch` and
 * `endpoints` to emulate AWS, and `credentials` for the host's own identity, which only platform
 * (root-tenant) accounts may use (F1).
 */
export function awsProvider(options: AwsProviderOptions = {}): ProviderDefinition<AwsConfig> {
  return defineProvider<AwsConfig>({
    id: 'aws',
    version: '0.1.0',
    provides: ['vps'],
    config: awsConfig as unknown as ProviderDefinition<AwsConfig>['config'],
    capabilities: ['power', 'reinstall', 'list', 'discover', 'claim'],
    billing: awsBilling,
    create: (config, context) => {
      validateAwsConfig(config);
      const account = accountCredentials(config, context, options);
      const ec2 = ec2Client({
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        ...(options.endpoints?.ec2 !== undefined ? { endpoint: options.endpoints.ec2 } : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      const compute = new AwsCompute(config, context, options, {
        ec2,
        account,
        types: instanceTypeCache(ec2, { clock: context.clock }),
        zones: zoneCache(ec2, { clock: context.clock }),
      });
      // A11: costs (and list prices) beside the EC2 client, present only when the account has them. A member the
      // EC2 client already has (another lane's listPrices, say) is a merge collision: refused, never overwritten.
      const members = finopsMembers(config, context, options, account);
      for (const name of Object.keys(members))
        if (name in compute)
          throw new Error(
            `provider-aws: AwsCompute already has ${name}; the FinOps member collides`,
          );
      return Object.assign(compute, members);
    },
  });
}

/** The provider with default options (the host's ambient AWS identity for platform accounts). */
export const aws: ProviderDefinition<AwsConfig> = awsProvider();
