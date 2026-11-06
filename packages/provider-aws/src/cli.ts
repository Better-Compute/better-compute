import { writeFile } from 'node:fs/promises';
import { ComputeError } from '@better-compute/core';
import { assertRegion, parseArn, type AwsPartition } from '@better-compute/aws-core';
import { parseDiscoverTag } from './config.js';
import { tags } from './ids.js';
import { networksIamStatements } from './networks.js';

// The CLI commands that onboard an AWS account (`aws iam-policy`, `aws trust-policy`). The CLI never
// imports providers, so an application that uses this one adds the commands to its configuration:
//
//   import { awsIamPolicyCommand, awsTrustPolicyCommand } from '@better-compute/provider-aws';
//   export const commands = [awsIamPolicyCommand(), awsTrustPolicyCommand()];

export interface IamStatement {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action: string | readonly string[];
  /** Absent in a trust policy, where IAM refuses it. */
  Resource?: string | readonly string[];
  Condition?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
  Principal?: unknown;
}

export interface IamPolicyDocument {
  Version: '2012-10-17';
  Statement: readonly IamStatement[];
}

const partitions: readonly AwsPartition[] = ['aws', 'aws-cn', 'aws-us-gov'];
const usage = (message: string) => new ComputeError('INVALID_INPUT', message);

/**
 * The ABAC permissions policy provider-aws needs (AD6, program Appendix B, phase A1): reads are
 * unconditioned, RunInstances must tag what it creates `better-compute:managed=true`, terminate
 * needs that tag, power and reinstall need the `better-compute:instance` tag, and tag edits
 * outside launch touch only the two ownership keys (and must name them: a DeleteTags without tag
 * keys would delete every tag). AWS then refuses terminate, power and reinstall on an instance
 * without the ownership tags. Attach writes those tags, so the role can put them on any instance
 * it can tag: `discoverTag` narrows that to instances carrying the discovery tag.
 */
