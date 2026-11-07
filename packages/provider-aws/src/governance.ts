import { ComputeError } from '@better-compute/core';
import { parseArn, type AwsPartition } from '@better-compute/aws-core';
import type { AwsCommandContext, IamPolicyDocument, IamStatement } from './cli.js';
import { awsCliClient, emitJson, type AwsCliOptions } from './finops-cli.js';
import { tags } from './ids.js';

// A11 tag governance and budgets: which better-compute tags Cost Explorer may group by (`aws cost-allocation-tags`),
// an Organizations tag policy that keeps their spelling (`aws tag-policy`), and an AWS Budgets template over the
// `better-compute:managed` tag (`aws budget-template`). Only `aws cost-allocation-tags --activate --yes` changes AWS;
// the others render. provider-aws writes `managed` and `instance` on what it creates (and `instance` on what it
// claims), never `tenant` or `pool`: those keys are only on resources an operator tags.

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const list = (value: unknown) =>
  (text(value) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * The better-compute tag keys cost reports group or filter by: Cost Explorer and AWS Budgets match only activated
 * keys. `instance` attributes costs, `tenant` and `pool` attribute operator-tagged costs, and `managed` is what
 * `budgetTemplate` filters on.
 */
export const costAllocationTagKeys: readonly string[] = [
  tags.instance,
  tags.tenant,
  tags.pool,
  tags.managed,
];

type TagStatus = 'Active' | 'Inactive' | 'NotSeen';

async function tagStatuses(
  client: ReturnType<typeof awsCliClient>,
  signal: AbortSignal,
): Promise<{ tagKey: string; status: TagStatus }[]> {
  const response = await client.call<{
    CostAllocationTags?: { TagKey?: unknown; Status?: unknown }[];
  }>(
    'ListCostAllocationTags',
    { TagKeys: [...costAllocationTagKeys], Type: 'UserDefined', MaxResults: 100 },
    { signal },
  );
  const seen = new Map<string, TagStatus>();
  for (const tag of response.CostAllocationTags ?? [])
    if (typeof tag.TagKey === 'string' && (tag.Status === 'Active' || tag.Status === 'Inactive'))
      seen.set(tag.TagKey, tag.Status);
  return costAllocationTagKeys.map((tagKey) => ({ tagKey, status: seen.get(tagKey) ?? 'NotSeen' }));
}

/** `better-compute aws cost-allocation-tags [--activate [--yes]]`. */
export function awsCostAllocationTagsCommand(options: AwsCliOptions = {}) {
  return {
    name: 'aws cost-allocation-tags' as const,
    group: 'Providers' as const,
    summary: 'Show, or activate, the better-compute cost allocation tags of an AWS payer account',
    description:
      "aws cost-allocation-tags reads the status of the better-compute:instance, better-compute:tenant, better-compute:pool and better-compute:managed cost allocation tags (ce:ListCostAllocationTags) as the operator's own AWS identity. Cost Explorer groups costs and AWS Budgets filters them only by activated tags, so an account with costs set attributes nothing to instances until better-compute:instance is active, and an aws budget-template budget tracks nothing until better-compute:managed is; activation is made in the payer (management) account and applies from then on, not to earlier costs. With --activate it lists the inactive keys it would activate, and with --yes as well it activates them (ce:UpdateCostAllocationTagsStatus). A key AWS has not seen yet (NotSeen) appears within a day of the first tagged resource.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      region: {
        type: 'string' as const,
        value: 'REGION',
        description: 'Any region of the partition (default us-east-1)',
      },
      activate: {
        type: 'boolean' as const,
        description: 'Activate the inactive keys (with --yes)',
      },
      yes: {
        type: 'boolean' as const,
        description: 'With --activate, make the change (otherwise it is only printed)',
      },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the result to this new file instead of the output',
      },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const client = awsCliClient(
        'ce',
        'AWSInsightsIndexService',
        text(context.flags.region) ?? 'us-east-1',
        options,
      );
      const signal = AbortSignal.timeout(60_000);
      let statuses = await tagStatuses(client, signal);
      context.note(
        'cost allocation tags are activated in the payer (management) account; activation applies to costs from then on',
      );
      if (context.flags.activate === true) {
        const inactive = statuses
          .filter((tag) => tag.status === 'Inactive')
          .map((tag) => tag.tagKey);
        if (inactive.length === 0) context.note('nothing to activate');
        else if (context.flags.yes !== true)
          context.note(
            `would activate ${inactive.join(', ')}: run again with --yes to activate them`,
          );
        else {
          const result = await client.call<{ Errors?: { TagKey?: unknown; Code?: unknown }[] }>(
            'UpdateCostAllocationTagsStatus',
            { CostAllocationTagsStatus: inactive.map((TagKey) => ({ TagKey, Status: 'Active' })) },
            { signal },
          );
          for (const error of result.Errors ?? [])
            context.note(`could not activate ${String(error.TagKey)}: ${String(error.Code)}`);
          statuses = await tagStatuses(client, signal);
        }
      }
      await emitJson(context, statuses);
    },
  };
}

