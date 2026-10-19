import { afterEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  type ProviderCostRecord,
  type ProviderDefinition,
} from '@better-compute/core';
import { flushUsageWindows } from '@better-compute/iam';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { defineProvider, vps, type VpsOptions } from '@better-compute/vps';
import { fakeGceProvider, type FakeGce } from './support/vps-gce.js';

// Provider costs (platform compute billing, Phase 5): the vps.costs worker ingests and attributes
// provider cost rows (Task 15), passes them through to tenants (Task 16), reports margins and
// raises leaks (Task 17). The provider is the vps-gce fake with a cost ledger (`costs`).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const instanceLabel = 'better-compute-instance';
const tenantLabel = 'better-compute-tenant';

/** A provider account's billed cost rows, as its `costs` yields them. */
interface Ledger {
  rows: ProviderCostRecord[];
  /** Thrown by the next `costs` read. */
  failNext?: Error;
  /** Every window read, in order. */
  windows: { from: number; to: number }[];
}

/** fake-gce with a cost ledger: the same VMs and calls, plus `costs`. */
function costingGce(
  cloud: FakeGce,
  ledger: Ledger,
  id = 'fake-gce',
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  const inner = fakeGceProvider(cloud, id);
  return defineProvider({
    id: inner.id,
    version: inner.version,
    provides: inner.provides,
    config: inner.config,
    ...extra,
    create: async (config, context) => {
      const impl = await inner.create(config, context);
      return Object.assign(impl, {
        async *costs(window: { from: number; to: number }) {
          ledger.windows.push(window);
          const failure = ledger.failNext;
          if (failure) {
            delete ledger.failNext;
            throw failure;
          }
          for (const row of ledger.rows)
            if (row.usageStart >= window.from && row.usageStart < window.to)
              yield structuredClone(row);
        },
      });
    },
  });
}

/** Compute Engine's metered SKU families, as provider-gcp's `gcpBilling` says them. */
const skuText = (r: { sku: string; skuDescription?: string }) =>
  `${r.sku} ${r.skuDescription ?? ''}`;
const computeEngine = (r: { service: string }) => !r.service || r.service === 'Compute Engine';
const fakeBilling = {
  computeSku: (r: { service: string; sku: string; skuDescription?: string }) =>
    computeEngine(r) && /core|ram|gpu|instance/i.test(skuText(r)),
  meteredSku: (r: { service: string; sku: string; skuDescription?: string }) =>
    computeEngine(r) && /pd capacity|hyperdisk|local ssd|ip charge/i.test(skuText(r)),
};

let seq = 0;
/** A cost row: an hour of Compute Engine egress in USD by default. */
function costRow(overrides: Partial<ProviderCostRecord> = {}): ProviderCostRecord {
  seq++;
  return {
    sourceRowId: `row-${seq}`,
    service: 'Compute Engine',
    sku: '984A-1F5A-A3D8',
    skuDescription: 'Network Internet Egress from Americas to EMEA',
    region: 'us-central1',
    zone: 'us-central1-a',
    project: 'p',
    resourceName: 'vm-1',
    usageStart: 0,
    usageEnd: HOUR,
    quantity: 3,
    unit: 'gibibyte',
    costMicros: 360_000,
    creditsMicros: 0,
    currency: 'USD',
    labels: {},
    exportTime: 0,
    costType: 'regular',
    ...overrides,
  };
}

type Api = any;

interface CostWorld {
  fixture: ComputeFixture;
  api: Api;
  cloud: FakeGce;
  ledger: Ledger;
  byoLedger: Ledger;
  root: { token: string };
  acme: { token: string };
  rootTenant: string;
  acmeTenant: string;
  accountId: string;
  byoAccountId: string;
  plainAccountId: string;
  poolId: string;
  /** Runs vps.costs: the `all` pass, then the accounts it enqueued. */
  scan(): Promise<void>;
  events(prefix?: string): Promise<{ type: string; data: any; tenantId: string }[]>;
  costs(): Promise<CostView[]>;
  now(): number;
}

interface CostView {
  accountId: string;
  sourceRowId: string;
  costMicros: number;
  creditsMicros: number;
  currency: string;
  instanceId: string | null;
  tenantId: string | null;
  attribution: string;
  conditions: string[];
  passedThrough: boolean;
  passThroughKey: string | null;
  updatedAt: number;
}

