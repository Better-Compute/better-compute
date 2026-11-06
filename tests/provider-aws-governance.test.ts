import { describe, expect, it } from 'vitest';
import {
  awsBudgetTemplateCommand,
  awsCostAllocationTagsCommand,
  awsTagPolicyCommand,
  budgetTemplate,
  costAllocationTagKeys,
  tagPolicy,
  type AwsCommandContext,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { CeEmulator } from './support/aws-emulator/ce.js';

function harness(flags: AwsCommandContext['flags']) {
  const out: string[] = [];
  const notes: string[] = [];
  const context: AwsCommandContext = {
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => value,
  };
  return { out, notes, context, json: () => JSON.parse(out.join('\n')) };
}

describe('provider-aws governance', () => {
  it('cost-allocation-tags reports the better-compute keys and activates them only with --yes', async () => {
    const emu = new AwsEmulator();
    const ce = new CeEmulator(emu);
    ce.tags.push(
      { TagKey: 'better-compute:instance', Type: 'UserDefined', Status: 'Inactive' },
      { TagKey: 'better-compute:tenant', Type: 'UserDefined', Status: 'Active' },
      { TagKey: 'team', Type: 'UserDefined', Status: 'Inactive' },
    );
    const options = { fetch: emu.fetch, credentials: emu.ambient, clock: emu.clock };
    expect(costAllocationTagKeys).toEqual([
      'better-compute:instance',
      'better-compute:tenant',
      'better-compute:pool',
    ]);
    const listed = harness({});
    await awsCostAllocationTagsCommand(options).run(listed.context);
    expect(listed.json()).toEqual([
      { tagKey: 'better-compute:instance', status: 'Inactive' },
      { tagKey: 'better-compute:tenant', status: 'Active' },
      { tagKey: 'better-compute:pool', status: 'NotSeen' },
    ]);
    expect(listed.notes.join('\n')).toMatch(/payer|management/i);

    const dry = harness({ activate: true });
    await awsCostAllocationTagsCommand(options).run(dry.context);
    expect(emu.calls('UpdateCostAllocationTagsStatus')).toEqual([]);
    expect(dry.notes.join('\n')).toMatch(/--yes/);

    const done = harness({ activate: true, yes: true });
    await awsCostAllocationTagsCommand(options).run(done.context);
    const [update] = emu.calls('UpdateCostAllocationTagsStatus');
    // only the inactive better-compute key that AWS has seen; never another tag
    expect(JSON.parse(update!.body)).toEqual({
      CostAllocationTagsStatus: [{ TagKey: 'better-compute:instance', Status: 'Active' }],
    });
    expect(ce.tags.find((tag) => tag.TagKey === 'team')!.Status).toBe('Inactive');
    expect(done.json()).toEqual([
      { tagKey: 'better-compute:instance', status: 'Active' },
      { tagKey: 'better-compute:tenant', status: 'Active' },
      { tagKey: 'better-compute:pool', status: 'NotSeen' },
    ]);
  });

  it('tag-policy fixes the key spelling and, with --enforce, the managed value', async () => {
    const policy = tagPolicy();
    expect(policy.tags['better-compute:instance']).toEqual({
      tag_key: { '@@assign': 'better-compute:instance' },
    });
    expect(policy.tags['better-compute:managed']).toEqual({
      tag_key: { '@@assign': 'better-compute:managed' },
      tag_value: { '@@assign': ['true'] },
    });
    const enforced = tagPolicy({ enforce: true });
    expect(enforced.tags['better-compute:managed']!.enforced_for).toEqual({
      '@@assign': ['ec2:instance', 'ec2:volume'],
    });
    // keys whose values are ids are never value-restricted
    expect(enforced.tags['better-compute:tenant']!.tag_value).toBeUndefined();
    const { context, json } = harness({ enforce: true });
    await awsTagPolicyCommand().run(context);
    expect(json()).toEqual(enforced);
  });

  it('budget-template renders an AWS::Budgets::Budget for a tenant tag', async () => {
    const template = budgetTemplate({
      amount: 250,
      tenant: 'tnt_acme',
      emails: ['finops@example.com'],
      snsTopicArn: 'arn:aws:sns:us-east-1:111111111111:budgets',
    });
    const budget = template.Resources.Budget;
    expect(budget.Type).toBe('AWS::Budgets::Budget');
    expect(budget.Properties.Budget).toEqual({
      BudgetName: 'better-compute-tenant-tnt_acme',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 250, Unit: 'USD' },
      CostFilters: { TagKeyValue: ['user:better-compute:tenant$tnt_acme'] },
    });
    expect(budget.Properties.NotificationsWithSubscribers).toEqual([
      {
        Notification: {
          NotificationType: 'ACTUAL',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: 80,
          ThresholdType: 'PERCENTAGE',
        },
        Subscribers: [
          { SubscriptionType: 'EMAIL', Address: 'finops@example.com' },
          { SubscriptionType: 'SNS', Address: 'arn:aws:sns:us-east-1:111111111111:budgets' },
        ],
      },
      expect.objectContaining({
        Notification: expect.objectContaining({ NotificationType: 'FORECASTED', Threshold: 100 }),
      }),
    ]);
    // the whole account's better-compute spend, by the managed tag
    expect(
      budgetTemplate({ amount: 10, emails: ['a@example.com'] }).Resources.Budget.Properties.Budget,
    ).toMatchObject({
      BudgetName: 'better-compute-managed',
      CostFilters: { TagKeyValue: ['user:better-compute:managed$true'] },
    });
    for (const input of [
      { amount: 0, emails: ['a@example.com'] },
      { amount: 10, emails: [] },
      { amount: 10, emails: ['not-an-address'] },
      { amount: 10, emails: ['a@example.com'], tenant: 'bad tenant$' },
      { amount: 10, emails: [], snsTopicArn: 'arn:aws:iam::111111111111:role/x' },
      { amount: 10, emails: ['a@example.com'], currency: 'usd' },
    ])
      expect(() => budgetTemplate(input)).toThrow();
    const { context, json } = harness({
      amount: '99.5',
      tenant: 'tnt_acme',
      email: 'a@example.com,b@example.com',
    });
    await awsBudgetTemplateCommand().run(context);
    expect(json().Resources.Budget.Properties.Budget.BudgetLimit).toEqual({
      Amount: 99.5,
      Unit: 'USD',
    });
  });
});
