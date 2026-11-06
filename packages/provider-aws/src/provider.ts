import { ec2Client, jsonClient } from '@better-compute/aws-core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { accountCredentials } from './account.js';
import { AwsCompute } from './compute.js';
import { awsConfig, validateAwsConfig, type AwsConfig, type AwsProviderOptions } from './config.js';
import { describeOfferingId } from './markets/purchases.js';
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
    describeOffering: describeOfferingId,
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
      const quotas = jsonClient({
        service: 'servicequotas',
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        jsonVersion: '1.1',
        targetPrefix: 'ServiceQuotasV20190624',
        ...(options.endpoints?.servicequotas !== undefined
          ? { endpoint: options.endpoints.servicequotas }
          : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      const pricing =
        config.pricing === 'off'
          ? undefined
          : jsonClient({
              service: 'pricing',
              region: config.region,
              credentials: account.source,
              fetch: options.fetch,
              clock: context.clock,
              log: context.log,
              jsonVersion: '1.1',
              targetPrefix: 'AWSPriceListService',
              ...(options.endpoints?.pricing !== undefined
                ? { endpoint: options.endpoints.pricing }
                : {}),
              ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
            });
      const compute = new AwsCompute(config, context, options, {
        ec2,
        quotas,
        ...(pricing ? { pricing } : {}),
        account,
        types: instanceTypeCache(ec2, { clock: context.clock }),
        zones: zoneCache(ec2, { clock: context.clock }),
      });
      // Purchases off (the default): the client cannot buy at all, so vps refuses a purchase
      // before recording it. (purchaseReservation also refuses on its own.)
      if (!config.allowPurchases)
        Object.defineProperty(compute, 'purchaseReservation', { value: undefined });
      return compute;
    },
  });
}

/** The provider with default options (the host's ambient AWS identity for platform accounts). */
export const aws: ProviderDefinition<AwsConfig> = awsProvider();
