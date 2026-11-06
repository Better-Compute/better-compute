import { ComputeError } from '@better-compute/core';
import { parseArn } from '@better-compute/aws-core';
import type { AwsCommandContext } from './cli.js';
import { awsCliClient, emitJson, type AwsCliOptions } from './finops-cli.js';
import { tags } from './ids.js';

// A11 tag governance and budgets: which better-compute tags Cost Explorer may group by (`aws cost-allocation-tags`),
// an Organizations tag policy that keeps their spelling (`aws tag-policy`), and an AWS Budgets template per tenant
// (`aws budget-template`). Only `aws cost-allocation-tags --activate --yes` changes AWS; the others render.

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const list = (value: unknown) =>
  (text(value) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The tag keys provider-aws writes that cost reports group by: Cost Explorer reads only activated keys. */
export const costAllocationTagKeys: readonly string[] = [tags.instance, tags.tenant, tags.pool];

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
      "aws cost-allocation-tags reads the status of the better-compute:instance, better-compute:tenant and better-compute:pool cost allocation tags (ce:ListCostAllocationTags) as the operator's own AWS identity. Cost Explorer groups costs only by activated tags, so an account with costs set attributes nothing to instances or tenants until they are active; activation is made in the payer (management) account and applies from then on, not to earlier costs. With --activate it lists the inactive keys it would activate, and with --yes as well it activates them (ce:UpdateCostAllocationTagsStatus). A key AWS has not seen yet (NotSeen) appears within a day of the first tagged resource.",
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
  /** A tenant id: the budget covers costs tagged `better-compute:tenant=<id>`. */
  tenant?: string;
  /** A pool id: costs tagged `better-compute:pool=<id>`. */
  pool?: string;
  emails?: readonly string[];
  snsTopicArn?: string;
  /** Percent of the limit actual spend alerts at (default 80). */
  actualPct?: number;
  /** Percent of the limit forecast spend alerts at (default 100). */
  forecastPct?: number;
}

const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const emailPattern = /^[^\s@,]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/**
 * A CloudFormation template with one monthly AWS::Budgets::Budget over the costs of a tenant (`tenant`), a pool
 * (`pool`) or everything better-compute manages (neither), alerting on actual and forecast spend. Cost allocation
 * tags must be active for its filter to match. Pure.
 */
export function budgetTemplate(input: BudgetTemplateInput) {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1e9)
    throw usage('--amount is a positive monthly limit');
  const currency = input.currency ?? 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw usage('--currency is a three-letter code (USD)');
  if (input.tenant !== undefined && input.pool !== undefined)
    throw usage('--tenant and --pool are exclusive');
  const scoped = input.tenant ?? input.pool;
  if (scoped !== undefined && !idPattern.test(scoped))
    throw usage('--tenant and --pool are better-compute ids');
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
  const filter =
    input.tenant !== undefined
      ? { name: `tenant-${input.tenant}`, tag: `user:${tags.tenant}$${input.tenant}` }
      : input.pool !== undefined
        ? { name: `pool-${input.pool}`, tag: `user:${tags.pool}$${input.pool}` }
        : { name: 'managed', tag: `user:${tags.managed}$true` };
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
            BudgetName: `better-compute-${filter.name}`.slice(0, 100),
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

/** `better-compute aws budget-template --amount <n> [--tenant <id> | --pool <id>] --email <a,b> | --sns-topic <arn>`. */
export function awsBudgetTemplateCommand() {
  return {
    name: 'aws budget-template' as const,
    group: 'Providers' as const,
    summary: 'Print a CloudFormation template for an AWS Budgets budget over better-compute costs',
    description:
      'aws budget-template prints a CloudFormation template with one monthly AWS::Budgets::Budget over the costs tagged better-compute:tenant=--tenant, better-compute:pool=--pool, or (neither) everything tagged better-compute:managed=true, alerting --email and --sns-topic subscribers when actual spend passes --actual-pct (80) or forecast spend --forecast-pct (100) of --amount. Deploy it in the payer or member account (cloudformation deploy); the tag must be an active cost allocation tag (aws cost-allocation-tags).',
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
      tenant: { type: 'string' as const, value: 'ID', description: "Budget one tenant's costs" },
      pool: { type: 'string' as const, value: 'ID', description: "Budget one pool's costs" },
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
