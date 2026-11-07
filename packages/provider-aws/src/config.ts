import { ComputeError, field, manifest, type SecretRef } from '@better-compute/core';
import type { KubeTransport } from './eks/transport.js';
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
  webIdentityRoleArn: field
    .string({ maxLength: 2048 })
    .optional()
    .describe(
      "Keyless sign-in (A7): the IAM role this account's workload identity assumes with AssumeRoleWithWebIdentity (audience sts.amazonaws.com); excludes credentials and assumeRoleArn",
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
    .describe(
      'Instance profile ARN passed to RunInstances (never one whose role has an EKS access entry: see eksNodeInstanceProfile)',
    ),
  eksNodeInstanceProfile: field
    .string({ maxLength: 2048 })
    .optional()
    .describe(
      '(kubernetes) Instance profile ARN of EC2 machines a pool with policy.kubernetes.eks launches as nodes of the cluster (its role has an EC2_LINUX access entry); no other launch gets it',
    ),
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
  eksClusterRoleArn: field
    .string({ maxLength: 2048 })
    .optional()
    .describe('(kubernetes) The EKS cluster IAM role ARN new clusters run as'),
  eksNodeRoleArn: field
    .string({ maxLength: 2048 })
    .optional()
    .describe('(kubernetes) The node IAM role ARN of managed node groups and EKS Auto Mode nodes'),
  eksSubnetIds: field
    .list(field.string({ pattern: '^subnet-[0-9a-f]{8,17}$' }), { max: 16 })
    .optional()
    .describe(
      '(kubernetes) Default subnets of new EKS clusters (at least two, in two Availability Zones); node groups use the cluster subnets',
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
  costs: field
    .option(['off', 'region', 'account'])
    .optional()
    .describe(
      "Read this account's costs from Cost Explorer (charged per request): region (only this region, for several regional accounts on one AWS account), account (every region), or off (default)",
    ),
});

/** The validated account configuration. */
export interface AwsConfig {
  region: string;
  zones: string[];
  credentials?: SecretRef;
  assumeRoleArn?: string;
  webIdentityRoleArn?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  instanceProfile?: string;
  eksNodeInstanceProfile?: string;
  rootVolumeGiB: number;
  rootVolumeType: 'gp3' | 'gp2' | 'io2';
  kmsKeyId?: string;
  metadataHopLimit: number;
  associatePublicIp: boolean;
  discoverTag?: string;
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
  eksClusterRoleArn?: string;
  eksNodeRoleArn?: string;
  eksSubnetIds?: string[];
  eventQueueUrl?: string;
  eventSources?: ('aws.ec2' | 'aws.health' | 'aws.guardduty')[];
  /** Cost Explorer reads (A11): absent or 'off' reads none. */
  costs?: 'off' | 'region' | 'account';
}

export interface AwsProviderOptions {
  fetch?: typeof fetch;
  /** Tests and VPC endpoints; host options, never account config. */
  endpoints?: Partial<Record<'ec2' | 'sts' | 'servicequotas' | 'pricing' | 'ssm' | 'eks' | 'sqs' | 'ce', string>>;
  /**
   * (kubernetes) The transport to an EKS cluster's own Kubernetes API (`kubernetes.credentials`). Default:
   * `node:https` trusting only the cluster's CA.
   */
  kubeTransport?: KubeTransport;
  /**
   * (kubernetes) The IAM role ARN, path included, of the host's ambient identity when it is a role
   * under a path: an assumed-role session ARN drops the path, which an EKS access entry needs.
   * Platform accounts without assumeRoleArn or credentials name it in their access entry.
   */
  platformRoleArn?: string;
  /** Ambient identity for platform accounts (default `ambientCredentials()`). */
  credentials?: CredentialSource;
  /** ExternalId prefix: `${externalIdPrefix}:${providerAccountId}` (default 'better-compute'). */
  externalIdPrefix?: string;
  /**
   * The control plane's own IAM principal (the identity that calls AssumeRole), shown to tenants as
   * `providerAccounts.get` `onboarding.platformPrincipalArn` for their role's trust (A7). Display
   * only: nothing is signed with it.
   */
  platformPrincipalArn?: string;
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
  /**
   * AWS account ids (12 digits) whose private AMIs a raw `ami-…` image may name. Public AMIs and
   * those owned by `amazon` or `aws-marketplace` always pass; any other private AMI the account can
   * see (its own golden images, images shared with it) is refused, because the image comes from the
   * tenant and EC2 launches it as the account.
   */
  imageOwners?: readonly string[];
  /** How long one network call of a keyless account's `checkAccount` may take (default 10 000). */
  checkTimeoutMs?: number;
  /** Cost Explorer reads (A11): how long a day read stays cached (default 24 h). */
  costsCacheMs?: number;
}

