import { describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import { assertAwsSpendBelow, awsMonthToDateCost } from '@better-compute/provider-aws';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { CeEmulator } from './support/aws-emulator/ce.js';

// The A12 live suite's spend guard: month-to-date Cost Explorer spend of the sandbox account.

function world() {
  const emu = new AwsEmulator();
  const ce = new CeEmulator(emu);
  // 2026-10-01 is the emulator's day; move into the month
  emu.clock.advance(9 * 86_400_000 + 3_600_000);
  const base = {
    account: platformAccount,
    region: 'us-east-1',
    service: 'Amazon EC2',
    usageType: 'BoxUsage:t3.micro',
  };
  ce.lines.push(
    { ...base, day: '2026-10-02', cost: '1.25' },
    { ...base, day: '2026-10-10', cost: '0.50' },
    // last month and another account never count
    { ...base, day: '2026-09-30', cost: '100' },
    { ...base, day: '2026-10-03', cost: '100', account: '999999999999' },
  );
  const options = {
    fetch: emu.fetch,
    credentials: emu.ambient,
    clock: emu.clock,
    region: 'us-east-1',
  };
  return { emu, ce, options };
}

describe('provider-aws month-to-date spend', () => {
  it('sums the current UTC month, today included, for one linked account', async () => {
    const { ce, options } = world();
    const spend = await awsMonthToDateCost({ ...options, account: platformAccount });
    expect(spend).toEqual({
      amountMicros: 1_750_000,
      currency: 'USD',
      from: '2026-10-01',
      to: '2026-10-11',
    });
    expect(ce.queries[0]).toMatchObject({
      TimePeriod: { Start: '2026-10-01', End: '2026-10-11' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      Filter: {
        And: [
          { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [platformAccount] } },
          { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } },
        ],
      },
    });
    expect(ce.queries[0]!.GroupBy).toBeUndefined();
  });

  it('compares gross spend: credits and refunds never offset usage', async () => {
    const { ce, options } = world();
    ce.lines.push(
      {
        account: platformAccount,
        region: 'us-east-1',
        service: 'Amazon EC2',
        usageType: '',
        recordType: 'Credit',
        day: '2026-10-05',
        cost: '-1.75',
      },
      {
        account: platformAccount,
        region: 'us-east-1',
        service: 'Amazon EC2',
        usageType: '',
        recordType: 'Refund',
        day: '2026-10-06',
        cost: '-0.5',
      },
    );
    const over = await assertAwsSpendBelow({
      ...options,
      account: platformAccount,
      limitUsd: 1.5,
    }).catch((error: unknown) => error);
    expect(isComputeError(over, 'QUOTA_EXCEEDED')).toBe(true);
    // without an account the filter is the record type alone
    const all = await awsMonthToDateCost(options);
    expect(all.amountMicros).toBe(101_750_000);
    expect(ce.queries.at(-1)!.Filter).toEqual({
      Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } },
    });
  });

  it('refuses to start over the budget, and on a malformed account or budget', async () => {
    const { options } = world();
    await expect(
      assertAwsSpendBelow({ ...options, account: platformAccount, limitUsd: 5 }),
    ).resolves.toMatchObject({ amountMicros: 1_750_000 });
    const over = await assertAwsSpendBelow({
      ...options,
      account: platformAccount,
      limitUsd: 1.5,
    }).catch((error: unknown) => error);
    expect(isComputeError(over, 'QUOTA_EXCEEDED')).toBe(true);
    expect(String((over as Error).message)).toMatch(/1\.75 USD/);
    for (const bad of [{ account: '12' }, { limitUsd: -1 }, { limitUsd: Number.NaN }])
      await expect(
        assertAwsSpendBelow({ ...options, account: platformAccount, limitUsd: 5, ...bad }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
