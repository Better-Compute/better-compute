import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderCostRecord,
} from '@better-compute/core';
import {
  awsBilling,
  awsConfig,
  awsProvider,
  costMicros,
  usageTypeRegion,
  usageTypeService,
  validateAwsConfig,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { CeEmulator, type CeLine } from './support/aws-emulator/ce.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const instanceTag = 'better-compute:instance';
const tenantTag = 'better-compute:tenant';

async function world(overrides: Record<string, unknown> = { costs: 'region' }) {
  const emu = new AwsEmulator();
  const ce = new CeEmulator(emu);
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const config = awsConfig.parse({
    region: 'us-east-1',
    zones: ['us-east-1a'],
    ...overrides,
  }) as AwsConfig;
  const impl = await provider.create(config, {
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  });
  const call = (): CallContext => ({
    idempotencyKey: 'costs:pa_platform',
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  const read = async (from: number, to: number) => {
    const out: ProviderCostRecord[] = [];
    for await (const record of impl.costs!({ from, to }, call())) out.push(record);
    return out;
  };
  // 2026-10-01T00:00Z: the emulator's clock.
  const today = emu.now();
  return { emu, ce, impl, read, today };
}

const line = (overrides: Partial<CeLine> = {}): CeLine => ({
  day: '2026-09-29',
  account: platformAccount,
  region: 'us-east-1',
  service: 'Amazon Elastic Compute Cloud - Compute',
  usageType: 'BoxUsage:m7i.large',
  cost: '1.2096',
  quantity: '12',
  unit: 'Hrs',
  ...overrides,
});

describe('provider-aws costs (Cost Explorer)', () => {
  it('is absent unless the account opts in', async () => {
    const { impl } = await world({});
    expect(impl.costs).toBeUndefined();
    expect(() =>
      awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'], costs: 'all' }),
    ).toThrow();
  });

  it('costs are refused outside the commercial partition', () => {
    for (const [region, zone] of [
      ['us-gov-west-1', 'us-gov-west-1a'],
      ['cn-north-1', 'cn-north-1a'],
    ] as const) {
      for (const costs of ['region', 'account'] as const) {
        const config = awsConfig.parse({ region, zones: [zone], costs }) as AwsConfig;
        let refused: unknown;
        try {
          validateAwsConfig(config);
        } catch (error) {
          refused = error;
        }
        expect(isComputeError(refused, 'INVALID_CONFIG')).toBe(true);
        expect((refused as { details?: { reason?: string } }).details?.reason).toBe(
          'costs-partition',
        );
      }
      expect(() =>
        validateAwsConfig(awsConfig.parse({ region, zones: [zone], costs: 'off' }) as AwsConfig),
      ).not.toThrow();
    }
  });

  it('reads daily rows by instance tag, then tenant tag, with the labels vps reads', async () => {
    const { ce, read, today } = await world();
    ce.lines.push(
      line({ tags: { [instanceTag]: 'ins_a', [tenantTag]: 'acme' } }),
      line({
        service: 'EC2 - Other',
        usageType: 'EBS:VolumeUsage.gp3',
        cost: '0.2667',
        quantity: '3.3333',
        unit: 'GB-Mo',
        tags: { [instanceTag]: 'ins_a', [tenantTag]: 'acme' },
      }),
      line({
        service: 'EC2 - Other',
        usageType: 'USE1-DataTransfer-Regional-Bytes',
        cost: '0.04',
        quantity: '4',
        unit: 'GB',
        tags: { [tenantTag]: 'acme' },
      }),
      line({
        service: 'Amazon Simple Storage Service',
        usageType: 'TimedStorage-ByteHrs',
        cost: '0.5',
      }),
      line({
        recordType: 'Tax',
        service: 'Amazon Elastic Compute Cloud - Compute',
        cost: '0.11',
        usageType: '',
      }),
      line({
        recordType: 'Credit',
        service: 'Amazon Elastic Compute Cloud - Compute',
        cost: '-0.30',
        usageType: '',
      }),
    );
    const records = await read(today - 3 * DAY, today);
    const by = (sku: string) => records.filter((record) => record.sku === sku);
    expect(records).toHaveLength(6);
    const [box] = by('BoxUsage:m7i.large');
    expect(box).toMatchObject({
      service: 'Amazon Elastic Compute Cloud - Compute',
      region: 'us-east-1',
      project: platformAccount,
      usageStart: Date.UTC(2026, 8, 29),
      usageEnd: Date.UTC(2026, 8, 30),
      quantity: 12,
      unit: 'Hrs',
      costMicros: 1_209_600,
      creditsMicros: 0,
      currency: 'USD',
      labels: { 'better-compute-instance': 'ins_a' },
    });
    expect(box!.costType).toBeUndefined();
    expect(by('EBS:VolumeUsage.gp3')[0]).toMatchObject({
      service: 'EC2 - Other',
      labels: { 'better-compute-instance': 'ins_a' },
      costMicros: 266_700,
    });
    // no instance tag: attributed by the tenant tag
    expect(by('USE1-DataTransfer-Regional-Bytes')[0]).toMatchObject({
      labels: { 'better-compute-tenant': 'acme' },
      costMicros: 40_000,
    });
    // neither tag: the account's
    expect(by('TimedStorage-ByteHrs')[0]!.labels).toEqual({});
    // tax and credits are not regular usage; credits are never positive cost
    expect(by('Tax')[0]).toMatchObject({ costType: 'tax', costMicros: 110_000, creditsMicros: 0 });
    expect(by('Credit')[0]).toMatchObject({
      costType: 'credit',
      costMicros: 0,
      creditsMicros: -300_000,
    });
    // instance-tagged rows never come out twice (once by instance, once by tenant)
    const total = records.reduce(
      (sum, record) => sum + record.costMicros + record.creditsMicros,
      0,
    );
    expect(total).toBe(1_209_600 + 266_700 + 40_000 + 500_000 + 110_000 - 300_000);
  });

  it("filters every query to the caller's own account and, in region scope, its region", async () => {
    const { ce, read, today } = await world();
    ce.lines.push(
      line({ cost: '1' }),
      line({ cost: '2', account: '999999999999' }),
      line({ cost: '4', region: 'eu-west-1', usageType: 'EU-BoxUsage:m7i.large' }),
    );
    const records = await read(today - 3 * DAY, today);
    expect(records.map((record) => record.costMicros)).toEqual([1_000_000]);
    for (const query of ce.queries) {
      const text = JSON.stringify(query.Filter);
      expect(text).toContain(`"Key":"LINKED_ACCOUNT","Values":["${platformAccount}"]`);
      expect(text).toContain('"Key":"REGION","Values":["us-east-1"]');
    }
    expect(ce.queries).toHaveLength(3);
    expect(ce.queries[0]).toMatchObject({
      TimePeriod: { Start: '2026-09-28', End: '2026-10-01' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost', 'UsageQuantity'],
    });
  });

  it("region scope also reads the Local Zone groups of the account's zones", async () => {
    const { ce, read, today } = await world({
      region: 'us-west-2',
      zones: ['us-west-2a', 'us-west-2-lax-1a', 'us-west-2-lax-1b'],
      costs: 'region',
    });
    ce.lines.push(
      line({ region: 'us-west-2', usageType: 'USW2-BoxUsage:m7i.large', cost: '1' }),
      // Cost Explorer reports Local Zone usage under the zone group's own REGION value
      line({
        region: 'us-west-2-lax-1',
        usageType: 'USW2-LAX1-BoxUsage:t3.medium',
        cost: '2',
        tags: { [instanceTag]: 'ins_lz' },
      }),
      // a Local Zone group the account does not list stays out
      line({ region: 'us-west-2-den-1', usageType: 'USW2-DEN1-BoxUsage:t3.medium', cost: '4' }),
    );
    const records = await read(today - 3 * DAY, today);
    expect(records.map((record) => [record.sku, record.region, record.costMicros])).toEqual([
      ['USW2-LAX1-BoxUsage:t3.medium', 'us-west-2', 2_000_000],
      ['USW2-BoxUsage:m7i.large', 'us-west-2', 1_000_000],
    ]);
    expect(records[0]!.labels).toEqual({ 'better-compute-instance': 'ins_lz' });
    for (const query of ce.queries)
      expect(JSON.stringify(query.Filter)).toContain(
        '"Key":"REGION","Values":["us-west-2","us-west-2-lax-1"]',
      );
  });

  it('account scope reads every region of the account', async () => {
    const { ce, read, today } = await world({ costs: 'account' });
    ce.lines.push(
      line({ cost: '1' }),
      line({ cost: '4', region: 'eu-west-1', usageType: 'EU-BoxUsage:m7i.large' }),
    );
    const records = await read(today - 3 * DAY, today);
    expect(records.map((record) => [record.region, record.costMicros])).toEqual([
      ['us-east-1', 1_000_000],
      ['eu-west-1', 4_000_000],
    ]);
    for (const query of ce.queries) expect(JSON.stringify(query.Filter)).not.toContain('"REGION"');
  });

  it('yields only days that start inside the window and pages through NextPageToken', async () => {
    const { ce, read, today } = await world();
    ce.pageSize = 2;
    for (const day of ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'])
      for (const id of ['ins_a', 'ins_b', 'ins_c'])
        ce.lines.push(line({ day, cost: '1', tags: { [instanceTag]: id } }));
    const records = await read(today - 2.5 * DAY, today);
    // 2026-09-28 starts before the window (it starts at 09-28T12:00): only 09-29 and 09-30
    expect(
      new Set(records.map((record) => new Date(record.usageStart).toISOString().slice(0, 10))),
    ).toEqual(new Set(['2026-09-29', '2026-09-30']));
    expect(records).toHaveLength(6);
    expect(ce.queries.filter((query) => query.NextPageToken !== undefined).length).toBeGreaterThan(
      0,
    );
  });

  it('a window up to now that cannot cover two full days is refused, not read as nothing', async () => {
    const { emu, ce, read, today } = await world();
    ce.lines.push(line({ day: '2026-09-30' }), line({ day: '2026-09-29' }));
    emu.clock.advance(6 * 3_600_000);
    const now = today + 6 * 3_600_000;
    // vps lookbackDays 1 and 2: from is inside a day, so only 0 or 1 full days precede today
    for (const days of [1, 2]) {
      const refused = await read(now - days * DAY, now).catch((error: unknown) => error);
      expect(isComputeError(refused, 'INVALID_CONFIG')).toBe(true);
      expect((refused as { details?: { reason?: string } }).details?.reason).toBe('costs-window');
      expect((refused as Error).message).toContain('lookbackDays');
    }
    expect(ce.queries).toHaveLength(0);
    // the default (3) reads each finished day twice
    expect(await read(now - 3 * DAY, now)).toHaveLength(2);
    // a window that ends in the past is read as asked, however short
    const past = await read(Date.UTC(2026, 8, 29), Date.UTC(2026, 8, 30));
    expect(past.map((record) => record.usageStart)).toEqual([Date.UTC(2026, 8, 29)]);
  });

  it('row ids are stable across reads and amounts are exact micros', async () => {
    const { emu, ce, read, today } = await world();
    ce.lines.push(line({ cost: '0.1' }), line({ cost: '0.2', usageType: 'BoxUsage:c7i.large' }));
    const first = await read(today - 3 * DAY, today);
    emu.clock.advance(DAY);
    ce.lines[0]!.cost = '0.3';
    const second = await read(today - 3 * DAY, today);
    expect(second.map((record) => record.sourceRowId)).toEqual(
      first.map((record) => record.sourceRowId),
    );
    expect(second.map((record) => record.costMicros)).toEqual([300_000, 200_000]);
    expect(second[0]!.exportTime).toBeGreaterThan(first[0]!.exportTime);
    expect(costMicros('0.0000005')).toBe(1);
    expect(costMicros('-0.0000005')).toBe(-1);
    expect(costMicros('12.3456789')).toBe(12_345_679);
    expect(costMicros('1e-7')).toBe(0);
    expect(costMicros('-0.0000001')).toBe(0);
    expect(costMicros('garbage')).toBe(0);
  });

  it('costMicros reads the scientific notation Cost Explorer gives tiny amounts', () => {
    expect(costMicros('1.2E-5')).toBe(12);
    expect(costMicros('1.2e-5')).toBe(costMicros('0.000012'));
    expect(costMicros('-3.4E-6')).toBe(-3);
    expect(costMicros('5E-7')).toBe(1);
    expect(costMicros('4.9E-7')).toBe(0);
    expect(costMicros('1.5E+2')).toBe(150_000_000);
    expect(costMicros('2.5E3')).toBe(2_500_000_000);
    expect(costMicros('1.23456789E1')).toBe(12_345_679);
    // no float drift: the half-micro is read from the digits, not a product of floats
    expect(costMicros('3.000005E-1')).toBe(300_001);
    expect(costMicros('3.0000049E-1')).toBe(300_000);
    expect(costMicros('1E')).toBe(0);
    expect(costMicros('1E-')).toBe(0);
    expect(costMicros('1E99')).toBe(0);
  });

  it('reads a window once a day, then again the next day', async () => {
    const { emu, ce, read, today } = await world();
    ce.lines.push(line());
    await read(today - 3 * DAY, today);
    const calls = ce.queries.length;
    emu.clock.advance(6 * 3_600_000);
    await read(today + 6 * 3_600_000 - 3 * DAY, today + 6 * 3_600_000);
    expect(ce.queries.length).toBe(calls);
    emu.clock.advance(DAY);
    await read(today + DAY - 3 * DAY, today + DAY);
    expect(ce.queries.length).toBe(2 * calls);
  });

  it('Cost Explorer throttling is RATE_LIMITED with a back-off; an unready bill is UNAVAILABLE', async () => {
    const { emu, ce, read, today } = await world();
    ce.lines.push(line());
    emu.failNext('GetCostAndUsage', 'LimitExceededException');
    const throttled = await read(today - 3 * DAY, today).catch((error: unknown) => error);
    expect(isComputeError(throttled, 'RATE_LIMITED')).toBe(true);
    expect((throttled as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThanOrEqual(60_000);
    emu.failNext('GetCostAndUsage', 'DataUnavailableException');
    const unready = await read(today - 3 * DAY, today).catch((error: unknown) => error);
    expect(isComputeError(unready, 'UNAVAILABLE')).toBe(true);
    emu.failNext('GetCostAndUsage', 'AccessDeniedException');
    const denied = await read(today - 3 * DAY, today).catch((error: unknown) => error);
    expect(isComputeError(denied, 'ACCESS_DENIED')).toBe(true);
  });

  it('usage types name their service and region', () => {
    expect(usageTypeService('BoxUsage:t3.micro')).toBe('Amazon Elastic Compute Cloud - Compute');
    expect(usageTypeService('USE2-SpotUsage:g5.xlarge')).toBe(
      'Amazon Elastic Compute Cloud - Compute',
    );
    expect(usageTypeService('EUC1-EBS:VolumeUsage.gp3')).toBe('EC2 - Other');
    expect(usageTypeService('USE1-PublicIPv4:InUseAddress')).toBe('Amazon Virtual Private Cloud');
    expect(usageTypeService('TimedStorage-ByteHrs')).toBe('AWS');
    expect(usageTypeRegion('BoxUsage:t3.micro')).toBe('us-east-1');
    expect(usageTypeRegion('EUC1-EBS:VolumeUsage.gp3')).toBe('eu-central-1');
    expect(usageTypeRegion('EU-BoxUsage:m7i.large')).toBe('eu-west-1');
    expect(usageTypeRegion('APN1-BoxUsage:m7i.large')).toBe('ap-northeast-1');
    expect(usageTypeRegion('XYZ9-BoxUsage:m7i.large')).toBeUndefined();
  });

  it('awsBilling: instance hours are compute, EBS volumes and public IPv4 are metered', () => {
    const compute = (sku: string, service = 'Amazon Elastic Compute Cloud - Compute') =>
      awsBilling.computeSku({ service, sku });
    const metered = (sku: string, service = 'EC2 - Other') =>
      awsBilling.meteredSku({ service, sku });
    expect(compute('BoxUsage:m7i.large')).toBe(true);
    expect(compute('USE2-SpotUsage:p5.48xlarge')).toBe(true);
    expect(compute('USE1-DedicatedUsage:c7i.large')).toBe(true);
    expect(compute('EBS:VolumeUsage.gp3', 'EC2 - Other')).toBe(false);
    expect(compute('BoxUsage:m7i.large', 'Amazon Relational Database Service')).toBe(false);
    // a pass-through rule's probe: an empty service may be compute
    expect(
      awsBilling.computeSku({ service: '', sku: 'boxusage', skuDescription: 'boxusage' }),
    ).toBe(true);
    expect(metered('EBS:VolumeUsage.gp3')).toBe(true);
    expect(metered('USE1-EBS:VolumeP-IOPS.io2')).toBe(true);
    expect(metered('USE1-PublicIPv4:InUseAddress', 'Amazon Virtual Private Cloud')).toBe(true);
    expect(metered('USE1-DataTransfer-Out-Bytes')).toBe(false);
    expect(awsProvider().billing).toBe(awsBilling);
  });

  it('awsBilling: Local Zone and Wavelength usage types are instance hours and metered disks too', () => {
    const compute = (sku: string, service = 'Amazon Elastic Compute Cloud - Compute') =>
      awsBilling.computeSku({ service, sku });
    const metered = (sku: string, service = 'EC2 - Other') =>
      awsBilling.meteredSku({ service, sku });
    expect(usageTypeService('USW2-LAX1-BoxUsage:t3.medium')).toBe(
      'Amazon Elastic Compute Cloud - Compute',
    );
    expect(usageTypeService('USE1-MIA1-SpotUsage:c5.large')).toBe(
      'Amazon Elastic Compute Cloud - Compute',
    );
    expect(usageTypeService('USW2-LAX1-EBS:VolumeUsage.gp3')).toBe('EC2 - Other');
    expect(usageTypeRegion('USW2-LAX1-BoxUsage:t3.medium')).toBe('us-west-2');
    expect(compute('USW2-LAX1-BoxUsage:t3.medium')).toBe(true);
    expect(compute('USE1-MIA1-SpotUsage:c5.large')).toBe(true);
    expect(compute('USE1-WL1-BOS1-BoxUsage:t3.medium')).toBe(true);
    expect(metered('USW2-LAX1-EBS:VolumeUsage.gp3')).toBe(true);
    expect(metered('USE1-MIA1-PublicIPv4:InUseAddress', 'Amazon Virtual Private Cloud')).toBe(true);
    // a pass-through rule `LAX1` is not itself compute, but the Local Zone rows it matches are: vps's
    // judge refuses any row computeSku or meteredSku claims, so they are never billed twice
    const probe = { service: '', sku: 'LAX1', skuDescription: 'LAX1' };
    expect(awsBilling.computeSku(probe) || awsBilling.meteredSku(probe)).toBe(false);
    for (const [service, sku] of [
      ['Amazon Elastic Compute Cloud - Compute', 'USW2-LAX1-BoxUsage:t3.medium'],
      ['EC2 - Other', 'USW2-LAX1-EBS:VolumeUsage.gp3'],
    ] as const) {
      expect(new RegExp('LAX1', 'i').test(sku)).toBe(true);
      expect(
        awsBilling.computeSku({ service, sku }) || awsBilling.meteredSku({ service, sku }),
      ).toBe(true);
    }
    // a family is never mistaken for a zone segment
    expect(compute('USE1-BoxUsage:m7i.large')).toBe(true);
    expect(usageTypeService('USE1-DataTransfer-Out-Bytes')).toBe('EC2 - Other');
  });
});