export function iamPolicy(
  options: {
    partition?: AwsPartition;
    region?: string;
    account?: string;
    instanceProfileArn?: string;
    /** `key=value`: attach may tag only instances carrying this tag (the account's discoverTag). */
    discoverTag?: string;
    /** The customer-managed KMS key ARN of the accounts' `kmsKeyId`: adds EBS's grants on it. */
    kmsKeyArn?: string;
    /** (A2) Adds what tenant networks need: VPCs, subnets, gateways, security groups, ACL entries. */
    networks?: boolean;
    /** (A5) The EBS volume and snapshot statements (default true). */
    volumes?: boolean;
  } = {},
): IamPolicyDocument {
  const partition = options.partition ?? 'aws';
  if (!partitions.includes(partition))
    throw usage(`--partition is one of ${partitions.join(', ')}`);
  const region = options.region === undefined ? '*' : assertRegion(options.region);
  if (options.account !== undefined && !/^\d{12}$/.test(options.account))
    throw usage('--account is a 12-digit AWS account id');
  const account = options.account ?? '*';
  let discover: [string, string] | undefined;
  if (options.discoverTag !== undefined)
    try {
      discover = parseDiscoverTag(options.discoverTag);
    } catch {
      throw usage('--discover-tag is key=value, as the account config discoverTag');
    }
  const ec2 = (resource: string, owned = true) =>
    `arn:${partition}:ec2:${region}:${owned ? account : ''}:${resource}`;
  const instances = ec2('instance/*');
  const managed = { StringEquals: { [`ec2:ResourceTag/${tags.managed}`]: 'true' } };
  const statements: IamStatement[] = [
    {
      Sid: 'Describe',
      Effect: 'Allow',
      Action: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeInstanceTypeOfferings',
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeImages',
        ...(options.volumes === false
          ? []
          : ['ec2:DescribeVolumes', 'ec2:DescribeSnapshots', 'ec2:DescribeVolumesModifications']),
      ],
      Resource: '*',
    },
    {
      Sid: 'RunTagged',
      Effect: 'Allow',
      Action: 'ec2:RunInstances',
      Resource: [instances, ec2('volume/*')],
      Condition: { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } },
    },
    {
      Sid: 'RunResources',
      Effect: 'Allow',
      Action: 'ec2:RunInstances',
      Resource: [
        ec2('image/*', false),
        ec2('subnet/*'),
        ec2('security-group/*'),
        ec2('network-interface/*'),
        ec2('key-pair/*'),
      ],
    },
    {
      Sid: 'TagOnCreate',
      Effect: 'Allow',
      Action: 'ec2:CreateTags',
      Resource: [instances, ec2('volume/*'), ec2('network-interface/*')],
      Condition: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
    },
    {
      Sid: 'ManageOwned',
      Effect: 'Allow',
      Action: 'ec2:TerminateInstances',
      Resource: instances,
      Condition: managed,
    },
    {
      Sid: 'PowerClaimed',
      Effect: 'Allow',
      Action: [
        'ec2:StartInstances',
        'ec2:StopInstances',
        'ec2:RebootInstances',
        'ec2:SendDiagnosticInterrupt',
        'ec2:CreateReplaceRootVolumeTask',
      ],
      Resource: instances,
      Condition: { Null: { [`ec2:ResourceTag/${tags.instance}`]: 'false' } },
    },
    {
      // The other resources a root-volume replacement names. Each resource of a request must be
      // allowed, so the instance itself stays guarded by PowerClaimed.
      Sid: 'ReinstallResources',
      Effect: 'Allow',
      Action: 'ec2:CreateReplaceRootVolumeTask',
      Resource: [
        ec2('replace-root-volume-task/*'),
        ec2('volume/*'),
        ec2('snapshot/*', false),
        ec2('image/*', false),
      ],
    },
    {
      Sid: 'Attach',
      Effect: 'Allow',
      Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: instances,
      Condition: {
        'ForAllValues:StringEquals': { 'aws:TagKeys': [tags.instance, tags.managed] },
        // ForAllValues holds vacuously for a request without tag keys (DeleteTags of every tag).
        Null: { 'aws:TagKeys': 'false' },
        ...(discover ? { StringEquals: { [`ec2:ResourceTag/${discover[0]}`]: discover[1] } } : {}),
      },
    },
    ...(options.volumes === false ? [] : ebsStatements(ec2, instances, options.account)),
    {
      Sid: 'PublicImages',
      Effect: 'Allow',
      Action: 'ssm:GetParameters',
      Resource: `arn:${partition}:ssm:${region}::parameter/aws/service/*`,
    },
    { Sid: 'Identity', Effect: 'Allow', Action: 'sts:GetCallerIdentity', Resource: '*' },
  ];
  if (options.kmsKeyArn !== undefined) {
    let key;
    try {
      key = parseArn(options.kmsKeyArn);
    } catch {
      key = undefined;
    }
    if (!key || key.service !== 'kms' || !/^key\/[\w-]{1,128}$/.test(key.resource))
      throw usage('--kms-key is a KMS key ARN (arn:…:kms:<region>:<account>:key/<id>)');
    if (key.partition !== partition)
      throw usage(`--kms-key is in partition ${key.partition}, not ${partition}`);
    // EBS uses the key on the caller's behalf: only through EC2, and grants only for AWS resources.
    const suffix = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
    const via: Record<string, Record<string, string>> = region === '*'
      ? { StringLike: { 'kms:ViaService': `ec2.*.${suffix}` } }
      : { StringEquals: { 'kms:ViaService': `ec2.${region}.${suffix}` } };
    statements.push(
      {
        Sid: 'EbsKey',
        Effect: 'Allow',
        Action: [
          'kms:DescribeKey',
          'kms:GenerateDataKeyWithoutPlaintext',
          'kms:Decrypt',
          'kms:ReEncryptFrom',
          'kms:ReEncryptTo',
        ],
        Resource: options.kmsKeyArn,
        Condition: via,
      },
      {
        Sid: 'EbsKeyGrant',
        Effect: 'Allow',
        Action: ['kms:CreateGrant'],
        Resource: options.kmsKeyArn,
        Condition: { ...via, Bool: { 'kms:GrantIsForAWSResource': 'true' } },
      },
    );
  }
  if (options.networks === true)
    statements.push(...networksIamStatements((resource) => ec2(resource)));
  if (options.instanceProfileArn !== undefined) {
    const profile = parseArn(options.instanceProfileArn);
    if (profile.service !== 'iam' || !profile.resource.startsWith('instance-profile/'))
      throw usage(
        '--instance-profile is an instance profile ARN (arn:…:iam::<account>:instance-profile/<name>)',
      );
    if (profile.partition !== partition)
      throw usage(`--instance-profile is in partition ${profile.partition}, not ${partition}`);
    // The role of the same path and name as the profile (the console's convention); edit it if yours differs.
    statements.push({
      Sid: 'PassProfile',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: `arn:${partition}:iam::${profile.account}:role/${profile.resource.slice('instance-profile/'.length)}`,
      Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    });
  }
  return { Version: '2012-10-17', Statement: statements };
}

