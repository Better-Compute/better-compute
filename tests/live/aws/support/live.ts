// The AWS live suite's guards (A12). The suite runs only with BETTER_COMPUTE_AWS_LIVE=1, a pinned
// sandbox account id and a month-to-date budget; `livePreflight` then refuses credentials of any
// other account and refuses to start over budget. Every resource carries a test-run tag whose
// value holds its start time, so `scripts/aws-live-sweep.mjs` can delete what a crashed run left.
// tests/aws-live-guards.test.ts pins all of it on the emulator.
import { randomBytes } from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import { envCredentialSource } from '@better-compute/aws';
import {
  assertRegion,
  createTransport,
  jsonClient,
  queryClient,
  type CredentialSource,
} from '../../../../packages/aws/src/internal/transport.js';

/** Every resource a live run creates carries this tag; its value is the run id. */
export const testRunTagKey = 'better-compute:test-run';
/** Instance types a live run may launch. */
export const liveInstanceTypes = ['t4g.nano', 't3.micro'] as const;
/** The sweeper deletes resources of runs older than this. */
export const sweepAfterMs = 2 * 60 * 60_000;

export interface LiveConfig {
  region: string;
  /** The sandbox account id; the credentials must belong to it. */
  account: string;
  /** Refuse to start once Cost Explorer's month-to-date unblended cost is over this. */
  budgetUsd: number;
  credentials: CredentialSource;
}

export type LiveGate = { enabled: true; config: LiveConfig } | { enabled: false; reason: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Off unless BETTER_COMPUTE_AWS_LIVE is exactly `1`. Once on, a missing or malformed setting is an
 * INVALID_CONFIG error rather than a skip, so a misconfigured run fails visibly before any call.
 */
export function liveGate(env: Env = process.env): LiveGate {
  if (env.BETTER_COMPUTE_AWS_LIVE !== '1') return { enabled: false, reason: 'BETTER_COMPUTE_AWS_LIVE is not 1' };
  const account = env.BETTER_COMPUTE_AWS_LIVE_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account))
    throw new ComputeError('INVALID_CONFIG', 'BETTER_COMPUTE_AWS_LIVE_ACCOUNT must be the 12-digit sandbox account id');
  const budgetText = env.BETTER_COMPUTE_AWS_LIVE_BUDGET_USD;
  const budgetUsd = budgetText === undefined || budgetText.trim() === '' ? Number.NaN : Number(budgetText);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw new ComputeError('INVALID_CONFIG', 'BETTER_COMPUTE_AWS_LIVE_BUDGET_USD must be a positive number of US dollars');
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
    throw new ComputeError(
      'INVALID_CONFIG',
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must hold the sandbox credentials (aws configure export-credentials --profile <sandbox> --format env)',
    );
  const region = env.BETTER_COMPUTE_AWS_LIVE_REGION || env.AWS_REGION || 'us-east-1';
  assertRegion(region);
  return { enabled: true, config: { region, account, budgetUsd, credentials: envCredentialSource(env) } };
}

/** Test hooks: an emulator's fetch and clock, and its endpoint. */
export interface LiveDeps {
  fetch?: typeof fetch;
  clock?: Clock;
  endpoint?: string;
}

function transport(config: LiveConfig, deps: LiveDeps, region = config.region) {
  return createTransport({
    region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
}

/** The account and ARN of the credentials (STS GetCallerIdentity). */
export async function liveIdentity(config: LiveConfig, deps: LiveDeps = {}): Promise<{ account: string; arn: string }> {
  const sts = queryClient(transport(config, deps), { hostPrefix: 'sts', version: '2011-06-15' });
  const root = await sts.call('GetCallerIdentity', {});
  const result = root.child('GetCallerIdentityResult');
  const account = result?.textOf('Account');
  const arn = result?.textOf('Arn');
  if (!account || !arn) throw new ComputeError('PROVIDER_ERROR', 'GetCallerIdentity returned no account');
  return { account, arn };
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Cost Explorer month-to-date unblended cost in USD (this month through the first of the next). */
export async function monthToDateSpendUsd(config: LiveConfig, deps: LiveDeps = {}): Promise<number> {
  const now = (deps.clock ?? systemClock).now();
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  // Cost Explorer has one endpoint, in us-east-1, for the commercial partition.
  const ce = jsonClient(transport(config, deps, 'us-east-1'), { hostPrefix: 'ce', jsonVersion: '1.1', targetPrefix: 'AWSInsightsIndexService' });
  let total = 0;
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await ce.call<{
      ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string; Unit?: string } } }[];
      NextPageToken?: string;
    }>('GetCostAndUsage', {
      TimePeriod: { Start: day(start), End: day(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      ...(token ? { NextPageToken: token } : {}),
    });
    for (const result of response.ResultsByTime ?? []) {
      const cost = result.Total?.UnblendedCost;
      if (!cost) continue;
      if (cost.Unit !== 'USD') throw new ComputeError('PROVIDER_ERROR', `Cost Explorer answered in ${String(cost.Unit)}, not USD`);
      const amount = Number(cost.Amount);
      if (!Number.isFinite(amount)) throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer returned an unreadable amount');
      total += amount;
    }
    token = response.NextPageToken;
    if (!token) return Math.round(total * 100) / 100;
  }
  throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer kept paginating');
}

/**
 * Runs before a live suite creates anything: the credentials must be the sandbox account's, and
 * the month-to-date spend must be within the budget (Cost Explorer lags by up to a day).
 */
export async function livePreflight(config: LiveConfig, deps: LiveDeps = {}): Promise<{ account: string; monthToDateUsd: number }> {
  const { account } = await liveIdentity(config, deps);
  if (account !== config.account)
    throw new ComputeError('ACCESS_DENIED', `the credentials are for account ${account}, not the sandbox account ${config.account}`);
  const monthToDateUsd = await monthToDateSpendUsd(config, deps);
  if (monthToDateUsd > config.budgetUsd)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `the sandbox account has spent ${monthToDateUsd.toFixed(2)} USD this month, over the live-suite budget of ${config.budgetUsd} USD`,
    );
  return { account, monthToDateUsd };
}

/** `r<unix seconds>-<8 hex>`: the run's start time is in its id. */
export function newTestRunId(now: number = Date.now(), suffix: string = randomBytes(4).toString('hex')): string {
  return `r${Math.floor(now / 1000)}-${suffix}`;
}

/** The start time (epoch ms) of a run id, or undefined for anything that is not one. */
export function testRunStartedAt(value: string): number | undefined {
  const match = /^r(\d{10})-[0-9a-f]{8}$/.exec(value);
  return match ? Number(match[1]) * 1000 : undefined;
}

/** The tags of every resource a live run creates. */
export function liveTags(runId: string): { Key: string; Value: string }[] {
  return [
    { Key: testRunTagKey, Value: runId },
    { Key: 'better-compute:managed', Value: 'true' },
  ];
}

export function assertLiveInstanceType(type: string): string {
  if (!(liveInstanceTypes as readonly string[]).includes(type))
    throw new ComputeError('INVALID_INPUT', `${type || '(empty)'} is not on the live-suite allow-list (${liveInstanceTypes.join(', ')})`);
  return type;
}
