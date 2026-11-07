import { ComputeError } from '@better-compute/core';
import { ec2Client, getCallerIdentity, jsonClient, restClient } from '@better-compute/aws-core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { accountCredentials } from './account.js';
import { trustPolicy } from './cli.js';
import { AwsCompute } from './compute.js';
import { awsConfig, validateAwsConfig, type AwsConfig, type AwsProviderOptions } from './config.js';
import { describeOfferingId } from './markets/purchases.js';
import { AwsKubernetes, EksClient } from './eks/index.js';
import { checkAwsAccount } from './federation.js';
import { describeAwsAccount } from './onboarding.js';
import { awsBilling } from './costs.js';
import { finopsMembers } from './finops.js';
import { instanceTypeCache, zoneCache } from './shapes.js';

/**
 * The Amazon EC2 provider, with managed Kubernetes on EKS (`kubernetes`). One account is one AWS account in one region (AD3). Pass `fetch` and
 * `endpoints` to emulate AWS, and `credentials` for the host's own identity, which only platform
 * (root-tenant) accounts may use (F1).
 */
export function awsProvider(options: AwsProviderOptions = {}): ProviderDefinition<AwsConfig> {
  // The principal tenants are told to trust (onboarding.platformPrincipalArn): an IAM role or user
  // ARN, as `aws trust-policy --platform-principal` takes, or the host fails at start.
  if (options.platformPrincipalArn !== undefined)
    try {
      trustPolicy({ platformPrincipalArn: options.platformPrincipalArn, externalId: 'better-compute:x' });
    } catch {
      throw new ComputeError(
        'INVALID_CONFIG',
        'awsProvider platformPrincipalArn must be the IAM role or user ARN of the control plane identity',
        undefined,
        { provider: 'aws', reason: 'platformPrincipalArn' },
      );
    }
  return defineProvider<AwsConfig>({
    id: 'aws',
    version: '0.1.0',
    provides: ['vps'],
    config: awsConfig as unknown as ProviderDefinition<AwsConfig>['config'],
    capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'volumes', 'kubernetes'],
    describeOffering: describeOfferingId,
    // A keyless (webIdentityRoleArn) account is proven before it is stored (A7).
    checkAccount: (config, context) => {
      validateAwsConfig(config);
      return checkAwsAccount(config, context, options);
    },
    // What the tenant still sets up at AWS for this account (providerAccounts.get onboarding).
    describeAccount: (config, account) => describeAwsAccount(config, account, options),
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
      // SSM Parameter Store: reinstall resolves resolve:ssm: images to an AMI id with it.
      const ssm = jsonClient({
        service: 'ssm',
        jsonVersion: '1.1',
        targetPrefix: 'AmazonSSM',
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        ...(options.endpoints?.ssm !== undefined ? { endpoint: options.endpoints.ssm } : {}),
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
      const types = instanceTypeCache(ec2, { clock: context.clock });
      // A10: shared filesystems (EFS rest-json; FSx for Lustre JSON 1.1). Clients only: no call
      // is made until a filesystem is ensured.
      const efs = restClient({
        service: 'elasticfilesystem',
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        ...(options.endpoints?.elasticfilesystem !== undefined
          ? { endpoint: options.endpoints.elasticfilesystem }
          : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      const fsx = jsonClient({
        service: 'fsx',
        region: config.region,
        credentials: account.source,
        fetch: options.fetch,
        clock: context.clock,
        log: context.log,
        jsonVersion: '1.1',
        targetPrefix: 'AWSSimbaAPIService_v20180301',
        ...(options.endpoints?.fsx !== undefined ? { endpoint: options.endpoints.fsx } : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      const compute = new AwsCompute(config, context, options, {
        ec2,
        quotas,
        ssm,
        efs,
        fsx,
        ...(pricing ? { pricing } : {}),
        ...(sqs ? { sqs } : {}),
        account,
        types,
        zones: zoneCache(ec2, { clock: context.clock }),
      });
      // Purchases off (the default): the client cannot buy at all, so vps refuses a purchase
      // before recording it. (purchaseReservation also refuses on its own.)
      if (!config.allowPurchases)
        Object.defineProperty(compute, 'purchaseReservation', { value: undefined });
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
        // Every EKS call runs after the account guards, as every EC2 call does (AwsCompute.ready).
        client: new EksClient(eks, async (signal) => {
          await account.verify({ signal, clock: context.clock });
        }),
        ec2,
        types,
        config,
        credentials: account.source,
        // The role ARNs (with their paths) an access entry may name for the account's session.
        principalRoles:
          config.assumeRoleArn !== undefined
            ? [config.assumeRoleArn]
            : context.account?.platform === true &&
                config.credentials === undefined &&
                options.platformRoleArn !== undefined
              ? [options.platformRoleArn]
              : [],
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