/** An AWS Organizations tag policy document. */
export interface TagPolicyDocument {
  tags: Record<
    string,
    {
      tag_key: { '@@assign': string };
      tag_value?: { '@@assign': string[] };
      enforced_for?: { '@@assign': string[] };
    }
  >;
}

/**
 * The tag policy for the better-compute keys: their exact spelling (so cost reports never split one key by case),
 * `better-compute:managed` only ever `true`, and with `enforce` that value enforced on EC2 instances and volumes.
 * Keys whose values are ids are never value-restricted. Pure.
 */
export function tagPolicy(options: { enforce?: boolean } = {}): TagPolicyDocument {
  const policy: TagPolicyDocument = { tags: {} };
  for (const key of [tags.instance, tags.tenant, tags.pool, tags.managed])
    policy.tags[key] = { tag_key: { '@@assign': key } };
  policy.tags[tags.managed] = {
    tag_key: { '@@assign': tags.managed },
    tag_value: { '@@assign': ['true'] },
    ...(options.enforce ? { enforced_for: { '@@assign': ['ec2:instance', 'ec2:volume'] } } : {}),
  };
  return policy;
}

/** `better-compute aws tag-policy [--enforce]`: renders, never attaches. */
export function awsTagPolicyCommand() {
  return {
    name: 'aws tag-policy' as const,
    group: 'Providers' as const,
    summary: 'Print an AWS Organizations tag policy for the better-compute tags',
    description:
      'aws tag-policy prints an AWS Organizations tag policy that fixes the spelling of better-compute:instance, better-compute:tenant, better-compute:pool and better-compute:managed, and allows better-compute:managed only the value true; --enforce also enforces that value on EC2 instances and volumes. Attach it to the organizational units that hold aws provider accounts (organizations:CreatePolicy and AttachPolicy, outside better-compute).',
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      enforce: {
        type: 'boolean' as const,
        description: 'Enforce better-compute:managed=true on EC2 instances and volumes',
      },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the policy to this new file instead of the output',
      },
    },
    async run(context: AwsCommandContext): Promise<void> {
      await emitJson(context, tagPolicy({ enforce: context.flags.enforce === true }));
    },
  };
}

export interface BudgetTemplateInput {
  /** The monthly limit, in `currency`. */
  amount: number;
  currency?: string;
  /**
   * Refused: provider-aws does not write `better-compute:tenant` on what it creates, so a tenant budget would
   * track only operator-tagged costs and never alert on the tenant's instances (fail closed).
   */
  tenant?: string;
  /** Refused, as `tenant`: `better-compute:pool` is not written either. */
  pool?: string;
  emails?: readonly string[];
  snsTopicArn?: string;
  /** Percent of the limit actual spend alerts at (default 80). */
  actualPct?: number;
  /** Percent of the limit forecast spend alerts at (default 100). */
  forecastPct?: number;
}

const emailPattern = /^[^\s@,]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/**
 * A CloudFormation template with one monthly AWS::Budgets::Budget over everything better-compute manages (the
 * `better-compute:managed=true` tag on the instances and volumes it creates), alerting on actual and forecast
 * spend. The tag must be an active cost allocation tag for the filter to match. `tenant` and `pool` are refused:
 * provider-aws does not write those tags. Pure.
 */
