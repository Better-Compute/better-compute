import type { ComputeError, ProviderCostRecord, ProviderImpl } from '@better-compute/core';
import type { GcpProviderOptions } from '@better-compute/provider-gcp';
import { describe, expect, it } from 'vitest';
import { billingRow, GceEmulator } from './support/gce-emulator.js';
import { build, ctx, gcpAccount } from './support/gcp-harness.js';

// provider-gcp provider costs (Task 14, D10): the BigQuery detailed billing export, read with a
// parameterized query, paged, polled within a budget, and mapped to ProviderCostRecord.

const table = 'billing-proj.billing.gcp_billing_export_resource_v1_0000';
const exportAccount = { ...gcpAccount, billingExport: table, billingExportLocation: 'US' };
const window = {
  from: Date.parse('2026-10-01T00:00:00Z'),
  to: Date.parse('2026-10-02T00:00:00Z'),
};

async function costsOf(
  emu: GceEmulator,
  options: GcpProviderOptions = {},
  config: Record<string, unknown> = exportAccount,
): Promise<ProviderCostRecord[]> {
  const impl = await build(emu, config, options);
  const records: ProviderCostRecord[] = [];
  for await (const record of impl.costs!(window, ctx())) records.push(record);
  return records;
}

describe('provider costs from the BigQuery billing export', () => {
  it('reads and maps export rows', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(
      billingRow({
        sku: { id: '984A-1F5A-A3D8', description: 'Network Internet Egress from Americas to EMEA' },
        service: { id: '6F81-5844-456A', description: 'Compute Engine' },
        usage: {
          amount: 3221225472,
          unit: 'bytes',
          amount_in_pricing_units: 3,
          pricing_unit: 'gibibyte',
        },
        cost: 0.36,
        labels: [
          { key: 'better-compute-instance', value: 'ins_1' },
          { key: 'team', value: 'a' },
        ],
        export_time: '2026-10-01T05:30:00.000Z',
      }),
      // outside the window: never returned
      billingRow({ usage_start_time: '2026-10-02T00:00:00.000Z' }),
      billingRow({ usage_start_time: '2026-09-30T23:00:00.000Z' }),
    );
    const records = await costsOf(emu);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toEqual({
      sourceRowId: expect.stringMatching(/^[0-9a-f]{64}$/),
      service: 'Compute Engine',
      sku: '984A-1F5A-A3D8',
      skuDescription: 'Network Internet Egress from Americas to EMEA',
      region: 'us-central1',
      zone: 'us-central1-a',
      project: 'p',
      resourceName: 'vm-1',
      usageStart: Date.parse('2026-10-01T00:00:00Z'),
      usageEnd: Date.parse('2026-10-01T01:00:00Z'),
      quantity: 3,
      unit: 'gibibyte',
      costMicros: 360_000,
      creditsMicros: 0,
      currency: 'USD',
      labels: { 'better-compute-instance': 'ins_1', team: 'a' },
      exportTime: Date.parse('2026-10-01T05:30:00Z'),
      costType: 'regular',
    });
    // the job runs in the export's project and location, with the token the account mints
    const post = emu.requests.find((r) => r.url.hostname === 'bigquery.googleapis.com')!;
    expect(post.method).toBe('POST');
    expect(post.url.pathname).toBe('/bigquery/v2/projects/billing-proj/queries');
    expect(post.body?.location).toBe('US');
  });

  it('absent optional columns stay absent, and an account without an export has no costs', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(
      billingRow({ location: null, resource: null, project: null, sku: { id: 'X' } }),
    );
    const [record] = await costsOf(emu);
    expect(record).toMatchObject({ sku: 'X', service: 'Compute Engine' });
    for (const key of ['skuDescription', 'region', 'zone', 'project', 'resourceName'])
      expect(record).not.toHaveProperty(key);
    const plain: ProviderImpl = await build(new GceEmulator());
    expect(plain.costs).toBeUndefined();
  });

  it('query parameters, never interpolation', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(billingRow());
    await costsOf(emu);
    const [body] = emu.bigquery.queries;
    expect(body.useLegacySql).toBe(false);
    expect(body.parameterMode).toBe('NAMED');
    expect(body.queryParameters).toEqual([
      {
        name: 'from',
        parameterType: { type: 'TIMESTAMP' },
        parameterValue: { value: '2026-10-01 00:00:00.000+00:00' },
      },
      {
        name: 'to',
        parameterType: { type: 'TIMESTAMP' },
        parameterValue: { value: '2026-10-02 00:00:00.000+00:00' },
      },
    ]);
    const sql = String(body.query);
    expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(sql).not.toMatch(/\b17\d{8,}\b/); // no epoch literals either
    expect(sql).toContain(`FROM \`${table}\``);
    expect(sql).toMatch(/usage_start_time >= @from AND usage_start_time < @to/);
    // every column the brief lists is selected
    for (const column of [
      'service.description',
      'sku.id',
      'sku.description',
      'location.region',
      'location.zone',
      'project.id',
      'resource.name',
      'usage_start_time',
      'usage_end_time',
      'usage.amount_in_pricing_units',
      'usage.pricing_unit',
      'cost',
      'currency',
      'labels',
      'export_time',
      'credits',
    ])
      expect(sql).toContain(column);
  });

  it('refuses a table id that could not be a BigQuery identifier', async () => {
    const emu = new GceEmulator();
    for (const bad of ['p.d', 'p.d.t`; DROP', 'p.d.t x', 'p.d-x.t', '.d.t'])
      await expect(build(emu, { ...exportAccount, billingExport: bad })).rejects.toThrow();
    await expect(
      build(emu, { ...exportAccount, billingExportLocation: 'US; --' }),
    ).rejects.toThrow();
    // a domain-scoped project is a valid table project
    const scoped = await build(emu, { ...exportAccount, billingExport: `example.com:p.d.t_1` });
    expect(scoped.costs).toBeTypeOf('function');
  });

  it('pages through results', async () => {
    const emu = new GceEmulator();
    emu.bigquery.pageRows = 2;
    for (let hour = 0; hour < 5; hour++)
      emu.bigquery.rows.push(
        billingRow({
          usage_start_time: new Date(window.from + hour * 3_600_000).toISOString(),
          usage_end_time: new Date(window.from + (hour + 1) * 3_600_000).toISOString(),
        }),
      );
    const records = await costsOf(emu);
    expect(records.map((r) => r.usageStart)).toEqual(
      [0, 1, 2, 3, 4].map((hour) => window.from + hour * 3_600_000),
    );
    expect(new Set(records.map((r) => r.sourceRowId)).size).toBe(5);
    const gets = emu.requests.filter(
      (r) => r.url.hostname === 'bigquery.googleapis.com' && r.method === 'GET',
    );
    expect(gets.map((r) => r.url.searchParams.get('pageToken'))).toEqual(['2', '4']);
    expect(gets.every((r) => r.url.searchParams.get('location') === 'US')).toBe(true);
  });

  it('stable sourceRowId across re-export', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(billingRow({ cost: 1, export_time: '2026-10-01T06:00:00.000Z' }));
    const [first] = await costsOf(emu);
    emu.bigquery.rows = [billingRow({ cost: 1.5, export_time: '2026-10-03T06:00:00.000Z' })];
    const [again] = await costsOf(emu);
    expect(again!.sourceRowId).toBe(first!.sourceRowId);
    expect(again!.costMicros).toBe(1_500_000);
    // a different identity column is a different row
    emu.bigquery.rows = [
      billingRow({ cost_type: 'adjustment' }),
      billingRow({ resource: { name: 'vm-2' } }),
      billingRow({ sku: { id: 'OTHER', description: 'x' } }),
      billingRow({ billing_account_id: 'OTHER' }),
      billingRow({ usage_end_time: '2026-10-01T00:30:00.000Z' }),
    ];
    const others = await costsOf(emu);
    const ids = new Set([first!.sourceRowId, ...others.map((r) => r.sourceRowId)]);
    expect(ids.size).toBe(6);
    expect(others[0]!.costType).toBe('adjustment');
  });

  it('reads float-second timestamps as well as int64 micros', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(billingRow());
    const [a] = await costsOf(emu);
    // a server that ignores formatOptions answers float seconds ("1.7908128E9")
    const original = emu.bigquery.fetch.bind(emu.bigquery);
    emu.bigquery.fetch = (method, url, headers, body) =>
      original(method, url, headers, body && { ...body, formatOptions: undefined });
    const [b] = await costsOf(emu);
    expect(b!.usageStart).toBe(a!.usageStart);
    expect(b!.sourceRowId).toBe(a!.sourceRowId);
  });

  it('credits are summed negative', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(
      billingRow({
        cost: 1.25,
        credits: [
          { name: 'Sustained usage discount', amount: -0.2, type: 'SUSTAINED_USAGE_DISCOUNT' },
          { name: 'Free tier', amount: -0.050001, type: 'FREE_TIER' },
        ],
      }),
      billingRow({ resource: { name: 'vm-2' }, credits: [] }),
    );
    const [credited, plain] = await costsOf(emu);
    expect(credited!.costMicros).toBe(1_250_000);
    expect(credited!.creditsMicros).toBe(-250_001);
    expect(plain!.creditsMicros).toBe(0);
    expect(Object.is(plain!.creditsMicros, -0)).toBe(false);
  });

  it('long jobs time out as UNAVAILABLE', async () => {
    const emu = new GceEmulator();
    emu.bigquery.rows.push(billingRow());
    // a job that finishes within the budget is polled to completion
    emu.bigquery.pendingReads = 2;
    const done = await costsOf(emu, { costQueryBudgetMs: 5_000, costQueryPollMs: 1 });
    expect(done).toHaveLength(1);
    // one that never does is UNAVAILABLE (retryable), not a hang
    emu.bigquery.pendingReads = Number.POSITIVE_INFINITY;
    const failure = await costsOf(emu, { costQueryBudgetMs: 40, costQueryPollMs: 5 }).then(
      () => undefined,
      (error: unknown) => error as ComputeError,
    );
    expect(failure?.code).toBe('UNAVAILABLE');
    expect(failure?.details).toMatchObject({ provider: 'gcp', reason: 'jobTimeout' });
  });

  it('maps BigQuery failures like every Google API failure', async () => {
    const emu = new GceEmulator();
    emu.failNext = { status: 403, reason: 'rateLimitExceeded', headers: { 'retry-after': '7' } };
    const failure = await costsOf(emu).then(
      () => undefined,
      (error: unknown) => error as ComputeError,
    );
    expect(failure?.code).toBe('RATE_LIMITED');
    expect(failure?.details).toMatchObject({ retryAfterMs: 7000 });
  });
});
