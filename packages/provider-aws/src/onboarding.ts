import { writeFile } from 'node:fs/promises';
import { ComputeError } from '@better-compute/core';
import { parseArn, type AwsPartition } from '@better-compute/aws-core';
import { accountSubject, awsRoleSessionTagKey } from '@better-compute/vps';
import {
  iamPolicy,
  trustPolicy,
  type AwsCommandContext,
  type IamPolicyDocument,
  type IamStatement,
} from './cli.js';
import { webIdentityAudience, type AwsConfig, type AwsProviderOptions } from './config.js';

// AWS A7: what a tenant deploys in its own AWS account, as CloudFormation JSON (AQ7).
//
// - `aws onboarding-template` renders the role a provider account signs in as, with the ABAC
//   policy of `aws iam-policy`. Either the control plane assumes it (trust = the platform principal
//   and the platform-assigned ExternalId, AD4), or, with --issuer, the account's own workload
//   identity does (trust = the IAM OIDC provider for the control plane's issuer, `aud`
//   sts.amazonaws.com and `sub` exactly the account's subject: keyless, as GCP's federation).
// - `aws workload-role` renders the role instances assume through their host's IMDS (A7 workload
//   identity): `aud` sts.amazonaws.com and `sub` like `t:<tenantId>:instance:*`.
//
// Like the other AWS commands they ship from this package, and an application adds them to its
// CLI configuration: `export const commands = [awsOnboardingTemplateCommand(), awsWorkloadRoleCommand()]`.

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);

/** A CloudFormation template (only what these commands render). */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: '2010-09-09';
  Description: string;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  Outputs: Record<string, { Description: string; Value: unknown }>;
}

/** Ids workload tokens carry (pki `idPart`): no `*`, `?` or `:`, so a `sub` pattern cannot widen. */
const idPattern = /^[A-Za-z0-9._-]{1,128}$/;
const accountNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const roleNamePattern = /^[\w+=,.@-]{1,64}$/;

/**
 * The issuer as IAM names it: an https URL without query, fragment, credentials or trailing slash.
 * Returns the condition-key prefix, `<host>[/<path>]` (what `<prefix>:sub` and `:aud` use).
 */
function issuerKey(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw usage('--issuer is the https URL of the control plane workload issuer');
  }
  if (
    url.protocol !== 'https:' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    issuer.length > 255 ||
    issuer.endsWith('/') ||
    `${url.origin}${url.pathname}` !== issuer
  )
    throw usage(
      '--issuer is the https URL of the control plane workload issuer (no query, fragment or trailing slash)',
    );
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

/** An existing IAM OIDC provider for the issuer, or a new one in the template. */
function oidcProvider(
  issuer: string,
  key: string,
  arn: string | undefined,
  resources: CloudFormationTemplate['Resources'],
): unknown {
  if (arn === undefined) {
    resources.OidcProvider = {
      Type: 'AWS::IAM::OIDCProvider',
      Properties: { Url: issuer, ClientIdList: [webIdentityAudience] },
    };
    return { Ref: 'OidcProvider' };
  }
  let parsed;
  try {
    parsed = parseArn(arn);
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    parsed.service !== 'iam' ||
    !/^\d{12}$/.test(parsed.account) ||
    parsed.resource !== `oidc-provider/${key}`
  )
    throw usage(`--oidc-provider-arn is the IAM OIDC provider of the issuer (…:oidc-provider/${key})`);
  return arn;
}

function roleName(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!roleNamePattern.test(name)) throw usage('--role-name is 1 to 64 characters of [\\w+=,.@-]');
  return name;
}