/**
 * (A5) EBS volumes and snapshots, ABAC like the instances: CreateVolume and CreateSnapshot must tag
 * what they create `better-compute:managed=true` (and may tag only on those creates), a restore
 * reads only managed snapshots carrying `better-compute:snapshot` (with an account: only its own),
 * every change to a volume needs it managed and carrying `better-compute:volume` (never a root
 * volume, which RunInstances tags managed too), attach and detach need an instance carrying
 * `better-compute:instance`, and DeleteSnapshot needs a snapshot a restore could use.
 */
function ebsStatements(
  ec2: (resource: string, owned?: boolean) => string,
  instances: string,
  account: string | undefined,
): IamStatement[] {
  const volumes = ec2('volume/*');
  const snapshots = ec2('snapshot/*', false);
  const requestManaged = { StringEquals: { [`aws:RequestTag/${tags.managed}`]: 'true' } };
  // managed=true alone is also every root volume RunInstances tags: a data volume this deployment
  // made carries its name too (better-compute:volume), and a snapshot its own (…:snapshot).
  const managedVolume = {
    StringEquals: { [`ec2:ResourceTag/${tags.managed}`]: 'true' },
    Null: { [`ec2:ResourceTag/${tags.volume}`]: 'false' },
  };
  // A snapshot ARN names no account: with --account, only this account's (never a public or
  // shared snapshot that happens to carry the tags).
  const managedSnapshot = {
    StringEquals: {
      [`ec2:ResourceTag/${tags.managed}`]: 'true',
      ...(account !== undefined ? { 'ec2:Owner': account } : {}),
    },
    Null: { [`ec2:ResourceTag/${tags.snapshot}`]: 'false' },
  };
  return [
    {
      Sid: 'EbsCreateTagged',
      Effect: 'Allow',
      Action: 'ec2:CreateVolume',
      Resource: volumes,
      Condition: requestManaged,
    },
    {
      Sid: 'EbsRestoreOwned',
      Effect: 'Allow',
      Action: 'ec2:CreateVolume',
      Resource: snapshots,
      Condition: managedSnapshot,
    },
    {
      Sid: 'EbsSnapshotTagged',
      Effect: 'Allow',
      Action: 'ec2:CreateSnapshot',
      Resource: snapshots,
      Condition: requestManaged,
    },
    {
      Sid: 'EbsTagOnCreate',
      Effect: 'Allow',
      Action: 'ec2:CreateTags',
      Resource: [volumes, snapshots],
      Condition: { StringEquals: { 'ec2:CreateAction': ['CreateVolume', 'CreateSnapshot'] } },
    },
    {
      Sid: 'EbsManageOwned',
      Effect: 'Allow',
      Action: [
        'ec2:AttachVolume',
        'ec2:DetachVolume',
        'ec2:ModifyVolume',
        'ec2:DeleteVolume',
        'ec2:CreateSnapshot',
      ],
      Resource: volumes,
      Condition: managedVolume,
    },
    {
      Sid: 'EbsAttachClaimed',
      Effect: 'Allow',
      Action: ['ec2:AttachVolume', 'ec2:DetachVolume'],
      Resource: instances,
      Condition: { Null: { [`ec2:ResourceTag/${tags.instance}`]: 'false' } },
    },
    {
      Sid: 'EbsDeleteOwnedSnapshot',
      Effect: 'Allow',
      Action: 'ec2:DeleteSnapshot',
      Resource: snapshots,
      Condition: managedSnapshot,
    },
  ];
}