async function costWorld(options: Pick<VpsOptions, 'costs' | 'billing'> = {}): Promise<CostWorld> {
  const cloud: FakeGce = { machines: new Map(), requests: [] };
  const byo: FakeGce = { machines: new Map(), requests: [] };
  const ledger: Ledger = { rows: [], windows: [] };
  const byoLedger: Ledger = { rows: [], windows: [] };
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [
          costingGce(cloud, ledger, 'fake-gce', { billing: fakeBilling }),
          costingGce(byo, byoLedger, 'fake-gce-byo', { billing: fakeBilling }),
          fakeGceProvider({ machines: new Map(), requests: [] }, 'fake-gce-plain'),
        ],
        ...options,
      }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-gce',
    name: 'gce-main',
    config: {},
  });
  const plain = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-gce-plain',
    name: 'gce-plain',
    config: {},
  });
  const byoAccount = await api.providerAccounts.create(acme, {
    tenantId: tenants.acme.id,
    provider: 'fake-gce-byo',
    name: 'acme-gcp',
    config: {},
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'gce-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'gce-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'a2.highgpu.1g',
    vcpu: 12,
    memoryGiB: 85,
    diskGiB: 100,
    gpus: 1,
    offerId: 'us-central1-a/a2-highgpu-1g',
  });
  return {
    fixture,
    api,
    cloud,
    ledger,
    byoLedger,
    root,
    acme,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    accountId: account.id,
    byoAccountId: byoAccount.id,
    plainAccountId: plain.id,
    poolId: pool.id,
    async scan() {
      for (let round = 0; round < 2; round++) await compute.jobs['vps.costs']!.tick();
    },
    async events(prefix = '') {
      const { rows } = await fixture.database.query<{
        topic: string;
        payload: { data: unknown; tenantId: string };
      }>(`SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`, [`${prefix}%`]);
      return rows.map((row) => ({
        type: row.topic,
        data: row.payload.data,
        tenantId: row.payload.tenantId,
      }));
    },
    async costs() {
      const { rows } = await fixture.database.query<any>(
        `SELECT account_id, source_row_id, cost_micros, credits_micros, currency, instance_id, tenant_id,
                attribution, conditions, passed_through_at, pass_through_key,
                (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms
           FROM provider_costs ORDER BY account_id, source_row_id`,
      );
      return rows.map((row) => ({
        accountId: row.account_id,
        sourceRowId: row.source_row_id,
        costMicros: Number(row.cost_micros),
        creditsMicros: Number(row.credits_micros),
        currency: row.currency,
        instanceId: row.instance_id,
        tenantId: row.tenant_id,
        attribution: row.attribution,
        conditions: row.conditions,
        passedThrough: row.passed_through_at !== null,
        passThroughKey: row.pass_through_key,
        updatedAt: Number(row.updated_ms),
      }));
    },
    now: () => fixture.clock.now(),
  };
}

async function createVm(world: CostWorld, key = 'vm-1') {
  return world.api.instances.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
  });
}

afterEach(closeFixtures);