export interface OnboardingTemplateOptions {
  /** Assume-role mode: the provider account id the ExternalId names. */
  providerAccountId?: string;
  /** Assume-role mode: the control plane's IAM principal. */
  platformPrincipalArn?: string;
  /** The host's `externalIdPrefix` (default 'better-compute'). */
  externalIdPrefix?: string;
  /** Keyless mode: the control plane's workload issuer URL. */
  issuer?: string;
  /** Keyless mode: the tenant and the account name `providerAccounts.create` will get. */
  tenantId?: string;
  name?: string;
  /** Keyless mode: an IAM OIDC provider the account already has for the issuer. */
  oidcProviderArn?: string;
  /** The role's name (default 'better-compute'). */
  roleName?: string;
  /** Passed to `iamPolicy`. */
  partition?: AwsPartition;
  region?: string;
  instanceProfileArn?: string;
  kmsKeyArn?: string;
  discoverTag?: string;
}

/** The CloudFormation template of a tenant's provider-account role (see the file comment). */
export function onboardingTemplate(options: OnboardingTemplateOptions): CloudFormationTemplate {
  const policy = iamPolicy({
    ...(options.partition ? { partition: options.partition } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.instanceProfileArn !== undefined
      ? { instanceProfileArn: options.instanceProfileArn }
      : {}),
    ...(options.kmsKeyArn !== undefined ? { kmsKeyArn: options.kmsKeyArn } : {}),
    ...(options.discoverTag !== undefined ? { discoverTag: options.discoverTag } : {}),
  });
  const resources: CloudFormationTemplate['Resources'] = {};
  const outputs: CloudFormationTemplate['Outputs'] = {};
  let trust: IamPolicyDocument;
  let description: string;
  if (options.issuer !== undefined) {
    if (options.providerAccountId !== undefined || options.platformPrincipalArn !== undefined)
      throw usage('a keyless template takes --issuer, --tenant and --name, not --account or --platform-principal');
    if (options.tenantId === undefined || !idPattern.test(options.tenantId))
      throw usage('--tenant is the tenant id the provider account belongs to');
    if (options.name === undefined || !accountNamePattern.test(options.name))
      throw usage('--name is the provider account name (1-63 lower-case letters, digits, . _ -)');
    const key = issuerKey(options.issuer);
    const federated = oidcProvider(options.issuer, key, options.oidcProviderArn, resources);
    const subject = accountSubject(options.tenantId, 'aws', options.name);
    trust = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'BetterComputeAccount',
          Effect: 'Allow',
          Principal: { Federated: federated },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { [`${key}:aud`]: webIdentityAudience, [`${key}:sub`]: subject },
          },
        },
      ],
    };
    outputs.Subject = {
      Description: 'The only workload identity subject the role trusts (this provider account)',
      Value: subject,
    };
    description =
      `better-compute provider account ${options.name} of tenant ${options.tenantId}: a keyless role ` +
      "its workload identity assumes (set webIdentityRoleArn to the RoleArn output)";
  } else {
    if (options.providerAccountId === undefined || !idPattern.test(options.providerAccountId))
      throw usage('--account is the provider account id (pa_…) the ExternalId names');
    if (options.platformPrincipalArn === undefined)
      throw usage('--platform-principal is required (or --issuer for a keyless role)');
    const externalId = `${options.externalIdPrefix ?? 'better-compute'}:${options.providerAccountId}`;
    trust = trustPolicy({ platformPrincipalArn: options.platformPrincipalArn, externalId });
    outputs.ExternalId = {
      Description: 'The ExternalId better-compute sends (platform-assigned, never chosen by the tenant)',
      Value: externalId,
    };
    description =
      `better-compute provider account ${options.providerAccountId}: a role the control plane ` +
      'assumes with the platform-assigned ExternalId (set assumeRoleArn to the RoleArn output)';
  }
  resources.Role = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: roleName(options.roleName, 'better-compute'),
      Description: 'better-compute provider account role (ABAC: better-compute:* tags)',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: trust,
      Policies: [{ PolicyName: 'better-compute', PolicyDocument: policy }],
    },
  };
  outputs.RoleArn = {
    Description: 'The role ARN for the provider account config',
    Value: { 'Fn::GetAtt': ['Role', 'Arn'] },
  };
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: description,
    Resources: resources,
    Outputs: outputs,
  };
}