/**
 * The trust policy a tenant attaches to the role better-compute assumes: only the platform's
 * principal, and only with the platform-assigned ExternalId (AD4).
 */
export function trustPolicy(options: {
  platformPrincipalArn: string;
  externalId: string;
}): IamPolicyDocument {
  let principal;
  try {
    principal = parseArn(options.platformPrincipalArn);
  } catch {
    throw usage('--platform-principal is an IAM role or user ARN of the platform account');
  }
  if (
    (principal.service !== 'iam' && principal.service !== 'sts') ||
    !/^\d{12}$/.test(principal.account) ||
    !/^(role|user|assumed-role)\//.test(principal.resource)
  )
    throw usage('--platform-principal is an IAM role or user ARN of the platform account');
  if (!/^[\w+=,.@:/-]{2,1224}$/.test(options.externalId))
    throw usage('--external-id is 2 to 1224 characters of [A-Za-z0-9+=,.@:/_-]');
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BetterComputeAssume',
        Effect: 'Allow',
        Principal: { AWS: options.platformPrincipalArn },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': options.externalId } },
      },
    ],
  };
}

/** The part of the CLI's command context these commands use (better-compute/cli `CommandContext`). */
export interface AwsCommandContext {
  flags: Record<string, string | number | boolean | undefined>;
  io: { out(message: string): void };
  note(message: string): void;
  path(value: string): string;
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

async function emit(context: AwsCommandContext, document: IamPolicyDocument): Promise<void> {
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const out = text(context.flags.out);
  if (!out) {
    context.io.out(json.trimEnd());
    return;
  }
  const file = context.path(out);
  try {
    await writeFile(file, json, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw usage(`--out ${out} exists; give a new file`);
    throw error;
  }
  context.note(`wrote ${file}`);
}

const outFlag = {
  type: 'string' as const,
  value: 'PATH',
  description: 'Write the policy to this new file instead of the output',
};

/** `better-compute aws iam-policy`: the ABAC permissions policy, as JSON (or --out <file>). */
export function awsIamPolicyCommand() {
  return {
    name: 'aws iam-policy' as const,
    group: 'Providers' as const,
    summary: 'Print the IAM permissions policy an AWS provider account needs',
    description:
      'aws iam-policy prints the attribute-based (ABAC) IAM policy for the role or user an aws provider account signs in as: EC2 reads; RunInstances only when it tags what it creates better-compute:managed=true; TerminateInstances only on instances tagged that way; start, stop, reboot, diagnostic interrupts and root-volume replacement only on instances carrying better-compute:instance; tag edits limited to the two ownership keys; EBS volumes and snapshots created only tagged better-compute:managed=true and changed, attached, snapshotted or deleted only when they carry it and their better-compute:volume or better-compute:snapshot name, so never a root volume (attach and detach only on instances carrying better-compute:instance); public SSM image parameters; and sts:GetCallerIdentity. --region and --account narrow the resource ARNs; --instance-profile adds iam:PassRole for the role of that profile; --discover-tag key=value lets attach tag only instances carrying that tag; --kms-key adds the EBS grants for a customer-managed kmsKeyId; --phases A1,A2 adds tenant networks (VPC, subnet, gateway, security group and endpoint creates tagged better-compute:managed=true, changes and deletes only on resources so tagged, route and network ACL entry edits, and security group swaps on claimed instances).',
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      partition: {
        type: 'string' as const,
        value: 'PARTITION',
        choices: partitions,
        description: 'aws (default), aws-cn or aws-us-gov',
      },
      region: {
        type: 'string' as const,
        value: 'REGION',
        description: 'Limit resource ARNs to this region',
      },
      account: {
        type: 'string' as const,
        value: 'ID',
        description: 'Limit resource ARNs to this AWS account',
      },
      'instance-profile': {
        type: 'string' as const,
        value: 'ARN',
        description: 'The instance profile accounts pass to RunInstances (adds iam:PassRole)',
      },
      'kms-key': {
        type: 'string' as const,
        value: 'ARN',
        description: 'The customer-managed KMS key accounts set as kmsKeyId (adds the EBS grants)',
      },
      'discover-tag': {
        type: 'string' as const,
        value: 'KEY=VALUE',
        description: 'Attach may tag only instances carrying this tag (the account discoverTag)',
      },
      phases: {
        type: 'string' as const,
        value: 'LIST',
        description:
          'Program phases to cover, comma-separated (A1 always; A2 adds tenant networks: VPCs, subnets, gateways, security groups, network ACL entries)',
      },
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const partition = text(context.flags.partition) as AwsPartition | undefined;
      const phases = new Set(
        (text(context.flags.phases) ?? 'A1')
          .split(',')
          .map((phase) => phase.trim().toUpperCase())
          .filter(Boolean),
      );
      for (const phase of phases)
        if (phase !== 'A1' && phase !== 'A2')
          throw usage(`--phases knows A1 and A2, not ${phase.slice(0, 16)}`);
      await emit(
        context,
        iamPolicy({
          ...(partition ? { partition } : {}),
          ...(text(context.flags.region) ? { region: text(context.flags.region)! } : {}),
          ...(text(context.flags.account) ? { account: text(context.flags.account)! } : {}),
          ...(text(context.flags['instance-profile'])
            ? { instanceProfileArn: text(context.flags['instance-profile'])! }
            : {}),
          ...(text(context.flags['kms-key']) ? { kmsKeyArn: text(context.flags['kms-key'])! } : {}),
          ...(text(context.flags['discover-tag'])
            ? { discoverTag: text(context.flags['discover-tag'])! }
            : {}),
          ...(phases.has('A2') ? { networks: true } : {}),
        }),
      );
    },
  };
}

/** `better-compute aws trust-policy --platform-principal <arn> --external-id <id>`. */
export function awsTrustPolicyCommand() {
  return {
    name: 'aws trust-policy' as const,
    group: 'Providers' as const,
    summary: 'Print the trust policy for the role a tenant AWS account lets better-compute assume',
    description:
      "aws trust-policy prints the trust policy a tenant attaches to the IAM role named in its provider account's assumeRoleArn: only --platform-principal (the control plane's own role) may assume it, and only with --external-id, the platform-assigned ExternalId <prefix>:<providerAccountId> (better-compute:<id> by default). A tenant never chooses the ExternalId, so a role trusted this way serves only its own provider account.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      'platform-principal': {
        type: 'string' as const,
        value: 'ARN',
        required: true,
        description: "The control plane's IAM role ARN (the identity that calls AssumeRole)",
      },
      'external-id': {
        type: 'string' as const,
        value: 'ID',
        required: true,
        description: 'The ExternalId better-compute sends for this provider account',
      },
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const platformPrincipalArn = text(context.flags['platform-principal']);
      const externalId = text(context.flags['external-id']);
      if (!platformPrincipalArn) throw usage('--platform-principal is required');
      if (!externalId) throw usage('--external-id is required');
      await emit(context, trustPolicy({ platformPrincipalArn, externalId }));
    },
  };
}