function invalid(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, { provider: 'aws', reason });
}

/**
 * The audience of the account's web identity token (A7): the client id the tenant's IAM OIDC provider
 * lists and its role's trust pins (`<issuer>:aud`). Fixed, never account config.
 */
export const webIdentityAudience = 'sts.amazonaws.com';

/** The role ARN, checked: an IAM role in the region's partition. */
export function roleArnOf(config: Pick<AwsConfig, 'region' | 'assumeRoleArn'>) {
  return checkedRoleArn(config.region, config.assumeRoleArn, 'assumeRoleArn');
}

/** The web identity role ARN (A7), checked as `roleArnOf` checks `assumeRoleArn`. */
export function webIdentityRoleArnOf(config: Pick<AwsConfig, 'region' | 'webIdentityRoleArn'>) {
  return checkedRoleArn(config.region, config.webIdentityRoleArn, 'webIdentityRoleArn');
}

function checkedRoleArn(
  region: string,
  text: string | undefined,
  name: 'assumeRoleArn' | 'webIdentityRoleArn',
) {
  if (text === undefined) return undefined;
  let arn;
  try {
    arn = parseArn(text);
  } catch {
    throw invalid(`${name} is not an IAM role ARN`, name);
  }
  if (
    arn.service !== 'iam' ||
    arn.region !== '' ||
    !/^\d{12}$/.test(arn.account) ||
    !/^role\/[\w+=,.@/-]{1,512}$/.test(arn.resource)
  )
    throw invalid(`${name} is not an IAM role ARN`, name);
  if (arn.partition !== partitionOf(region).partition)
    throw invalid(
      `${name} is in partition ${arn.partition}, but region ${region} is in ${partitionOf(region).partition}`,
      name,
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
  webIdentityRoleArnOf(config);
  // The Price List API does not exist in GovCloud: on-demand pricing could never price anything
  // there ('all' still reads Spot prices from EC2).
  if (config.pricing === 'on-demand' && partitionOf(config.region).partition === 'aws-us-gov')
    throw invalid(
      `pricing 'on-demand' needs the AWS Price List API, which ${config.region} (aws-us-gov) does not have: use 'off', or 'all' for Spot prices only`,
      'pricing',
    );
  // Cost Explorer: GovCloud has no endpoint (its costs are read from the linked commercial account), and the
  // China endpoint (cn-northwest-1) is not the one aws-core's global host names. Refused, not left to fail later.
  if (
    config.costs !== undefined &&
    config.costs !== 'off' &&
    partitionOf(config.region).partition !== 'aws'
  )
    throw invalid(
      `costs reads Cost Explorer in partition aws only; region ${config.region} is in ${partitionOf(config.region).partition}`,
      'costs-partition',
    );
  if (config.discoverTag !== undefined) parseDiscoverTag(config.discoverTag);
  if (config.eventQueueUrl !== undefined) parseEventQueueUrl(config.eventQueueUrl, config.region);
  for (const key of ['instanceProfile', 'eksNodeInstanceProfile'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    let arn;
    try {
      arn = parseArn(value);
    } catch {
      throw invalid(`${key} is not an instance profile ARN`, key);
    }
    if (arn.service !== 'iam' || !arn.resource.startsWith('instance-profile/'))
      throw invalid(`${key} is not an instance profile ARN`, key);
  }
  // The account-wide profile goes on every launch: it must never carry the EKS node identity.
  if (
    config.eksNodeInstanceProfile !== undefined &&
    config.instanceProfile === config.eksNodeInstanceProfile
  )
    throw invalid(
      'instanceProfile must not be eksNodeInstanceProfile: every machine of the account gets instanceProfile, only EKS nodes the node identity',
      'eksNodeInstanceProfile',
    );
  for (const key of ['eksClusterRoleArn', 'eksNodeRoleArn'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    let arn;
    try {
      arn = parseArn(value);
    } catch {
      throw invalid(`${key} is not an IAM role ARN`, key);
    }
    if (
      arn.service !== 'iam' ||
      arn.region !== '' ||
      !/^\d{12}$/.test(arn.account) ||
      !/^role\/[\w+=,.@/-]{1,512}$/.test(arn.resource) ||
      arn.partition !== partitionOf(config.region).partition
    )
      throw invalid(`${key} is not an IAM role ARN of this partition`, key);
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