export interface WorkloadRoleOptions {
  tenantId: string;
  issuer: string;
  /** The role's name (default 'bc-workload'). */
  roleName?: string;
  /** Managed policies to attach (what the workloads may do). */
  policyArns?: readonly string[];
  oidcProviderArn?: string;
}

/** A workload role's name: IAM's role-name characters without `,`, which a tag value cannot carry. */
const workloadRoleNamePattern = /^[\w+=.@-]{1,64}$/;

/**
 * A workload role's own `bc-role` session tag value as CloudFormation spells it: its ARN without a
 * path (capacity's `awsRoleSessionTag`, which the workload broker tags STS tokens with).
 */
export function workloadRoleTag(roleName: string): { 'Fn::Sub': string } {
  if (!workloadRoleNamePattern.test(roleName))
    throw usage('--role-name of a workload role is 1 to 64 characters of [\\w+=.@-] (no comma)');
  return { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/' + roleName };
}

/**
 * The trust statement of a role a tenant's instances assume (A7): the issuer's OIDC provider, `aud`
 * sts.amazonaws.com, `sub` like `t:<tenantId>:instance:*`, and the session tag `bc-role` equal to
 * this role (`sts:TagSession` allowed). The workload broker mints that audience only for an
 * instance whose pool allows its role (`workloadRoles.aws`) and tags the token with that role, so a
 * token minted for one workload role never assumes another, even when a guest obtains it.
 */
export function workloadTrustStatement(options: {
  tenantId: string;
  issuer: string;
  federated: unknown;
  /** The role's name (no path): the `bc-role` tag value the trust requires. */
  roleName: string;
}): IamStatement {
  if (!idPattern.test(options.tenantId)) throw usage('--tenant is a tenant id ([A-Za-z0-9._-])');
  const key = issuerKey(options.issuer);
  return {
    Sid: 'BetterComputeWorkloads',
    Effect: 'Allow',
    Principal: { Federated: options.federated },
    Action: ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'],
    Condition: {
      StringEquals: {
        [`${key}:aud`]: webIdentityAudience,
        [`aws:RequestTag/${awsRoleSessionTagKey}`]: workloadRoleTag(options.roleName),
      },
      StringLike: { [`${key}:sub`]: `t:${options.tenantId}:instance:*` },
    },
  };
}

/** The CloudFormation template of a workload role (`aws workload-role`). */
export function workloadRoleTemplate(options: WorkloadRoleOptions): CloudFormationTemplate {
  if (typeof options.tenantId !== 'string' || !idPattern.test(options.tenantId))
    throw usage('--tenant is a tenant id ([A-Za-z0-9._-])');
  const key = issuerKey(options.issuer);
  for (const arn of options.policyArns ?? []) {
    let parsed;
    try {
      parsed = parseArn(arn);
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.service !== 'iam' || !parsed.resource.startsWith('policy/'))
      throw usage('--policy-arn is an IAM managed policy ARN (arn:…:iam::<account|aws>:policy/<name>)');
  }
  const name = roleName(options.roleName, 'bc-workload');
  const tag = workloadRoleTag(name);
  const resources: CloudFormationTemplate['Resources'] = {};
  const federated = oidcProvider(options.issuer, key, options.oidcProviderArn, resources);
  const subject = `t:${options.tenantId}:instance:*`;
  resources.Role = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: name,
      Description: `better-compute workloads of tenant ${options.tenantId}`,
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          workloadTrustStatement({
            tenantId: options.tenantId,
            issuer: options.issuer,
            federated,
            roleName: name,
          }),
        ],
      },
      ...(options.policyArns?.length ? { ManagedPolicyArns: [...options.policyArns] } : {}),
    },
  };
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      `better-compute workload role of tenant ${options.tenantId}: list the RoleArn output in the ` +
      "pool's workloadRoles.aws and set it as an instance's workloadIdentity.awsRoleArn",
    Resources: resources,
    Outputs: {
      RoleArn: { Description: 'The workload role ARN', Value: { 'Fn::GetAtt': ['Role', 'Arn'] } },
      Subject: { Description: 'The subjects the role trusts', Value: subject },
      Audience: { Description: 'The audience workload tokens carry', Value: webIdentityAudience },
      RoleTag: {
        Description: `The ${awsRoleSessionTagKey} session tag a workload token must carry (this role)`,
        Value: tag,
      },
    },
  };
}