describe('ingestion and attribution', () => {
  it('attributes by instance label, then tenant label, then account', async () => {
    const world = await costWorld();
    const vm = await createVm(world);
    const at = world.now() - 2 * DAY;
    const row = (id: string, labels: Record<string, string>) =>
      costRow({ sourceRowId: id, usageStart: at, usageEnd: at + HOUR, labels });
    world.ledger.rows.push(
      row('by-instance', { [instanceLabel]: vm.id, [tenantLabel]: 'someone-else' }),
      row('by-tenant', { [tenantLabel]: world.acmeTenant }),
      row('unknown-instance', { [instanceLabel]: 'ins_nobody' }),
      row('no-labels', {}),
    );
    world.byoLedger.rows.push(
      row('byo-plain', {}),
      // a tenant's own labels never move its cost to someone else
      row('byo-tenant-label', { [tenantLabel]: world.rootTenant }),
      row('byo-other-instance', { [instanceLabel]: vm.id }),
    );
    // outside the 3-day lookback: never read
    world.ledger.rows.push(costRow({ sourceRowId: 'too-old', usageStart: at - 2 * DAY }));
    await world.scan();

    const byId = new Map((await world.costs()).map((cost) => [cost.sourceRowId, cost]));
    expect(byId.get('by-instance')).toMatchObject({
      accountId: world.accountId,
      attribution: 'instance',
      instanceId: vm.id,
      tenantId: world.acmeTenant,
      costMicros: 360_000,
      currency: 'USD',
      conditions: [],
      passedThrough: false,
    });
    expect(byId.get('by-tenant')).toMatchObject({
      attribution: 'tenant-label',
      instanceId: null,
      tenantId: world.acmeTenant,
    });
    for (const id of ['unknown-instance', 'no-labels'])
      expect(byId.get(id)).toMatchObject({ attribution: 'unattributed', tenantId: null });
    for (const id of ['byo-plain', 'byo-tenant-label', 'byo-other-instance'])
      expect(byId.get(id)).toMatchObject({
        accountId: world.byoAccountId,
        attribution: 'account',
        tenantId: world.acmeTenant,
        instanceId: null,
      });
    expect(byId.has('too-old')).toBe(false);
    expect(world.ledger.windows[0]).toEqual({ from: world.now() - 3 * DAY, to: world.now() });

    const unattributed = await world.events('billing.unattributed');
    expect(unattributed.map((event) => event.data.sourceRowId).sort()).toEqual([
      'no-labels',
      'unknown-instance',
    ]);
    expect(unattributed[0]).toMatchObject({
      tenantId: world.rootTenant,
      data: { accountId: world.accountId, sku: '984A-1F5A-A3D8', costMicros: 360_000 },
    });
    const ingested = await world.events('billing.cost-ingested');
    expect(ingested.map((event) => event.data.accountId).sort()).toEqual(
      [world.accountId, world.byoAccountId].sort(),
    );
    expect(ingested.find((event) => event.data.accountId === world.accountId)!.data).toMatchObject({
      rows: 4,
      inserted: 4,
      corrected: 0,
      costMicros: 4 * 360_000,
      creditsMicros: 0,
      unattributedRows: 2,
      currencyMismatchRows: 0,
      currency: 'USD',
    });
    // only accounts whose client reads costs are scanned
    const { rows: scans } = await world.fixture.database.query<{ account_id: string }>(
      `SELECT account_id FROM provider_cost_scans ORDER BY account_id`,
    );
    expect(scans.map((scan) => scan.account_id).sort()).toEqual(
      [world.accountId, world.byoAccountId].sort(),
    );
  });

  it('re-exported rows are idempotent', async () => {
    const world = await costWorld();
    const at = world.now() - DAY;
    world.ledger.rows.push(
      costRow({ sourceRowId: 'a', usageStart: at, exportTime: at + HOUR }),
      costRow({ sourceRowId: 'b', usageStart: at, exportTime: at + HOUR }),
    );
    await world.scan();
    const first = await world.costs();
    await world.fixture.advance(6 * HOUR);
    // the same rows re-exported later (and one of them twice in the same read)
    world.ledger.rows = [
      costRow({ sourceRowId: 'a', usageStart: at, exportTime: at + 5 * HOUR }),
      costRow({ sourceRowId: 'b', usageStart: at, exportTime: at + 5 * HOUR }),
      costRow({ sourceRowId: 'b', usageStart: at, exportTime: at + 4 * HOUR }),
    ];
    await world.scan();
    expect(world.ledger.windows).toHaveLength(2);
    const again = await world.costs();
    expect(again).toEqual(first);
    expect(await world.events('billing.cost-corrected')).toEqual([]);
    expect(await world.events('billing.unattributed')).toHaveLength(2);
    const passes = (await world.events('billing.cost-ingested')).filter(
      (event) => event.data.accountId === world.accountId,
    );
    expect(passes).toHaveLength(2);
    expect(passes[1]!.data).toMatchObject({ rows: 2, inserted: 0, corrected: 0, unchanged: 2 });
  });

  it('a corrected row updates and publishes cost-corrected', async () => {
    const world = await costWorld();
    const at = world.now() - DAY;
    world.ledger.rows.push(
      costRow({ sourceRowId: 'c', usageStart: at, exportTime: at + HOUR, costMicros: 1_000_000 }),
    );
    await world.scan();
    await world.fixture.advance(6 * HOUR);
    world.ledger.rows = [
      costRow({
        sourceRowId: 'c',
        usageStart: at,
        exportTime: at + 9 * HOUR,
        costMicros: 1_250_000,
        creditsMicros: -50_000,
      }),
    ];
    await world.scan();
    const [stored] = await world.costs();
    expect(stored).toMatchObject({ costMicros: 1_250_000, creditsMicros: -50_000 });
    const corrected = await world.events('billing.cost-corrected');
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.data).toEqual({
      accountId: world.accountId,
      sourceRowId: 'c',
      previousMicros: 1_000_000,
      costMicros: 1_250_000,
      previousCreditsMicros: 0,
      creditsMicros: -50_000,
      currency: 'USD',
      passedThrough: false,
    });
    // an older export of the same row never wins back
    await world.fixture.advance(6 * HOUR);
    world.ledger.rows = [
      costRow({ sourceRowId: 'c', usageStart: at, exportTime: at + 2 * HOUR, costMicros: 1 }),
    ];
    await world.scan();
    expect((await world.costs())[0]).toMatchObject({ costMicros: 1_250_000 });
    expect(await world.events('billing.cost-corrected')).toHaveLength(1);
    // unattributed is published once per row, not per correction
    expect(await world.events('billing.unattributed')).toHaveLength(1);
  });

  it('rate limits defer the account', async () => {
    const world = await costWorld();
    const at = world.now() - DAY;
    world.ledger.rows.push(costRow({ sourceRowId: 'r', usageStart: at }));
    world.ledger.failNext = new ComputeError('RATE_LIMITED', 'slow down', undefined, {
      retryAfterMs: 120_000,
    });
    await world.scan();
    expect(await world.costs()).toEqual([]);
    const scanRow = async () =>
      (
        await world.fixture.database.query<{ next_ms: number; last_error: string | null }>(
          `SELECT (extract(epoch FROM next_at) * 1000)::float8 AS next_ms, last_error
             FROM provider_cost_scans WHERE account_id = $1`,
          [world.accountId],
        )
      ).rows[0]!;
    const deferred = await scanRow();
    expect(Number(deferred.next_ms)).toBe(world.now() + 120_000);
    expect(deferred.last_error).toMatch(/^RATE_LIMITED: slow down/);
    // the other account went on
    expect(world.byoLedger.windows).toHaveLength(1);
    // not before the back-off ...
    await world.fixture.advance(60_000);
    await world.scan();
    expect(world.ledger.windows).toHaveLength(1);
    // ... then the account is read again
    await world.fixture.advance(61_000);
    await world.scan();
    expect(world.ledger.windows).toHaveLength(2);
    expect((await world.costs()).map((cost) => cost.sourceRowId)).toEqual(['r']);
    expect((await scanRow()).last_error).toBeNull();
  });

  it('currency mismatch is stored but flagged', async () => {
    const world = await costWorld({ costs: { currency: 'usd' } });
    const at = world.now() - DAY;
    world.ledger.rows.push(
      costRow({ sourceRowId: 'eur', usageStart: at, currency: 'EUR', costMicros: 900_000 }),
      costRow({ sourceRowId: 'usd', usageStart: at, currency: 'USD', costMicros: 100_000 }),
    );
    await world.scan();
    const byId = new Map((await world.costs()).map((cost) => [cost.sourceRowId, cost]));
    expect(byId.get('eur')).toMatchObject({
      currency: 'EUR',
      costMicros: 900_000,
      conditions: ['CurrencyMismatch'],
    });
    expect(byId.get('usd')!.conditions).toEqual([]);
    const [pass] = (await world.events('billing.cost-ingested')).filter(
      (event) => event.data.accountId === world.accountId,
    );
    expect(pass!.data).toMatchObject({
      currency: 'USD',
      rows: 2,
      costMicros: 100_000,
      currencyMismatchRows: 1,
    });
  });

  it('refuses bad cost options', async () => {
    expect(() => vps({ costs: { lookbackDays: 0 } })).toThrow(/lookbackDays/);
    expect(() => vps({ costs: { lookbackDays: 40 } })).toThrow(/lookbackDays/);
    expect(() => vps({ costs: { currency: 'dollars' } })).toThrow(/currency/);
  });
});