export function budgetTemplate(input: BudgetTemplateInput) {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1e9)
    throw usage('--amount is a positive monthly limit');
  const currency = input.currency ?? 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw usage('--currency is a three-letter code (USD)');
  if (input.tenant !== undefined || input.pool !== undefined)
    throw usage(
      `--tenant and --pool are refused: provider-aws does not write the ${tags.tenant} or ${tags.pool} tags (not written on the instances and volumes it creates), so such a budget would never see their spend; budget everything with the ${tags.managed} tag instead`,
    );
  const emails = [...(input.emails ?? [])];
  for (const email of emails)
    if (!emailPattern.test(email)) throw usage('--email is an e-mail address');
  if (input.snsTopicArn !== undefined) {
    let arn;
    try {
      arn = parseArn(input.snsTopicArn);
    } catch {
      arn = undefined;
    }
    if (!arn || arn.service !== 'sns' || !/^\d{12}$/.test(arn.account))
      throw usage('--sns-topic is an SNS topic ARN');
  }
  if (emails.length === 0 && input.snsTopicArn === undefined)
    throw usage('give at least one --email or an --sns-topic to alert');
  if (emails.length > 10) throw usage('AWS Budgets allows at most 10 e-mail subscribers');
  const pct = (value: number | undefined, fallback: number, flag: string) => {
    const result = value ?? fallback;
    if (!Number.isFinite(result) || result <= 0 || result > 1000)
      throw usage(`${flag} is a percentage`);
    return result;
  };
  const filter = { name: 'managed', tag: `user:${tags.managed}$true` };
  const subscribers = [
    ...emails.map((Address) => ({ SubscriptionType: 'EMAIL', Address })),
    ...(input.snsTopicArn ? [{ SubscriptionType: 'SNS', Address: input.snsTopicArn }] : []),
  ];
  const notification = (type: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
    Notification: {
      NotificationType: type,
      ComparisonOperator: 'GREATER_THAN',
      Threshold: threshold,
      ThresholdType: 'PERCENTAGE',
    },
    Subscribers: subscribers,
  });
  return {
    AWSTemplateFormatVersion: '2010-09-09' as const,
    Description: `better-compute monthly budget (${filter.name}); needs the cost allocation tag active`,
    Resources: {
      Budget: {
        Type: 'AWS::Budgets::Budget' as const,
        Properties: {
          Budget: {
            BudgetName: `better-compute-${filter.name}`,
            BudgetType: 'COST',
            TimeUnit: 'MONTHLY',
            BudgetLimit: { Amount: input.amount, Unit: currency },
            CostFilters: { TagKeyValue: [filter.tag] },
          },
          NotificationsWithSubscribers: [
            notification('ACTUAL', pct(input.actualPct, 80, '--actual-pct')),
            notification('FORECASTED', pct(input.forecastPct, 100, '--forecast-pct')),
          ],
        },
      },
    },
  };
}

/** `better-compute aws budget-template --amount <n> --email <a,b> | --sns-topic <arn>`. */
export function awsBudgetTemplateCommand() {
  return {
    name: 'aws budget-template' as const,
    group: 'Providers' as const,
    summary: 'Print a CloudFormation template for an AWS Budgets budget over better-compute costs',
    description:
      'aws budget-template prints a CloudFormation template with one monthly AWS::Budgets::Budget over everything tagged better-compute:managed=true (the instances and volumes provider-aws creates), alerting --email and --sns-topic subscribers when actual spend passes --actual-pct (80) or forecast spend --forecast-pct (100) of --amount. Deploy it in the payer or member account (cloudformation deploy); better-compute:managed must be an active cost allocation tag (aws cost-allocation-tags --activate --yes) or the budget tracks nothing. --tenant and --pool are refused: provider-aws does not write the better-compute:tenant or better-compute:pool tags, so such a budget would never see their spend.',
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      amount: {
        type: 'string' as const,
        value: 'N',
        required: true,
        description: 'The monthly limit, in --currency',
      },
      currency: { type: 'string' as const, value: 'CODE', description: 'Default USD' },
      tenant: {
        type: 'string' as const,
        value: 'ID',
        description: 'Refused: provider-aws does not write the better-compute:tenant tag',
      },
      pool: {
        type: 'string' as const,
        value: 'ID',
        description: 'Refused: provider-aws does not write the better-compute:pool tag',
      },
      email: {
        type: 'string' as const,
        value: 'ADDRESSES',
        description: 'Comma-separated e-mail subscribers',
      },
      'sns-topic': {
        type: 'string' as const,
        value: 'ARN',
        description: 'An SNS topic subscriber',
      },
      'actual-pct': { type: 'integer' as const, value: 'PCT', description: 'Default 80' },
      'forecast-pct': { type: 'integer' as const, value: 'PCT', description: 'Default 100' },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the template to this new file instead of the output',
      },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const amount = Number(text(context.flags.amount) ?? context.flags.amount);
      await emitJson(
        context,
        budgetTemplate({
          amount,
          ...(text(context.flags.currency) ? { currency: text(context.flags.currency)! } : {}),
          ...(text(context.flags.tenant) ? { tenant: text(context.flags.tenant)! } : {}),
          ...(text(context.flags.pool) ? { pool: text(context.flags.pool)! } : {}),
          emails: list(context.flags.email),
          ...(text(context.flags['sns-topic'])
            ? { snsTopicArn: text(context.flags['sns-topic'])! }
            : {}),
          ...(typeof context.flags['actual-pct'] === 'number'
            ? { actualPct: context.flags['actual-pct'] }
            : {}),
          ...(typeof context.flags['forecast-pct'] === 'number'
            ? { forecastPct: context.flags['forecast-pct'] }
            : {}),
        }),
      );
    },
  };
}

const governancePartitions: readonly AwsPartition[] = ['aws', 'aws-cn', 'aws-us-gov'];

