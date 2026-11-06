import { ec2Client, getCallerIdentity, restClient } from '@better-compute/aws-core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { accountCredentials } from './account.js';
import { AwsCompute } from './compute.js';
import { awsConfig, validateAwsConfig, type AwsConfig, type AwsProviderOptions } from './config.js';
import { AwsKubernetes, EksClient } from './eks/index.js';
import { instanceTypeCache, zoneCache } from './shapes.js';

/**
 * The Amazon EC2 provider, with managed Kubernetes on EKS (`kubernetes`). One account is one AWS account in one region (AD3). Pass `fetch` and
 * `endpoints` to emulate AWS, and `credentials` for the host's own identity, which only platform
 * (root-tenant) accounts may use (F1).
 */
export function awsProvider(options: AwsProviderOptions = {}): ProviderDefinition<AwsConfig> {
  return defineProvider<AwsConfig>({
    id: 'aws',
    version: '0.1.0',
    provides: ['vps'],
    config: awsConfig as unknown as ProviderDefinition<AwsConfig>['config'],
    capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'kubernetes'],
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
      const types = instanceTypeCache(ec2, { clock: context.clock });
      const compute = new AwsCompute(config, context, options, {
        ec2,
        account,
        types,
        zones: zoneCache(ec2, { clock: context.clock }),
      });
      // Managed Kubernetes (EKS) with the same account identity.
      const eks = restClient({
        service: 'eks',
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        ...(options.endpoints?.eks !== undefined ? { endpoint: options.endpoints.eks } : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      let identity: Promise<{ arn: string }> | undefined;
      compute.kubernetes = new AwsKubernetes({
        client: new EksClient(eks),
        ec2,
        types,
        config,
        credentials: account.source,
        identity: async (call) => {
          // The account guards (role hop, platform account) run before the identity is used.
          await account.verify({ signal: call.signal, clock: context.clock });
          identity ??= getCallerIdentity(account.source, {
            region: config.region,
            fetch: options.fetch,
            ...(options.endpoints?.sts !== undefined ? { endpoint: options.endpoints.sts } : {}),
            signal: call.signal,
            clock: context.clock,
          }).catch((error: unknown) => {
            identity = undefined;
            throw error;
          });
          return identity;
        },
        clock: context.clock,
        ...(options.kubeTransport ? { kubeTransport: options.kubeTransport } : {}),
        ...(options.endpoints?.sts !== undefined ? { stsEndpoint: options.endpoints.sts } : {}),
      });
      return compute;
    },
  });
}

/** The provider with default options (the host's ambient AWS identity for platform accounts). */
export const aws: ProviderDefinition<AwsConfig> = awsProvider();
