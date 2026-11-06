import { ComputeError, systemClock } from '@better-compute/core';
import { awsCliClient, type AwsCliOptions } from './finops-cli.js';
import { costMicros } from './costs.js';

// Month-to-date spend of an AWS account from Cost Explorer: the A12 live suite's spend guard refuses to start a
// run when the sandbox account is over its budget (BETTER_COMPUTE_AWS_LIVE_BUDGET_USD). One GetCostAndUsage
// request (charged), DAILY over the current UTC month including today, summed. The spend is gross: credits and
// refunds are left out, so an account living on promotional credits (net about $0) still trips the guard.

const DAY = 86_400_000;
/** Record types that lower the bill without lowering what was burned. */
const offsetRecordTypes = ['Credit', 'Refund'];
const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface AwsSpendOptions extends AwsCliOptions {
  region: string;
  /** Only this linked account's spend (always set it when the identity is a payer's). */
  account?: string;
  signal?: AbortSignal;
}

export interface AwsSpend {
  amountMicros: number;
  currency: string;
  /** The first day counted (`YYYY-MM-DD`). */
  from: string;
  /** The day after the last one counted. */
  to: string;
}

/**
 * The account's gross unblended spend this UTC month (credits and refunds left out), today included, in integer
 * micros of one currency.
 */
export async function awsMonthToDateCost(options: AwsSpendOptions): Promise<AwsSpend> {
  if (options.account !== undefined && !/^\d{12}$/.test(options.account))
    throw new ComputeError('INVALID_INPUT', 'account is a 12-digit AWS account id');
  const now = (options.clock ?? systemClock).now();
  const date = new Date(now);
  const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const to = Math.floor(now / DAY) * DAY + DAY;
  const client = awsCliClient('ce', 'AWSInsightsIndexService', options.region, options);
  const gross = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: [...offsetRecordTypes] } } };
  const filter =
    options.account !== undefined
      ? {
          And: [{ Dimensions: { Key: 'LINKED_ACCOUNT', Values: [options.account] } }, gross],
        }
      : gross;
  let amountMicros = 0;
  let currency: string | undefined;
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 50)
      throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer pagination did not end');
    const response = await client.call<{
      ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string; Unit?: string } } }[];
      NextPageToken?: string;
    }>(
      'GetCostAndUsage',
      {
        TimePeriod: { Start: dayText(from), End: dayText(to) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        Filter: filter,
        ...(token ? { NextPageToken: token } : {}),
      },
      { signal: options.signal ?? AbortSignal.timeout(30_000) },
    );
    for (const result of response.ResultsByTime ?? []) {
      const total = result.Total?.UnblendedCost;
      if (!total?.Amount) continue;
      const unit = total.Unit ?? '';
      if (currency !== undefined && unit !== currency)
        throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer answered spend in two currencies');
      currency = unit;
      amountMicros += costMicros(total.Amount);
    }
    const next = response.NextPageToken || undefined;
    if (!next) break;
    if (seen.has(next))
      throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer returned a page token twice');
    seen.add(next);
    token = next;
  }
  return { amountMicros, currency: currency ?? 'USD', from: dayText(from), to: dayText(to) };
}

/**
 * Resolves with the month-to-date spend when it is under `limitUsd`; `QUOTA_EXCEEDED` when it is not, or when the
 * spend is in a currency other than USD (it cannot be compared). Fail closed.
 */
export async function assertAwsSpendBelow(
  options: AwsSpendOptions & { limitUsd: number },
): Promise<AwsSpend> {
  if (!Number.isFinite(options.limitUsd) || options.limitUsd < 0)
    throw new ComputeError('INVALID_INPUT', 'the spend limit is a non-negative number of USD');
  const spend = await awsMonthToDateCost(options);
  const shown = `${(spend.amountMicros / 1e6).toFixed(2)} ${spend.currency}`;
  if (spend.currency !== 'USD')
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `month-to-date spend is ${shown}, not USD`,
      undefined,
      {
        provider: 'aws',
        reason: 'spend-guard',
      },
    );
  if (spend.amountMicros >= Math.round(options.limitUsd * 1e6))
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `month-to-date spend ${shown} is over the ${options.limitUsd} USD budget`,
      undefined,
      { provider: 'aws', reason: 'spend-guard' },
    );
  return spend;
}
