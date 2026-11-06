import { ComputeError, field, manifest, type SecretRef } from '@better-compute/core';
import {
  assertRegion,
  parseArn,
  partitionOf,
  type CredentialSource,
} from '@better-compute/aws-core';
import { parseEventQueueUrl } from './events.js';

/**
 * One AWS account in one region (AD3). Credentials are a SecretRef, never a value. There is no
 * `externalId` field on purpose: the ExternalId is platform-assigned (AD4).
 */
export const awsConfig = manifest({
  region: field
    .string({ maxLength: 32 })
    .describe('The AWS region (us-east-1): one provider account is one AWS account in one region'),
  zones: field
    .list(field.string({ maxLength: 64 }), { min: 1 })
    .describe(
      'Availability Zone names as this account sees them (us-east-1a), or Local Zones (us-west-2-lax-1a): offers and create are limited to these',
    ),
  credentials: field
    .secret()
    .optional()
    .describe(
      'Access key JSON { accessKeyId, secretAccessKey }, as a secret reference; absent means the host identity (platform accounts only) or the role hop',
    ),
  assumeRoleArn: field
    .string({ maxLength: 2048 })
    .optional()
    .describe(
      'IAM role to assume (arn:aws:iam::<account>:role/<name>); better-compute sends a platform-assigned ExternalId',
    ),
  subnetId: field
    .string({ pattern: '^subnet-[0-9a-f]{8,17}$' })
    .optional()
    .describe('Default subnet for create (else the zone default subnet)'),
  securityGroupIds: field
    .list(field.string({ pattern: '^sg-[0-9a-f]{8,17}$' }))
    .optional()
    .describe('Default security groups for create'),
  instanceProfile: field
    .string({ maxLength: 2048 })
    .optional()
    .describe('Instance profile ARN passed to RunInstances'),
  rootVolumeGiB: field
    .int({ min: 8, max: 16384 })
    .default(100)
    .describe('Root EBS volume size in GiB'),
  rootVolumeType: field
    .option(['gp3', 'gp2', 'io2'])
    .default('gp3')
    .describe('Root EBS volume type'),
  kmsKeyId: field
    .string({ maxLength: 2048 })
    .optional()
    .describe('KMS key for EBS encryption (else the account default EBS key)'),
  metadataHopLimit: field
    .int({ min: 1, max: 64 })
    .default(1)
    .describe('IMDSv2 PUT response hop limit (2 when containers on the instance need IMDS)'),
  associatePublicIp: field
    .boolean()
    .default(true)
    .describe('Give instances a public IPv4 address (needs a subnet)'),
  efa: field
    .option(['off', 'auto'])
    .default('off')
    .describe(
      'EFA (Elastic Fabric Adapter): auto launches an EFA-capable type with one EFA interface per network card (needs subnetId or a network)',
    ),
  discoverTag: field
    .string({ maxLength: 512 })
    .optional()
    .describe('"key=value": discovery yields only instances carrying this tag'),
  ipamPoolId: field
    .string({ pattern: '^ipam-pool-[0-9a-f]{8,17}$' })
    .optional()
    .describe(
      'Networks: allocate each VPC range from this Amazon VPC IPAM pool (the network cidr gives the size)',
    ),
  securityGroupsPerInterface: field
    .int({ min: 1, max: 16 })
    .optional()
    .describe(
      "Networks: the account's security groups per network interface quota (default 5): network tags past it are refused",
    ),
  spot: field
    .boolean()
    .default(false)
    .describe(
      'Offer Spot capacity (<zone>/<type>:spot): one-time requests that EC2 may reclaim, terminated on interruption',
    ),
  quotas: field
    .boolean()
    .default(true)
    .describe(
      'Read the EC2 vCPU quotas (Service Quotas) so offers carry their headroom as a machine count',
    ),
  pricing: field
    .option(['off', 'on-demand', 'all'])
    .default('off')
    .describe(
      'Offer prices: on-demand from the AWS Price List (cached a day), all adds Spot prices (cached 10 minutes)',
    ),
  allowPurchases: field
    .boolean()
    .default(false)
    .describe(
      'Allow buying capacity (Capacity Blocks, new ODCRs) in this platform account; spends money, root-only and confirmed',
    ),
  eventQueueUrl: field
    .string({ maxLength: 256 })
    .optional()
    .describe(
      "SQS queue the account's EventBridge rules feed (https://sqs.<region>.amazonaws.com/<account>/<name>, in this account and region; render it with `aws event-rules`); absent: scheduled events are read with DescribeInstanceStatus every 5 minutes",
    ),
  eventSources: field
    .list(field.option(['aws.ec2', 'aws.health', 'aws.guardduty']), { min: 1 })
    .optional()
    .describe(
      'EventBridge sources taken from the queue (default aws.ec2 and aws.health); anything else is dropped',
    ),
});

