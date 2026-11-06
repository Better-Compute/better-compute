import { describe, expect, it } from 'vitest';
import {
  assertLiveInstanceType,
  liveGate,
  livePreflight,
  liveTags,
  newTestRunId,
  testRunStartedAt,
  testRunTagKey,
} from './live/aws/support/live.js';
import { AwsEmulator, testAccessKeyId, testSecret } from './support/aws-platform-emulator/index.js';
import { costExplorerFake, stsFake } from './support/aws-live-fakes.js';

// The AWS live suite's guards (A12), pinned on the emulator: the suite is off unless explicitly
// enabled; enabled, it needs a pinned sandbox account and a budget, refuses any other account,
// refuses to start over budget, tags every resource with a test-run id the sweeper can age, and
// launches only allow-listed instance types.

const SANDBOX = '210987654321';
const fullEnv = {
  BETTER_COMPUTE_AWS_LIVE: '1',
  BETTER_COMPUTE_AWS_LIVE_ACCOUNT: SANDBOX,
  BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '25',
  AWS_ACCESS_KEY_ID: testAccessKeyId,
  AWS_SECRET_ACCESS_KEY: testSecret,
};

function world(options: { account?: string; spend?: { amount: string; unit?: string }[]; now?: number } = {}) {
  const emu = new AwsEmulator(options.now);
  stsFake(emu, { account: options.account ?? SANDBOX });
  const ce = costExplorerFake(emu, { results: options.spend ?? [{ amount: '3.21' }] });
  const gate = liveGate(fullEnv);
  if (!gate.enabled) throw new Error('expected the gate to be open');
  const deps = { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local' };
  return { emu, ce, config: gate.config, deps };
}

describe('liveGate', () => {
  it('is off unless BETTER_COMPUTE_AWS_LIVE is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(liveGate({ ...fullEnv, BETTER_COMPUTE_AWS_LIVE: value }).enabled, String(value)).toBe(false);
    expect(liveGate({}).enabled).toBe(false);
  });

  it('opens with a pinned account, a budget and credentials; region defaults to us-east-1', () => {
    const gate = liveGate(fullEnv);
    expect(gate.enabled).toBe(true);
    if (!gate.enabled) return;
    expect(gate.config).toMatchObject({ account: SANDBOX, budgetUsd: 25, region: 'us-east-1' });
    expect(liveGate({ ...fullEnv, AWS_REGION: 'eu-west-1' })).toMatchObject({ config: { region: 'eu-west-1' } });
    expect(liveGate({ ...fullEnv, AWS_REGION: 'eu-west-1', BETTER_COMPUTE_AWS_LIVE_REGION: 'us-west-2' })).toMatchObject({ config: { region: 'us-west-2' } });
  });

  it('fails loudly, without echoing secrets, when enabled but misconfigured', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ BETTER_COMPUTE_AWS_LIVE_ACCOUNT: undefined }, /BETTER_COMPUTE_AWS_LIVE_ACCOUNT/],
      [{ BETTER_COMPUTE_AWS_LIVE_ACCOUNT: '12345' }, /BETTER_COMPUTE_AWS_LIVE_ACCOUNT/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: undefined }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '0' }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: 'lots' }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ AWS_SECRET_ACCESS_KEY: undefined }, /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/],
      [{ BETTER_COMPUTE_AWS_LIVE_REGION: 'moon-1' }, /region/],
    ];
    for (const [overrides, message] of cases) {
      let error: unknown;
      try {
        liveGate({ ...fullEnv, ...overrides });
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(overrides)).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(testSecret);
    }
  });
});

describe('livePreflight', () => {
  it('passes in the sandbox account under budget', async () => {
    const { config, deps } = world();
    await expect(livePreflight(config, deps)).resolves.toEqual({ account: SANDBOX, monthToDateUsd: 3.21 });
  });

  it('refuses credentials of any other account before spending anything', async () => {
    const { emu, config, deps } = world({ account: '111111111111' });
    await expect(livePreflight(config, deps)).rejects.toThrow(/not the sandbox account/);
    expect(emu.calls('GetCostAndUsage')).toHaveLength(0);
  });

  it('refuses to start when month-to-date spend is over the budget', async () => {
    const { config, deps } = world({ spend: [{ amount: '20.50' }, { amount: '4.60' }] });
    await expect(livePreflight(config, deps)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', message: expect.stringMatching(/25\.10.*25/) });
  });

  it('refuses a cost it cannot read as USD', async () => {
    const { config, deps } = world({ spend: [{ amount: '1', unit: 'EUR' }] });
    await expect(livePreflight(config, deps)).rejects.toThrow(/USD/);
    const garbled = world({ spend: [{ amount: 'n/a' }] });
    await expect(livePreflight(garbled.config, garbled.deps)).rejects.toThrow(/amount/);
  });

  it('asks Cost Explorer for this month, through the first of the next, by the injected clock', async () => {
    const { ce, config, deps } = world({ now: Date.UTC(2026, 11, 31, 23, 0, 0) });
    await livePreflight(config, deps);
    expect(ce.requests[0]).toMatchObject({
      TimePeriod: { Start: '2026-12-01', End: '2027-01-01' },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    });
  });
});

describe('test-run tagging and the instance allow-list', () => {
  it('a run id carries its start time, which the sweeper reads back', () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const id = newTestRunId(now, 'deadbeef');
    expect(id).toBe(`r${now / 1000}-deadbeef`);
    expect(testRunStartedAt(id)).toBe(now);
    expect(newTestRunId(now)).toMatch(/^r\d{10}-[0-9a-f]{8}$/);
    for (const bad of ['', 'r123-deadbeef', `r${now / 1000}-DEADBEEF`, `x${now / 1000}-deadbeef`, `r${now / 1000}-deadbeef-x`])
      expect(testRunStartedAt(bad), bad).toBeUndefined();
  });

  it('tags resources with the run and the managed marker', () => {
    expect(liveTags('r1-x')).toEqual([
      { Key: testRunTagKey, Value: 'r1-x' },
      { Key: 'better-compute:managed', Value: 'true' },
    ]);
  });

  it('launches only the allow-listed instance types', () => {
    expect(assertLiveInstanceType('t4g.nano')).toBe('t4g.nano');
    expect(assertLiveInstanceType('t3.micro')).toBe('t3.micro');
    for (const type of ['p5.48xlarge', 't3.small', 'T3.MICRO', ''])
      expect(() => assertLiveInstanceType(type), type).toThrow(/allow-list/);
  });
});
