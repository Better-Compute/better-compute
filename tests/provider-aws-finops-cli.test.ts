import { describe, expect, it } from 'vitest';
import { validateFleetConfig } from '@better-compute/fleet';
import {
  awsIamPolicyCommand,
  awsOrganizationAccountsCommand,
  awsQuotaRequestCommand,
  awsQuotasCommand,
  iamPolicy,
  type AwsCommandContext,
  type IamStatement,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { OrganizationsEmulator, ServiceQuotasEmulator } from './support/aws-emulator/governance.js';

const actionsOf = (statement: IamStatement) =>
  typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action];

function harness(flags: AwsCommandContext['flags']) {
  const out: string[] = [];
  const notes: string[] = [];
  const context: AwsCommandContext = {
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => value,
  };
  return { out, notes, context };
}

describe('provider-aws FinOps CLI', () => {
  it('iam policy adds Cost Explorer and Price List reads only when asked', async () => {
    const plain = iamPolicy();
    const all = plain.Statement.flatMap(actionsOf);
    expect(all).not.toContain('ce:GetCostAndUsage');
    expect(all).not.toContain('pricing:GetProducts');
    const finops = iamPolicy({ costs: true, prices: true });
    const costs = finops.Statement.find((statement) => statement.Sid === 'CostExplorer')!;
    expect(actionsOf(costs)).toEqual(['ce:GetCostAndUsage']);
    expect(costs.Resource).toBe('*');
    const prices = finops.Statement.find((statement) => statement.Sid === 'PriceList')!;
    expect(actionsOf(prices)).toEqual(['pricing:GetProducts']);
    // nothing else gains a wildcard resource
    expect(finops.Statement.length).toBe(plain.Statement.length + 2);
    // the Price List serves the commercial partition only
    expect(() => iamPolicy({ partition: 'aws-us-gov', prices: true })).toThrow(/--prices/);
    // Cost Explorer is read from the commercial partition only (GovCloud has none; China is not wired)
    expect(() => iamPolicy({ partition: 'aws-us-gov', costs: true })).toThrow(/--costs/);
    expect(() => iamPolicy({ partition: 'aws-cn', costs: true })).toThrow(/--costs/);
    const { out, context } = harness({ costs: true });
    await awsIamPolicyCommand().run(context);
    expect(JSON.parse(out[0]!).Statement.map((s: IamStatement) => s.Sid)).toContain('CostExplorer');
    expect(awsIamPolicyCommand().flags.costs.type).toBe('boolean');
  });

  it('organization-accounts renders FleetConfig providerAccounts for ACTIVE member accounts', async () => {
    const emu = new AwsEmulator();
    const orgs = new OrganizationsEmulator(emu);
    orgs.pageSize = 2;
    orgs.accounts.push(
      {
        Id: '222222222222',
        Name: 'ml-prod',
        Email: 'ml@example.com',
        Status: 'ACTIVE',
        parent: 'ou-ab12-gpu00001',
      },
      {
        Id: '333333333333',
        Name: 'old',
        Email: 'old@example.com',
        Status: 'SUSPENDED',
        parent: 'ou-ab12-gpu00001',
      },
      { Id: '444444444444', Name: 'web', Email: 'web@example.com', Status: 'ACTIVE' },
      { Id: '555555555555', Name: 'payer', Email: 'payer@example.com', Status: 'ACTIVE' },
    );
    const command = awsOrganizationAccountsCommand({
      fetch: emu.fetch,
      credentials: emu.ambient,
      clock: emu.clock,
    });
    const { out, notes, context } = harness({
      role: 'better-compute',
      region: 'us-east-1',
      zones: 'us-east-1a,us-east-1b',
      exclude: '555555555555',
    });
    await command.run(context);
    const document = JSON.parse(out.join('\n'));
    expect(document).toEqual({
      version: 1,
      providerAccounts: [
        {
          name: 'aws-222222222222-us-east-1',
          provider: 'aws',
          config: {
            region: 'us-east-1',
            zones: ['us-east-1a', 'us-east-1b'],
            assumeRoleArn: 'arn:aws:iam::222222222222:role/better-compute',
          },
        },
        expect.objectContaining({ name: 'aws-444444444444-us-east-1' }),
      ],
    });
    // a FleetConfig fleet.apply takes; no e-mail address is printed
    expect(validateFleetConfig(document).providerAccounts).toHaveLength(2);
    expect(out.join('\n')).not.toContain('@example.com');
    expect(notes.join('\n')).toMatch(/zone names/i);
    // it only reads
    expect(
      emu.requests.every((request) =>
        /^(?:ListAccounts|DescribeOrganization$)/.test(request.operation),
      ),
    ).toBe(true);

    const byOu = harness({
      role: 'bc',
      region: 'us-gov-west-1',
      zones: 'us-gov-west-1a',
      parent: 'ou-ab12-gpu00001',
      prefix: 'gov',
    });
    await command.run(byOu.context);
    expect(JSON.parse(byOu.out.join('\n')).providerAccounts).toEqual([
      expect.objectContaining({
        name: 'gov-222222222222-us-gov-west-1',
        config: expect.objectContaining({
          assumeRoleArn: 'arn:aws-us-gov:iam::222222222222:role/bc',
        }),
      }),
    ]);
    for (const flags of [
      { role: 'bad role!', region: 'us-east-1', zones: 'us-east-1a' },
      { role: 'bc', region: 'mars-1', zones: 'us-east-1a' },
      { role: 'bc', region: 'us-east-1', zones: 'eu-west-1a' },
      { role: 'bc', region: 'us-east-1', zones: 'us-east-1a', parent: 'not-an-ou' },
    ])
      await expect(command.run(harness(flags).context)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });

  it('organization-accounts leaves out the management account, accounts of unknown state and bad --exclude ids', async () => {
    const emu = new AwsEmulator();
    const orgs = new OrganizationsEmulator(emu);
    orgs.managementAccountId = '555555555555';
    orgs.accounts.push(
      { Id: '222222222222', Name: 'ml-prod', Email: 'ml@example.com', Status: 'ACTIVE' },
      { Id: '555555555555', Name: 'payer', Email: 'payer@example.com', Status: 'ACTIVE' },
      // no State or Status (an API change, or truncated data): not rendered
      { Id: '666666666666', Name: 'unknown', Email: 'u@example.com' } as never,
    );
    const command = awsOrganizationAccountsCommand({
      fetch: emu.fetch,
      credentials: emu.ambient,
      clock: emu.clock,
    });
    const flags = { role: 'better-compute', region: 'us-east-1', zones: 'us-east-1a' };
    const plain = harness(flags);
    await command.run(plain.context);
    expect(
      JSON.parse(plain.out.join('\n')).providerAccounts.map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual(['aws-222222222222-us-east-1']);
    expect(plain.notes.join('\n')).toMatch(/1 of 3 accounts/);
    expect(plain.notes.join('\n')).toMatch(/management account 555555555555/);
    expect(plain.notes.join('\n')).toMatch(/1 account of unknown state/);
    // --include-management renders it, and does not ask for the organization
    const before = emu.calls('DescribeOrganization').length;
    const included = harness({ ...flags, 'include-management': true });
    await command.run(included.context);
    expect(
      JSON.parse(included.out.join('\n')).providerAccounts.map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual(['aws-222222222222-us-east-1', 'aws-555555555555-us-east-1']);
    expect(emu.calls('DescribeOrganization')).toHaveLength(before);
    // a management account it cannot read refuses, rather than rendering it
    orgs.managementAccountId = '';
    await expect(command.run(harness(flags).context)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    // --exclude ids are 12-digit account ids, checked before any call
    const calls = emu.requests.length;
    for (const exclude of ['55555555555', '555555555555,acct', 'all'])
      await expect(command.run(harness({ ...flags, exclude }).context)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(emu.requests.length).toBe(calls);
  });

  it('organization-accounts refuses a repeated page token instead of listing forever', async () => {
    const emu = new AwsEmulator();
    new OrganizationsEmulator(emu);
    emu.register(/^organizations\./, {
      service: 'organizations',
      protocol: 'json',
      handle: () =>
        new Response(
          JSON.stringify({
            Accounts: [{ Id: '222222222222', Status: 'ACTIVE' }],
            NextToken: 'same',
            Organization: { MasterAccountId: '555555555555' },
          }),
          { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } },
        ),
    });
    const { out, context } = harness({
      role: 'better-compute',
      region: 'us-east-1',
      zones: 'us-east-1a',
    });
    await expect(
      awsOrganizationAccountsCommand({
        fetch: emu.fetch,
        credentials: emu.ambient,
        clock: emu.clock,
      }).run(context),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: /page token twice/ });
    expect(out).toEqual([]);
    expect(emu.calls('ListAccounts')).toHaveLength(2);
  });

  it('quotas lists the EC2 instance quotas; quota-request asks only with --yes', async () => {
    const emu = new AwsEmulator();
    const quotas = new ServiceQuotasEmulator(emu);
    quotas.pageSize = 1;
    quotas.quotas.push(
      {
        QuotaCode: 'L-1216C47A',
        QuotaName: 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances',
        Value: 64,
        Adjustable: true,
      },
      {
        QuotaCode: 'L-417A185B',
        QuotaName: 'Running On-Demand P instances',
        Value: 0,
        Adjustable: true,
      },
      { QuotaCode: 'L-0263D0A3', QuotaName: 'EC2-VPC Elastic IPs', Value: 5, Adjustable: true },
      {
        QuotaCode: 'L-34B43A08',
        QuotaName: 'All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests',
        Value: 64,
        Adjustable: true,
      },
    );
    const options = { fetch: emu.fetch, credentials: emu.ambient, clock: emu.clock };
    const listed = harness({ region: 'us-east-1' });
    await awsQuotasCommand(options).run(listed.context);
    const rows = JSON.parse(listed.out.join('\n'));
    expect(rows.map((row: { quotaCode: string }) => row.quotaCode)).toEqual([
      'L-1216C47A',
      'L-417A185B',
      'L-34B43A08',
    ]);
    expect(rows[1]).toEqual({
      quotaCode: 'L-417A185B',
      name: 'Running On-Demand P instances',
      value: 0,
      adjustable: true,
    });

    const dry = harness({ region: 'us-east-1', 'quota-code': 'L-417A185B', value: 192 });
    await awsQuotaRequestCommand(options).run(dry.context);
    expect(quotas.requests).toEqual([]);
    expect(dry.notes.join('\n')).toMatch(/--yes/);
    expect(JSON.parse(dry.out.join('\n'))).toMatchObject({
      quotaCode: 'L-417A185B',
      current: 0,
      desired: 192,
      submitted: false,
    });

    const sent = harness({
      region: 'us-east-1',
      'quota-code': 'L-417A185B',
      value: 192,
      yes: true,
    });
    await awsQuotaRequestCommand(options).run(sent.context);
    expect(quotas.requests).toEqual([{ QuotaCode: 'L-417A185B', DesiredValue: 192 }]);
    expect(JSON.parse(sent.out.join('\n'))).toMatchObject({
      submitted: true,
      requestId: 'req-1',
      status: 'PENDING',
    });

    // never a decrease or the same value; never a malformed code
    for (const flags of [
      { region: 'us-east-1', 'quota-code': 'L-1216C47A', value: 64, yes: true },
      { region: 'us-east-1', 'quota-code': 'L-1216C47A', value: 8, yes: true },
      { region: 'us-east-1', 'quota-code': 'bad', value: 8, yes: true },
      { region: 'us-east-1', 'quota-code': 'L-1216C47A', value: -1, yes: true },
    ])
      await expect(
        awsQuotaRequestCommand(options).run(harness(flags).context),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(quotas.requests).toHaveLength(1);
  });
});