/** The validated account configuration. */
export interface AwsConfig {
  region: string;
  zones: string[];
  credentials?: SecretRef;
  assumeRoleArn?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  instanceProfile?: string;
  rootVolumeGiB: number;
  rootVolumeType: 'gp3' | 'gp2' | 'io2';
  kmsKeyId?: string;
  metadataHopLimit: number;
  associatePublicIp: boolean;
  discoverTag?: string;
  /** (A10) EFA interfaces on EFA-capable types. */
  efa: 'off' | 'auto';
  ipamPoolId?: string;
  securityGroupsPerInterface?: number;
  /** (A3) Offer and launch Spot capacity. */
  spot: boolean;
  /** (A3) Cap offers at the EC2 vCPU quota headroom. */
  quotas: boolean;
  /** (A3) Which offer prices to read. */
  pricing: 'off' | 'on-demand' | 'all';
  /** (A3) Allow purchaseReservation (spends money). */
  allowPurchases: boolean;
  eventQueueUrl?: string;
  eventSources?: ('aws.ec2' | 'aws.health' | 'aws.guardduty')[];
}

export interface AwsProviderOptions {
  fetch?: typeof fetch;
  /** Tests and VPC endpoints; host options, never account config. */
  endpoints?: Partial<
    Record<'ec2' | 'sts' | 'servicequotas' | 'pricing' | 'sqs' | 'elasticfilesystem' | 'fsx', string>
  >;
  /** Ambient identity for platform accounts (default `ambientCredentials()`). */
  credentials?: CredentialSource;
  /** ExternalId prefix: `${externalIdPrefix}:${providerAccountId}` (default 'better-compute'). */
  externalIdPrefix?: string;
  /**
   * AWS account ids a tenant account's `assumeRoleArn` may never name (the ambient identity's own
   * account is always refused too, at first use).
   */
  platformAccounts?: readonly string[];
  rateLimit?: { perSecond: number; burst: number };
  /** How long `get` treats a just-created, not-yet-visible instance as pending (default 120 000). */
  consistencyWindowMs?: number;
  /**
   * SSM parameter prefixes (`/my/team/`) a raw `resolve:ssm:` image may name besides the public
   * `/aws/service/`. The image comes from the tenant and EC2 reads the parameter as the account, so
   * private parameters are refused unless listed here.
   */
  ssmImagePrefixes?: readonly string[];
}

function invalid(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, { provider: 'aws', reason });
}

/** The role ARN, checked: an IAM role in the region's partition. */
export function roleArnOf(config: Pick<AwsConfig, 'region' | 'assumeRoleArn'>) {
  if (config.assumeRoleArn === undefined) return undefined;
  let arn;
  try {
    arn = parseArn(config.assumeRoleArn);
  } catch {
    throw invalid('assumeRoleArn is not an IAM role ARN', 'assumeRoleArn');
  }
  if (
    arn.service !== 'iam' ||
    arn.region !== '' ||
    !/^\d{12}$/.test(arn.account) ||
    !/^role\/[\w+=,.@/-]{1,512}$/.test(arn.resource)
  )
    throw invalid('assumeRoleArn is not an IAM role ARN', 'assumeRoleArn');
  if (arn.partition !== partitionOf(config.region).partition)
    throw invalid(
      `assumeRoleArn is in partition ${arn.partition}, but region ${config.region} is in ${partitionOf(config.region).partition}`,
      'assumeRoleArn',
    );
  return arn;
}

/** Semantic checks `awsProvider().create` runs: `INVALID_CONFIG` on a bad region, zone or role ARN. */
export function validateAwsConfig(config: AwsConfig): void {
  try {
    assertRegion(config.region);
  } catch {
    throw invalid(
      `region ${JSON.stringify(config.region.slice(0, 32))} is not an AWS region`,
      'region',
    );
  }
  if (config.zones.length === 0) throw invalid('an AWS account lists at least one zone', 'zones');
  const escaped = config.region.replace(/-/g, '\\-');
  const zonePattern = new RegExp(`^${escaped}(?:[a-z]|-[a-z]{2,10}-\\d{1,2}[a-z])$`);
  for (const zone of config.zones)
    if (!zonePattern.test(zone))
      throw invalid(
        `zone ${JSON.stringify(zone.slice(0, 64))} is not a zone of ${config.region}`,
        'zones',
      );
  roleArnOf(config);
  if (config.discoverTag !== undefined) parseDiscoverTag(config.discoverTag);
  if (config.eventQueueUrl !== undefined) parseEventQueueUrl(config.eventQueueUrl, config.region);
  if (config.instanceProfile !== undefined) {
    let arn;
    try {
      arn = parseArn(config.instanceProfile);
    } catch {
      throw invalid('instanceProfile is not an instance profile ARN', 'instanceProfile');
    }
    if (arn.service !== 'iam' || !arn.resource.startsWith('instance-profile/'))
      throw invalid('instanceProfile is not an instance profile ARN', 'instanceProfile');
  }
}

/** `key=value` → `[key, value]`; INVALID_CONFIG otherwise. */
export function parseDiscoverTag(text: string): [string, string] {
  const eq = text.indexOf('=');
  const key = eq === -1 ? '' : text.slice(0, eq);
  const value = eq === -1 ? '' : text.slice(eq + 1);
  if (
    !/^[\p{L}\p{N} _.:/=+\-@]{1,128}$/u.test(key) ||
    !/^[\p{L}\p{N} _.:/=+\-@]{0,256}$/u.test(value)
  )
    throw invalid('discoverTag must be "key=value"', 'discoverTag');
  return [key, value];
}
