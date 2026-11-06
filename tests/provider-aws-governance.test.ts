import { describe, expect, it } from 'vitest';
import { isComputeError, type Logger } from '@better-compute/core';
import {
  awsBudgetTemplateCommand,
  awsConfig,
  awsProvider,
  type AwsCompute,
  type AwsConfig,
  awsCostAllocationTagsCommand,
  awsTagPolicyCommand,
  budgetTemplate,
  costAllocationTagKeys,
  tagPolicy,
  type AwsCommandContext,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { CeEmulator } from './support/aws-emulator/ce.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A budget's `TagKeyValue` filters as [key, value] (`user:<key>$<value>`). */
const filterTags = (template: ReturnType<typeof budgetTemplate>) =>
  template.Resources.Budget.Properties.Budget.CostFilters.TagKeyValue.map((entry) => {
    const [key, value] = entry.replace(/^user:/, '').split('$');
    return [key!, value!] as const;
  });

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
      'better-compute:managed',
    ]);
    const listed = harness({});
    await awsCostAllocationTagsCommand(options).run(listed.context);
    expect(listed.json()).toEqual([
      { tagKey: 'better-compute:instance', status: 'Inactive' },
      { tagKey: 'better-compute:tenant', status: 'Active' },
      { tagKey: 'better-compute:pool', status: 'NotSeen' },
      { tagKey: 'better-compute:managed', status: 'NotSeen' },
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
      { tagKey: 'better-compute:managed', status: 'NotSeen' },
    ]);
  });

  it('cost-allocation-tags --activate --yes activates better-compute:managed, the budget filter', async () => {
    const emu = new AwsEmulator();
    const ce = new CeEmulator(emu);
    ce.tags.push({ TagKey: 'better-compute:managed', Type: 'UserDefined', Status: 'Inactive' });
    const options = { fetch: emu.fetch, credentials: emu.ambient, clock: emu.clock };
    const done = harness({ activate: true, yes: true });
    await awsCostAllocationTagsCommand(options).run(done.context);
    const [update] = emu.calls('UpdateCostAllocationTagsStatus');
    expect(JSON.parse(update!.body)).toEqual({
      CostAllocationTagsStatus: [{ TagKey: 'better-compute:managed', Status: 'Active' }],
    });
    expect(ce.tags[0]!.Status).toBe('Active');
  });

  it('every tag a budget filters on is one cost-allocation-tags activates', () => {
    const filters = filterTags(budgetTemplate({ amount: 10, emails: ['a@example.com'] }));
    expect(filters.length).toBeGreaterThan(0);
    for (const [key] of filters) expect(costAllocationTagKeys).toContain(key);
  });

  it('instances provider-aws creates carry the tag the budget filters on, and no tenant or pool tag', async () => {
    const emu = new AwsEmulator();
    const ec2emu = new Ec2Emulator(emu);
    const impl = (await awsProvider({ fetch: emu.fetch, credentials: emu.ambient }).create(
      awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig,
      {
        clock: emu.clock,
        log: quiet,
        secrets: { resolve: async () => '' },
        account: { id: 'pa_platform', tenantId: 'root', platform: true },
      },
    )) as AwsCompute;
    const machine = await impl.create(
      {
        offerId: 'us-east-1a/t3.micro',
        image: 'ubuntu-24.04',
        userData: '#cloud-config\n',
        name: 'vm-ins_budget',
        // a tenant label never sets an ownership key
        labels: { tenant: 'tnt_acme', pool: 'pool_x' },
      },
      {
        idempotencyKey: 'ins_budget',
        signal: new AbortController().signal,
        clock: emu.clock,
        secrets: { resolve: async () => '' },
        log: quiet,
      },
    );
    const instance = ec2emu.instances.get(machine.id)!;
    const filters = filterTags(budgetTemplate({ amount: 10, emails: ['a@example.com'] }));
    for (const tagged of [instance.tags, instance.volumeTags]) {
      for (const [key, value] of filters) expect(tagged.get(key)).toBe(value);
      expect(tagged.get('better-compute:instance')).toBe('ins_budget');
      // why budget-template refuses --tenant and --pool: provider-aws never writes these keys
      expect(tagged.has('better-compute:tenant')).toBe(false);
      expect(tagged.has('better-compute:pool')).toBe(false);
    }
  });

  it('budget-template refuses --tenant and --pool: provider-aws does not write those tags', async () => {
    for (const scope of [{ tenant: 'tnt_acme' }, { pool: 'pool_x' }, { tenant: 'a:b' }]) {
      let caught: unknown;
      try {
        budgetTemplate({ amount: 10, emails: ['a@example.com'], ...scope });
      } catch (error) {
        caught = error;
      }
      expect(isComputeError(caught) && caught.code).toBe('INVALID_INPUT');
      expect((caught as Error).message).toMatch(/not written/);
    }
    const { context } = harness({ amount: '10', tenant: 'tnt_acme', email: 'a@example.com' });
    await expect(awsBudgetTemplateCommand().run(context)).rejects.toThrow(/--tenant/);
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

  it('budget-template renders an AWS::Budgets::Budget over the managed tag', async () => {
    const template = budgetTemplate({
      amount: 250,
      emails: ['finops@example.com'],
      snsTopicArn: 'arn:aws:sns:us-east-1:111111111111:budgets',
    });
    const budget = template.Resources.Budget;
    expect(budget.Type).toBe('AWS::Budgets::Budget');
    expect(budget.Properties.Budget).toEqual({
      BudgetName: 'better-compute-managed',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 250, Unit: 'USD' },
      CostFilters: { TagKeyValue: ['user:better-compute:managed$true'] },
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
    for (const input of [
      { amount: 0, emails: ['a@example.com'] },
      { amount: 10, emails: [] },
      { amount: 10, emails: ['not-an-address'] },
      { amount: 10, emails: [], snsTopicArn: 'arn:aws:iam::111111111111:role/x' },
      { amount: 10, emails: ['a@example.com'], currency: 'usd' },
    ])
      expect(() => budgetTemplate(input)).toThrow();
    const { context, json } = harness({
      amount: '99.5',
      email: 'a@example.com,b@example.com',
    });
    await awsBudgetTemplateCommand().run(context);
    expect(json().Resources.Budget.Properties.Budget.BudgetLimit).toEqual({
      Amount: 99.5,
      Unit: 'USD',
    });
  });
});
