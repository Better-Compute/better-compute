import { ComputeError } from '@better-compute/core';

export type AwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov';

export interface PartitionInfo {
  partition: AwsPartition;
  /** `amazonaws.com` or `amazonaws.com.cn`. */
  dnsSuffix: string;
}

export type AwsService =
  | 'ec2'
  | 'sts'
  | 'iam'
  | 'ssm'
  | 'sqs'
  | 'servicequotas'
  | 'pricing'
  | 'ce'
  | 'organizations'
  | 'kms'
  | 'secretsmanager'
  | 's3'
  | 'events'
  | 'sns'
  | 'kinesis'
  | 'firehose'
  | 'acm-pca'
  | 'rds'
  | 'eks'
  | 'logs'
  | 'monitoring';

const regionPattern =
  /^(us|eu|ap|sa|ca|me|af|il|mx|cn)(-gov)?-(north|south|east|west|central|northeast|northwest|southeast|southwest)-\d{1,2}$/;

/**
 * Returns the region or throws `INVALID_CONFIG`. This is the only path from config text to an
 * endpoint host: nothing else can put a dot, slash or `@` into a host name.
 */
export function assertRegion(region: string): string {
  if (typeof region !== 'string' || !regionPattern.test(region))
    throw new ComputeError('INVALID_CONFIG', 'not an AWS region name', undefined, {
      provider: 'aws',
      reason: 'region',
    });
  return region;
}

export function partitionOf(region: string): PartitionInfo {
  assertRegion(region);
  if (region.startsWith('cn-')) return { partition: 'aws-cn', dnsSuffix: 'amazonaws.com.cn' };
  if (region.startsWith('us-gov-')) return { partition: 'aws-us-gov', dnsSuffix: 'amazonaws.com' };
  return { partition: 'aws', dnsSuffix: 'amazonaws.com' };
}

/** The partition's global region: where global services (IAM) sign. */
const globalRegion: Readonly<Record<AwsPartition, string>> = {
  aws: 'us-east-1',
  'aws-cn': 'cn-north-1',
  'aws-us-gov': 'us-gov-west-1',
};

/** Services with one endpoint per partition, served from the partition's global region. */
const globalServices: ReadonlySet<AwsService> = new Set(['iam', 'pricing', 'ce', 'organizations']);

function globalHost(service: AwsService, partition: PartitionInfo): string {
  const region = globalRegion[partition.partition];
  switch (service) {
    case 'iam':
      if (partition.partition === 'aws') return 'iam.amazonaws.com';
      if (partition.partition === 'aws-us-gov') return 'iam.us-gov.amazonaws.com';
      return `iam.${region}.${partition.dnsSuffix}`;
    case 'pricing':
      return `api.pricing.${region}.${partition.dnsSuffix}`;
    default:
      return `${service}.${region}.${partition.dnsSuffix}`;
  }
}

function parseOverride(override: string): URL {
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'an AWS endpoint override must be a URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password)
    throw new ComputeError(
      'INVALID_CONFIG',
      'an AWS endpoint override must be an http(s) URL without credentials',
    );
  return url;
}

/**
 * The endpoint of a service in a region. `override` (a host option for tests and VPC endpoints,
 * never account config) is used verbatim when it is an http(s) URL.
 */
export function endpointFor(
  service: AwsService,
  region: string,
  options: { fips?: boolean; dualStack?: boolean; override?: string } = {},
): URL {
  const partition = partitionOf(region);
  if (options.override !== undefined) return parseOverride(options.override);
  if (globalServices.has(service)) return new URL(`https://${globalHost(service, partition)}/`);
  const name = options.fips ? `${service}-fips` : service;
  if (options.dualStack) {
    if (service === 'ec2') return new URL(`https://${name}.${region}.api.aws/`);
    return new URL(`https://${name}.dualstack.${region}.${partition.dnsSuffix}/`);
  }
  return new URL(`https://${name}.${region}.${partition.dnsSuffix}/`);
}

/** The signing region: the region itself, or the partition's global region for global services. */
export function signingRegionFor(service: AwsService, region: string): string {
  const partition = partitionOf(region);
  return globalServices.has(service) ? globalRegion[partition.partition] : region;
}

export interface Arn {
  partition: AwsPartition;
  service: string;
  region: string;
  account: string;
  resource: string;
}

const partitions: ReadonlySet<string> = new Set(['aws', 'aws-cn', 'aws-us-gov']);

/** Parses `arn:<partition>:<service>:<region>:<account>:<resource>`; `INVALID_INPUT` on anything else. */
export function parseArn(arn: string): Arn {
  const invalid = () => new ComputeError('INVALID_INPUT', 'not a well-formed AWS ARN');
  if (typeof arn !== 'string' || arn.length > 2048) throw invalid();
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') throw invalid();
  const [, partition, service, region, account] = parts as [string, string, string, string, string];
  const resource = parts.slice(5).join(':');
  if (!partitions.has(partition)) throw invalid();
  if (!/^[a-z0-9-]{1,64}$/.test(service)) throw invalid();
  if (region !== '' && !regionPattern.test(region)) throw invalid();
  if (account !== '' && account !== 'aws' && !/^\d{12}$/.test(account)) throw invalid();
  if (resource === '' || /[\s]/.test(resource)) throw invalid();
  return { partition: partition as AwsPartition, service, region, account, resource };
}

export function formatArn(arn: Arn): string {
  return `arn:${arn.partition}:${arn.service}:${arn.region}:${arn.account}:${arn.resource}`;
}