describe('pass-through', () => {
  const egressMeter = 'network.egress.gib';
  const egressRule = { skuPattern: 'egress', meter: egressMeter, multiplier: 1.2 };

  /** The IAM root tenant's meters, as `listMeters` answers. */
  function meters(world: CostWorld) {
    Object.assign(world.fixture.iam, {
      listMeters: async () => [
        { key: egressMeter, pricing: 'reported' },
        { key: 'network.archived.gib', pricing: 'reported', archived: true },
        { key: 'vm.vcpu.hours', pricing: 'rate-card' },
      ],
    });
  }

  const setRules = (world: CostWorld, passThrough: unknown[], accountId = world.accountId) =>
    world.api.providerAccounts.update(world.root, {
      tenantId: world.rootTenant,
      accountId,
      config: {},
      billing: { passThrough },
    });

  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error?.code ?? String(error),
    );

  async function costWindows(world: CostWorld) {
    const { rows } = await world.fixture.database.query<any>(
      `SELECT idempotency_key, source_id, tenant_id, identity_id, meter, quantity, cost_micros, tags,
              (extract(epoch FROM window_start) * 1000)::float8 AS start_ms
         FROM usage_windows WHERE source_kind = 'cost' ORDER BY idempotency_key`,
    );
    return rows.map((row) => ({
      key: row.idempotency_key,
      sourceId: row.source_id,
      tenantId: row.tenant_id,
      identityId: row.identity_id,
      meter: row.meter,
      quantity: Number(row.quantity),
      costMicros: Number(row.cost_micros),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      start: Number(row.start_ms),
    }));
  }

  /** An hour of egress (and of N2 cores) of `instanceId`, a day ago. */
  function instanceRows(world: CostWorld, instanceId: string) {
    const at = Math.floor((world.now() - DAY) / HOUR) * HOUR;
    return {
      at,
      egress: costRow({
        sourceRowId: 'egress-1',
        usageStart: at,
        usageEnd: at + HOUR,
        labels: { [instanceLabel]: instanceId },
        costMicros: 360_000,
        creditsMicros: -10_000,
        exportTime: at + 2 * HOUR,
      }),
      cores: costRow({
        sourceRowId: 'cores-1',
        sku: 'BB77-5FDA-1D73',
        skuDescription: 'N2 Instance Core running in Americas',
        usageStart: at,
        usageEnd: at + HOUR,
        quantity: 12,
        unit: 'hour',
        labels: { [instanceLabel]: instanceId },
        costMicros: 380_000,
      }),
    };
  }

  it('egress rows pass through at cost × 1.2 on the egress meter', async () => {
    const world = await costWorld();
    meters(world);
    const vm = await createVm(world);
    const updated = await setRules(world, [egressRule]);
    expect(updated.billing).toEqual({ passThrough: [egressRule] });
    expect(
      (
        await world.api.providerAccounts.get(world.root, {
          tenantId: world.rootTenant,
          accountId: world.accountId,
        })
      ).billing,
    ).toEqual({ passThrough: [egressRule] });
    const { at, egress, cores } = instanceRows(world, vm.id);
    world.ledger.rows.push(egress, cores);
    await world.scan();

    const key = `costx:${world.accountId}:egress-1`;
    expect(await costWindows(world)).toEqual([
      {
        key,
        sourceId: `${world.accountId}:egress-1`,
        tenantId: world.acmeTenant,
        identityId: null,
        meter: egressMeter,
        quantity: 3,
        // (360 000 − 10 000) × 1.2
        costMicros: 420_000,
        tags: { provider: 'fake-gce', region: 'us-central1', source: 'cost' },
        start: at,
      },
    ]);
    const byId = new Map((await world.costs()).map((cost) => [cost.sourceRowId, cost]));
    expect(byId.get('egress-1')).toMatchObject({ passedThrough: true, passThroughKey: key });
    expect(byId.get('cores-1')).toMatchObject({ passedThrough: false, passThroughKey: null });
    const [pass] = (await world.events('billing.cost-ingested')).filter(
      (event) => event.data.accountId === world.accountId,
    );
    expect(pass!.data).toMatchObject({ passedThroughRows: 1, passedThroughMicros: 420_000 });

    // the normal iam.usage flush records it, with its reported cost in currency units (ruling M3)
    const sent: any[] = [];
    await flushUsageWindows(world.fixture.database, {
      recordUsage: async (events) => {
        sent.push(...events);
        return events.map((event) => ({
          idempotencyKey: event.idempotencyKey,
          status: 'recorded',
        }));
      },
    });
    expect(sent.filter((event) => event.idempotencyKey === key)).toEqual([
      {
        tenantId: world.acmeTenant,
        meter: egressMeter,
        quantity: 3,
        occurredAt: at,
        tags: { provider: 'fake-gce', region: 'us-central1', source: 'cost' },
        idempotencyKey: key,
        cost: 0.42,
      },
    ]);
  });

  it('pass-through is idempotent across rescans', async () => {
    const world = await costWorld();
    meters(world);
    const vm = await createVm(world);
    const { egress } = instanceRows(world, vm.id);
    world.ledger.rows.push(egress);
    // ingested before any rule: nothing passes
    await world.scan();
    expect(await costWindows(world)).toEqual([]);
    // a rule set later passes the rows still in the lookback, once
    await setRules(world, [egressRule]);
    for (let pass = 0; pass < 3; pass++) {
      await world.fixture.advance(6 * HOUR);
      await world.scan();
    }
    const windows = await costWindows(world);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.costMicros).toBe(420_000);
    const passes = (await world.events('billing.cost-ingested')).filter(
      (event) => event.data.accountId === world.accountId,
    );
    expect(passes.map((event) => event.data.passedThroughRows)).toEqual([0, 1, 0, 0]);
    // a rule change does not re-emit what was passed through
    await setRules(world, [{ ...egressRule, multiplier: 2 }]);
    await world.fixture.advance(6 * HOUR);
    await world.scan();
    expect(await costWindows(world)).toEqual(windows);
  });

  it('compute SKUs cannot be pass-through targets', async () => {
    const world = await costWorld();
    meters(world);
    for (const skuPattern of [
      'Core',
      'n2 instance',
      'GPU',
      'Ram running',
      'Storage PD Capacity',
      'Hyperdisk',
      'External IP Charge',
    ])
      expect(
        await codeOf(setRules(world, [{ skuPattern, meter: egressMeter, multiplier: 1 }])),
      ).toBe('INVALID_CONFIG');
    // also when the account is created with them
    expect(
      await codeOf(
        world.api.providerAccounts.create(world.root, {
          tenantId: world.rootTenant,
          provider: 'fake-gce',
          name: 'gce-two',
          config: {},
          billing: { passThrough: [{ skuPattern: 'core', meter: egressMeter, multiplier: 1 }] },
        }),
      ),
    ).toBe('INVALID_CONFIG');
    // a provider that does not say which SKUs compute meters cannot pass anything through
    expect(await codeOf(setRules(world, [egressRule], world.plainAccountId))).toBe(
      'INVALID_CONFIG',
    );
    // the meter must be a reported meter that exists; the multiplier 1 to 10
    for (const meter of ['vm.vcpu.hours', 'network.unknown.gib', 'network.archived.gib'])
      expect(await codeOf(setRules(world, [{ ...egressRule, meter }]))).toBe('INVALID_INPUT');
    for (const multiplier of [0.5, 11, Number.NaN])
      expect(await codeOf(setRules(world, [{ ...egressRule, multiplier }]))).toBe('INVALID_INPUT');
    expect(await codeOf(setRules(world, [{ ...egressRule, skuPattern: 'e' }]))).toBe(
      'INVALID_INPUT',
    );
    expect((await world.costs()).length).toBe(0);

    // a broad pattern is allowed, but a compute row it happens to match is never passed through
    await setRules(world, [{ skuPattern: 'Americas', meter: egressMeter, multiplier: 1 }]);
    const vm = await createVm(world);
    const { egress, cores } = instanceRows(world, vm.id);
    world.ledger.rows.push(egress, cores);
    await world.scan();
    expect((await costWindows(world)).map((window) => window.key)).toEqual([
      `costx:${world.accountId}:egress-1`,
    ]);

    // without listMeters the rules cannot be checked
    delete (world.fixture.iam as { listMeters?: unknown }).listMeters;
    expect(await codeOf(setRules(world, [egressRule]))).toBe('UNSUPPORTED');
  });

  it('BYO and unattributed rows never pass through', async () => {
    const world = await costWorld();
    meters(world);
    const vm = await createVm(world);
    // a tenant's own account cannot hold rules
    expect(
      await codeOf(
        world.api.providerAccounts.update(world.acme, {
          tenantId: world.acmeTenant,
          accountId: world.byoAccountId,
          config: {},
          billing: { passThrough: [egressRule] },
        }),
      ),
    ).toBe('INVALID_INPUT');
    // ... and its rows never pass, even with rules written behind the API's back
    await world.fixture.database.query(`UPDATE provider_accounts SET billing = $2 WHERE id = $1`, [
      world.byoAccountId,
      JSON.stringify({ passThrough: [egressRule] }),
    ]);
    await setRules(world, [egressRule]);
    const at = Math.floor((world.now() - DAY) / HOUR) * HOUR;
    const egress = (id: string, extra: Partial<ProviderCostRecord> = {}) =>
      costRow({ sourceRowId: id, usageStart: at, usageEnd: at + HOUR, ...extra });
    world.byoLedger.rows.push(egress('byo-egress'));
    world.ledger.rows.push(
      egress('unattributed'),
      egress('to-root', { labels: { [tenantLabel]: world.rootTenant } }),
      egress('eur', { labels: { [instanceLabel]: vm.id }, currency: 'EUR' }),
      egress('adjustment', { labels: { [instanceLabel]: vm.id }, costType: 'adjustment' }),
      egress('credited', {
        labels: { [instanceLabel]: vm.id },
        costMicros: 100_000,
        creditsMicros: -100_000,
      }),
      egress('negative', { labels: { [instanceLabel]: vm.id }, costMicros: -5_000 }),
      egress('by-tenant-label', { labels: { [tenantLabel]: world.acmeTenant } }),
    );
    await world.scan();
    expect((await costWindows(world)).map((window) => window.key)).toEqual([
      `costx:${world.accountId}:by-tenant-label`,
    ]);
    const passed = (await world.costs()).filter((cost) => cost.passedThrough);
    expect(passed.map((cost) => cost.sourceRowId)).toEqual(['by-tenant-label']);
  });

  it('a corrected row after pass-through emits cost-corrected only', async () => {
    const world = await costWorld();
    meters(world);
    const vm = await createVm(world);
    await setRules(world, [egressRule]);
    const { egress } = instanceRows(world, vm.id);
    world.ledger.rows.push(egress);
    await world.scan();
    const before = await costWindows(world);
    expect(before).toHaveLength(1);
    await world.fixture.advance(6 * HOUR);
    world.ledger.rows = [
      { ...egress, costMicros: 500_000, exportTime: egress.exportTime + 10 * HOUR },
    ];
    await world.scan();
    expect(await costWindows(world)).toEqual(before);
    const [stored] = await world.costs();
    expect(stored).toMatchObject({
      costMicros: 500_000,
      passedThrough: true,
      passThroughKey: `costx:${world.accountId}:egress-1`,
    });
    const corrected = await world.events('billing.cost-corrected');
    expect(corrected.map((event) => event.data)).toEqual([
      expect.objectContaining({
        sourceRowId: 'egress-1',
        previousMicros: 360_000,
        costMicros: 500_000,
        passedThrough: true,
      }),
    ]);
  });
});

describe('provider billing hooks', () => {
  it('defineProvider takes billing.computeSku and billing.meteredSku, and nothing else there', () => {
    const base = fakeGceProvider({ machines: new Map(), requests: [] });
    const define = (billing: unknown) =>
      defineProvider({
        id: 'hooks',
        version: '1.0.0',
        provides: ['vps'],
        config: base.config,
        create: base.create,
        billing: billing as never,
      });
    expect(define({ computeSku: () => false, meteredSku: () => false }).billing).toBeDefined();
    expect(() => define({ computeSku: 'core' })).toThrow(/billing.computeSku/);
    expect(() => define({ otherSku: () => true })).toThrow(/billing.otherSku/);
    expect(() => define([])).toThrow(/billing/);
  });
});