export interface GovernancePolicyOptions {
  partition?: AwsPartition;
  /** `aws cost-allocation-tags --activate --yes`: ce:UpdateCostAllocationTagsStatus. */
  activateTags?: boolean;
  /** `aws quota-request --yes`: servicequotas:RequestServiceQuotaIncrease, EC2 quotas only. */
  quotaRequests?: boolean;
  /** The live suite's spend guard (`awsMonthToDateCost`): ce:GetCostAndUsage. */
  spend?: boolean;
}

/**
 * The IAM policy for the operator's own identity that runs the governance commands (program Appendix B, A11): the
 * reads of `aws cost-allocation-tags`, `aws organization-accounts` and `aws quotas` always, and each action that
 * changes AWS (or costs money) only behind its own option. This is never the provider account's role
 * (`iamPolicy`). Pure.
 */
export function governancePolicy(options: GovernancePolicyOptions = {}): IamPolicyDocument {
  const partition = options.partition ?? 'aws';
  if (!governancePartitions.includes(partition))
    throw usage('--partition is aws, aws-cn or aws-us-gov');
  const statements: IamStatement[] = [
    {
      Sid: 'CostAllocationTagsRead',
      Effect: 'Allow',
      Action: ['ce:ListCostAllocationTags'],
      Resource: '*',
    },
    {
      Sid: 'OrganizationAccounts',
      Effect: 'Allow',
      Action: [
        'organizations:DescribeOrganization',
        'organizations:ListAccounts',
        'organizations:ListAccountsForParent',
      ],
      Resource: '*',
    },
    {
      Sid: 'QuotasRead',
      Effect: 'Allow',
      Action: ['servicequotas:GetServiceQuota', 'servicequotas:ListServiceQuotas'],
      Resource: '*',
    },
  ];
  if (options.activateTags === true)
    statements.push({
      Sid: 'CostAllocationTagsActivate',
      Effect: 'Allow',
      Action: ['ce:UpdateCostAllocationTagsStatus'],
      Resource: '*',
    });
  if (options.quotaRequests === true)
    statements.push({
      Sid: 'QuotaRequests',
      Effect: 'Allow',
      Action: ['servicequotas:RequestServiceQuotaIncrease'],
      Resource: `arn:${partition}:servicequotas:*:*:ec2/*`,
    });
  if (options.spend === true)
    statements.push({
      Sid: 'SpendGuard',
      Effect: 'Allow',
      Action: ['ce:GetCostAndUsage'],
      Resource: '*',
    });
  return { Version: '2012-10-17', Statement: statements };
}

/** `better-compute aws governance-policy [--activate-tags] [--quota-requests] [--spend]`: renders, never attaches. */
export function awsGovernancePolicyCommand() {
  return {
    name: 'aws governance-policy' as const,
    group: 'Providers' as const,
    summary: 'Print the IAM policy for the operator identity that runs the AWS governance commands',
    description:
      "aws governance-policy prints the IAM policy for the operator's own AWS identity that runs aws cost-allocation-tags, aws organization-accounts and aws quotas: ce:ListCostAllocationTags, organizations:DescribeOrganization, ListAccounts and ListAccountsForParent, and servicequotas:GetServiceQuota and ListServiceQuotas. Each action that changes AWS is opt-in: --activate-tags adds ce:UpdateCostAllocationTagsStatus (aws cost-allocation-tags --activate --yes), --quota-requests servicequotas:RequestServiceQuotaIncrease on EC2 quotas only (aws quota-request --yes), and --spend ce:GetCostAndUsage for the live suite's spend guard. It is not the provider account's role policy (aws iam-policy).",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      partition: {
        type: 'string' as const,
        value: 'PARTITION',
        choices: governancePartitions,
        description: 'aws (default), aws-cn or aws-us-gov',
      },
      'activate-tags': {
        type: 'boolean' as const,
        description: 'Add ce:UpdateCostAllocationTagsStatus (aws cost-allocation-tags --activate)',
      },
      'quota-requests': {
        type: 'boolean' as const,
        description:
          'Add servicequotas:RequestServiceQuotaIncrease on EC2 quotas (aws quota-request)',
      },
      spend: {
        type: 'boolean' as const,
        description: "Add ce:GetCostAndUsage, for the live suite's spend guard",
      },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the policy to this new file instead of the output',
      },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const partition = text(context.flags.partition) as AwsPartition | undefined;
      await emitJson(
        context,
        governancePolicy({
          ...(partition ? { partition } : {}),
          ...(context.flags['activate-tags'] === true ? { activateTags: true } : {}),
          ...(context.flags['quota-requests'] === true ? { quotaRequests: true } : {}),
          ...(context.flags.spend === true ? { spend: true } : {}),
        }),
      );
    },
  };
}
