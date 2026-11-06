import { ec2Client, jsonClient } from '@better-compute/aws-core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { accountCredentials } from './account.js';
import { AwsCompute } from './compute.js';
import { awsConfig, validateAwsConfig, type AwsConfig, type AwsProviderOptions } from './config.js';
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
      // A4: the event-intake queue, when the account has one (SQS JSON 1.0 protocol).
      const sqs =
        config.eventQueueUrl === undefined
          ? undefined
          : jsonClient({
              service: 'sqs',
              region: config.region,
              credentials: account.source,
              fetch: options.fetch,
              clock: context.clock,
              log: context.log,
              jsonVersion: '1.0',
              targetPrefix: 'AmazonSQS',
              ...(options.endpoints?.sqs !== undefined ? { endpoint: options.endpoints.sqs } : {}),
              ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
            });
      return new AwsCompute(config, context, options, {
        ec2,
        ...(sqs ? { sqs } : {}),
        account,
        types: instanceTypeCache(ec2, { clock: context.clock }),
        zones: zoneCache(ec2, { clock: context.clock }),
      });
    },
  });
}

/** The provider with default options (the host's ambient AWS identity for platform accounts). */
export const aws: ProviderDefinition<AwsConfig> = awsProvider();
