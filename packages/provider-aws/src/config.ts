import { ComputeError, field, manifest, type SecretRef } from '@better-compute/core';
import {
  assertRegion,
  parseArn,
  partitionOf,
  type CredentialSource,
} from '@better-compute/aws-core';

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
  discoverTag: field
    .string({ maxLength: 512 })
    .optional()
    .describe('"key=value": discovery yields only instances carrying this tag'),
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
  rootVolumeGiB: number;
  rootVolumeType: 'gp3' | 'gp2' | 'io2';
  kmsKeyId?: string;
  metadataHopLimit: number;
  associatePublicIp: boolean;
  discoverTag?: string;
}

export interface AwsProviderOptions {
  fetch?: typeof fetch;
  /** Tests and VPC endpoints; host options, never account config. */
  endpoints?: Partial<Record<'ec2' | 'sts', string>>;
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
  /** How long one network call of a keyless account's `checkAccount` may take (default 10 000). */
  checkTimeoutMs?: number;
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
  if (config.discoverTag !== undefined) parseDiscoverTag(config.discoverTag);
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