/**
 * `ProviderInput.describeAccount` for AWS (`providerAccounts.get` `onboarding`): how the account
 * signs in, and what its role must trust. A role the control plane assumes shows the
 * platform-assigned ExternalId (and the platform principal when the host names it); a keyless one
 * the subject and audience. Never a secret: a key account shows only that it uses a key.
 */
export function describeAwsAccount(
  config: AwsConfig,
  account: { id: string; tenantId: string; name: string; platform: boolean },
  options: Pick<AwsProviderOptions, 'externalIdPrefix' | 'platformPrincipalArn'> = {},
): Record<string, string> {
  if (config.webIdentityRoleArn !== undefined)
    return {
      mode: 'web-identity',
      roleArn: config.webIdentityRoleArn,
      subject: accountSubject(account.tenantId, 'aws', account.name),
      audience: webIdentityAudience,
    };
  if (config.assumeRoleArn !== undefined)
    return {
      mode: 'assume-role',
      roleArn: config.assumeRoleArn,
      externalId: `${options.externalIdPrefix ?? 'better-compute'}:${account.id}`,
      ...(options.platformPrincipalArn !== undefined
        ? { platformPrincipalArn: options.platformPrincipalArn }
        : {}),
    };
  return { mode: config.credentials !== undefined ? 'access-key' : 'ambient' };
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

async function emitTemplate(
  context: AwsCommandContext,
  template: CloudFormationTemplate,
): Promise<void> {
  const json = `${JSON.stringify(template, null, 2)}\n`;
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

const flag = (value: string, description: string, required = false) => ({
  type: 'string' as const,
  value,
  description,
  ...(required ? { required: true as const } : {}),
});

const outFlag = flag('PATH', 'Write the template to this new file instead of the output');
const issuerFlag = (required: boolean) =>
  flag('URL', "The control plane's workload issuer URL (the OIDC provider IAM trusts)", required);
const oidcFlag = flag(
  'ARN',
  'An IAM OIDC provider the AWS account already has for the issuer (else the template creates one)',
);

/** `better-compute aws onboarding-template`: the tenant's provider-account role, as CloudFormation. */
export function awsOnboardingTemplateCommand() {
  return {
    name: 'aws onboarding-template' as const,
    group: 'Providers' as const,
    summary: 'Print the CloudFormation a tenant deploys to onboard an AWS account',
    description:
      "aws onboarding-template prints a CloudFormation template for the IAM role an aws provider account signs in as, with the ABAC policy aws iam-policy prints. With --account and --platform-principal, the control plane assumes the role: only that principal may, and only with the platform-assigned ExternalId <prefix>:<providerAccountId>. With --issuer, --tenant and --name the role is keyless: the account's own workload identity assumes it through an IAM OIDC provider for the issuer, trusted for exactly that account's subject (compute-account:<tenant>/aws/<name>) and the audience sts.amazonaws.com; set webIdentityRoleArn to the RoleArn output. --region, --instance-profile, --kms-key and --discover-tag shape the policy as for aws iam-policy.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      account: flag('ID', 'The provider account id (pa_…) the ExternalId names'),
      'platform-principal': flag('ARN', "The control plane's IAM role ARN (the identity that calls AssumeRole)"),
      'external-id-prefix': flag('PREFIX', "The host's externalIdPrefix (default better-compute)"),
      issuer: issuerFlag(false),
      tenant: flag('ID', 'Keyless: the tenant the provider account belongs to'),
      name: flag('NAME', 'Keyless: the provider account name providerAccounts.create gets'),
      'oidc-provider-arn': oidcFlag,
      'role-name': flag('NAME', 'The role name (default better-compute)'),
      partition: {
        ...flag('PARTITION', 'aws (default), aws-cn or aws-us-gov'),
        choices: ['aws', 'aws-cn', 'aws-us-gov'] as const,
      },
      region: flag('REGION', 'Limit the policy resource ARNs to this region'),
      'instance-profile': flag('ARN', 'The instance profile accounts pass to RunInstances (adds iam:PassRole)'),
      'kms-key': flag('ARN', 'The customer-managed KMS key accounts set as kmsKeyId (adds the EBS grants)'),
      'discover-tag': flag('KEY=VALUE', 'Attach may tag only instances carrying this tag'),
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const f = context.flags;
      const pick = <K extends string>(key: string, as: K) =>
        (text(f[key]) !== undefined ? { [as]: text(f[key])! } : {}) as Partial<Record<K, string>>;
      await emitTemplate(
        context,
        onboardingTemplate({
          ...pick('account', 'providerAccountId'),
          ...pick('platform-principal', 'platformPrincipalArn'),
          ...pick('external-id-prefix', 'externalIdPrefix'),
          ...pick('issuer', 'issuer'),
          ...pick('tenant', 'tenantId'),
          ...pick('name', 'name'),
          ...pick('oidc-provider-arn', 'oidcProviderArn'),
          ...pick('role-name', 'roleName'),
          ...(pick('partition', 'partition') as { partition?: AwsPartition }),
          ...pick('region', 'region'),
          ...pick('instance-profile', 'instanceProfileArn'),
          ...pick('kms-key', 'kmsKeyArn'),
          ...pick('discover-tag', 'discoverTag'),
        }),
      );
    },
  };
}

/** `better-compute aws workload-role --tenant <id> --issuer <url>`: a workload role, as CloudFormation. */
export function awsWorkloadRoleCommand() {
  return {
    name: 'aws workload-role' as const,
    group: 'Providers' as const,
    summary: "Print the CloudFormation for an IAM role a tenant's instances assume",
    description:
      "aws workload-role prints a CloudFormation template for an IAM role better-compute instances assume with no static keys: an IAM OIDC provider for --issuer (or --oidc-provider-arn) and a role trusting it for the audience sts.amazonaws.com and the subjects t:<tenant>:instance:*. bcd exchanges the instance's workload token for the role's credentials and serves them on the guest's metadata endpoint. List the RoleArn output in the pool policy workloadRoles.aws and set it as the instance's workloadIdentity.awsRoleArn; --policy-arn attaches what the workloads may do.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      tenant: flag('ID', 'The tenant whose instances may assume the role', true),
      issuer: issuerFlag(true),
      'role-name': flag('NAME', 'The role name (default bc-workload)'),
      'policy-arn': flag('ARN', 'A managed policy to attach (comma-separated for several)'),
      'oidc-provider-arn': oidcFlag,
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const tenantId = text(context.flags.tenant);
      const issuer = text(context.flags.issuer);
      if (!tenantId) throw usage('--tenant is required');
      if (!issuer) throw usage('--issuer is required');
      const policies = text(context.flags['policy-arn']);
      const roleNameFlag = text(context.flags['role-name']);
      const providerArn = text(context.flags['oidc-provider-arn']);
      await emitTemplate(
        context,
        workloadRoleTemplate({
          tenantId,
          issuer,
          ...(roleNameFlag ? { roleName: roleNameFlag } : {}),
          ...(policies ? { policyArns: policies.split(',').map((arn) => arn.trim()) } : {}),
          ...(providerArn ? { oidcProviderArn: providerArn } : {}),
        }),
      );
    },
  };
}
