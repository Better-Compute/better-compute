import { afterEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  type ProviderCostRecord,
  type ProviderDefinition,
} from '@better-compute/core';
import { flushUsageWindows } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
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
  /** Runs inside every read before it yields (e.g. moving the clock: a slow export). */
  onRead?: () => Promise<void>;
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
          await ledger.onRead?.();
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
    computeEngine(r) && /pd capacity|hyperdisk|local storage|local ssd|ip charge/i.test(skuText(r)),
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
  /** A third tenant (fixture `other`). */
  other: { token: string };
  otherTenant: string;
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
  iam.allow({ token: tenants.other.token });
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
    other: { token: tenants.other.token },
    otherTenant: tenants.other.id,
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
    const world = await costWorld({ billing: { currency: 'usd' } });
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
    expect(() => vps({ billing: { currency: 'dollars' } })).toThrow(/currency/);
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
        tags: { provider: 'fake-gce', region: 'us-central1', source: 'cost', pool: world.poolId },
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
        tags: { provider: 'fake-gce', region: 'us-central1', source: 'cost', pool: world.poolId },
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

describe('margins', () => {
  /** A cost row written as the worker would have stored it. */
  async function storeCost(
    world: CostWorld,
    row: {
      id: string;
      start: number;
      cost: number;
      credits?: number;
      tenantId?: string | null;
      instanceId?: string | null;
      attribution?: string;
      currency?: string;
      conditions?: string[];
      passThroughMeter?: string;
      accountId?: string;
    },
  ) {
    await world.fixture.database.query(
      `INSERT INTO provider_costs (account_id, source_row_id, record, usage_start, usage_end, cost_micros,
                                   credits_micros, currency, instance_id, tenant_id, attribution, conditions,
                                   pass_through_meter)
       VALUES ($1, $2, '{}'::jsonb, to_timestamp($3::float8 / 1000), to_timestamp($3::float8 / 1000 + 3600),
               $4, $5, $6, $7, $8, $9, $10::text[], $11)`,
      [
        row.accountId ?? world.accountId,
        row.id,
        row.start,
        row.cost,
        row.credits ?? 0,
        row.currency ?? 'USD',
        row.instanceId ?? null,
        row.tenantId === undefined ? null : row.tenantId,
        row.attribution ?? (row.tenantId ? 'tenant-label' : 'unattributed'),
        row.conditions ?? [],
        row.passThroughMeter ?? null,
      ],
    );
  }

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error?.code ?? String(error),
    );

  let t: EmbeddedTestIam | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('margins per tenant equal revenue minus cost', async () => {
    // A real better-iam on its own clock: prices, recorded usage, and its spend report.
    t = await createEmbeddedTestIam({ inbox: 'memory', mode: 'embedded' });
    const port = t.port;
    const vcpu = 'vm.vcpu.hours';
    await port.ensureMeters!([
      { key: vcpu, name: 'vCPU hours', unit: 'vcpu-hour', pricing: 'rate-card' },
    ]);
    const period = new Date(t.now()).toISOString().slice(0, 7);
    await port.setPrice!({
      meter: vcpu,
      effectiveFrom: period,
      spec: { model: 'per-unit', unitAmountMicros: 1_000_000 },
    });
    const usage = (tenantId: string, quantity: number, key: string) => ({
      tenantId,
      meter: vcpu,
      quantity,
      occurredAt: t!.now(),
      tags: {},
      idempotencyKey: `cmp:test:${key}`,
    });
    await port.recordUsage([usage(t.acme.tenantId, 10, 'a'), usage(t.other.tenantId, 2, 'o')]);

    const world = await costWorld();
    const root = t.root.tenantId;
    const spends: unknown[] = [];
    Object.assign(world.fixture.iam, {
      spend: (query: any) => {
        spends.push(query);
        // compute's fixture root stands for better-iam's root
        return port.spend!({ ...query, tenantId: root });
      },
    });
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5)) - 1;
    const periodStart = Date.UTC(year, month, 1);
    const periodEnd = Date.UTC(year, month + 1, 1);
    const acme = t.acme.tenantId;
    // inside the billing period, though outside the query's range: counted (ruling F1-3)
    await storeCost(world, {
      id: 'a1',
      start: periodStart + HOUR,
      cost: 4_000_000,
      credits: -500_000,
      tenantId: acme,
    });
    await storeCost(world, {
      id: 'a2',
      start: periodStart + 2 * DAY + HOUR,
      cost: 1_000_000,
      tenantId: acme,
    });
    await storeCost(world, {
      id: 'c1',
      start: periodStart + 3 * DAY,
      cost: 300_000,
      tenantId: 'ten_costonly',
    });
    await storeCost(world, { id: 'u1', start: periodStart + 3 * DAY, cost: 700_000 });
    // another currency, and other periods: never counted
    await storeCost(world, {
      id: 'eur',
      start: periodStart + 3 * DAY,
      cost: 9_000_000,
      tenantId: acme,
      currency: 'EUR',
      conditions: ['CurrencyMismatch'],
    });
    await storeCost(world, {
      id: 'next',
      start: periodEnd + HOUR,
      cost: 5_000_000,
      tenantId: acme,
    });
    await storeCost(world, {
      id: 'prev',
      start: periodStart - HOUR,
      cost: 5_000_000,
      tenantId: acme,
    });

    const from = periodStart + 2 * DAY;
    const result = await world.api.billing.margins(world.root, {
      from,
      to: from + DAY,
      groupBy: 'tenant',
    });
    expect(spends).toEqual([
      { tenantId: world.rootTenant, from, to: from + DAY, groupBy: 'tenant' },
    ]);
    expect(result).toEqual({
      rows: [
        {
          key: acme,
          revenueMicros: 10_000_000,
          costMicros: 4_500_000,
          marginMicros: 5_500_000,
          marginPct: 55,
        },
        {
          key: t.other.tenantId,
          revenueMicros: 2_000_000,
          costMicros: 0,
          marginMicros: 2_000_000,
          marginPct: 100,
        },
        {
          key: 'ten_costonly',
          revenueMicros: 0,
          costMicros: 300_000,
          marginMicros: -300_000,
          marginPct: null,
        },
      ].sort((a, b) => a.key.localeCompare(b.key)),
      unattributedCostMicros: 700_000,
      currency: 'USD',
      from: periodStart,
      to: periodEnd,
    });
  }, 60_000);

  it('unattributed cost is reported separately', async () => {
    const world = await costWorld({ billing: { currency: 'usd' } });
    const vm = await createVm(world);
    const at = Date.UTC(2025, 11, 30);
    await storeCost(world, {
      id: 'inst',
      start: at,
      cost: 1_000_000,
      tenantId: world.acmeTenant,
      instanceId: vm.id,
      attribution: 'instance',
      passThroughMeter: 'network.egress.gib',
    });
    await storeCost(world, { id: 'label', start: at, cost: 200_000, tenantId: world.acmeTenant });
    await storeCost(world, {
      id: 'byo',
      start: at,
      cost: 50_000,
      tenantId: world.acmeTenant,
      attribution: 'account',
      accountId: world.byoAccountId,
    });
    await storeCost(world, { id: 'none-1', start: at, cost: 300_000, credits: -100_000 });
    await storeCost(world, { id: 'none-2', start: at + HOUR, cost: 400_000 });
    const margins = (groupBy: string) =>
      world.api.billing.margins(world.root, { from: at, to: at + DAY, groupBy });

    // without IamPort.spend: no revenue, and the query's own range
    const byTenant = await margins('tenant');
    expect(byTenant).toEqual({
      rows: [
        {
          key: world.acmeTenant,
          revenueMicros: null,
          costMicros: 1_200_000,
          marginMicros: null,
          marginPct: null,
        },
      ],
      unattributedCostMicros: 600_000,
      currency: 'USD',
      from: at,
      to: at + DAY,
    });
    const keys = async (groupBy: string) => {
      const result = await margins(groupBy);
      expect(result.unattributedCostMicros).toBe(600_000);
      return Object.fromEntries(result.rows.map((row: any) => [row.key, row.costMicros]));
    };
    expect(await keys('account')).toEqual({
      // a tenant's own account is not platform cost (F17-1)
      [world.accountId]: 1_200_000,
    });
    expect(await keys('pool')).toEqual({ [world.poolId]: 1_000_000, '(none)': 200_000 });
    expect(await keys('meter')).toEqual({ 'network.egress.gib': 1_000_000, '(none)': 200_000 });

    // input is checked
    for (const input of [
      { from: at, to: at, groupBy: 'tenant' },
      { from: at, to: at + 500 * DAY, groupBy: 'tenant' },
      { from: at, to: at + DAY, groupBy: 'region' },
      { from: at, to: at + DAY },
      { from: 'yesterday', to: at, groupBy: 'tenant' },
    ])
      expect(await outcome(world.api.billing.margins(world.root, input))).toBe('INVALID_INPUT');
  });

  it('a tenant cannot read margins', async () => {
    const world = await costWorld();
    const at = Date.UTC(2025, 11, 30);
    expect(
      await outcome(
        world.api.billing.margins(world.acme, { from: at, to: at + DAY, groupBy: 'tenant' }),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await outcome(
        world.api.billing.margins(world.root, { from: at, to: at + DAY, groupBy: 'tenant' }),
      ),
    ).toBe('allowed');
  });
});

describe('leak detection', () => {
  /** A running interval of the instance over `[start, end)`. */
  async function running(world: CostWorld, instanceId: string, start: number, end: number) {
    await world.fixture.database.query(
      `INSERT INTO instance_usage_intervals (id, instance_id, tenant_id, pool_id, provider, phase, mode, shape,
                                             started_at, ended_at, metered_until)
       VALUES ($1, $2, $3, $4, 'fake-gce', 'running', 'metered', '{}'::jsonb, to_timestamp($5::float8 / 1000),
               to_timestamp($6::float8 / 1000), to_timestamp($6::float8 / 1000))`,
      [`iui_${start}`, instanceId, world.acmeTenant, world.poolId, start, end],
    );
  }

  /** `hours` hours of N2 cores and RAM of the instance from `start`, plus an hour of egress. */
  function computeHours(world: CostWorld, instanceId: string, start: number, hours: number) {
    for (let hour = 0; hour < hours; hour++)
      for (const [kind, description] of [
        ['core', 'N2 Instance Core running in Americas'],
        ['ram', 'N2 Instance Ram running in Americas'],
      ])
        world.ledger.rows.push(
          costRow({
            sourceRowId: `${kind}-${start + hour * HOUR}`,
            skuDescription: description,
            usageStart: start + hour * HOUR,
            usageEnd: start + (hour + 1) * HOUR,
            quantity: kind === 'core' ? 12 : 85,
            labels: { [instanceLabel]: instanceId },
          }),
        );
    world.ledger.rows.push(
      costRow({
        sourceRowId: `egress-${start}`,
        usageStart: start + hours * HOUR,
        usageEnd: start + (hours + 1) * HOUR,
        labels: { [instanceLabel]: instanceId },
      }),
    );
  }

  async function freshVm(world: CostWorld) {
    const vm = await createVm(world);
    await world.fixture.database.query(
      `DELETE FROM instance_usage_intervals WHERE instance_id = $1`,
      [vm.id],
    );
    return vm;
  }

  it('a VM running in the provider with no interval raises billing.leak', async () => {
    const world = await costWorld();
    const vm = await freshVm(world);
    const day = Math.floor((world.now() - 2 * DAY) / DAY) * DAY;
    computeHours(world, vm.id, day + 2 * HOUR, 5);
    await world.scan();
    const leaks = await world.events('billing.leak');
    expect(leaks).toEqual([
      {
        type: 'billing.leak',
        tenantId: world.rootTenant,
        data: {
          accountId: world.accountId,
          instanceId: vm.id,
          tenantId: world.acmeTenant,
          day: new Date(day).toISOString().slice(0, 10),
          providerHours: 5,
          meteredHours: 0,
        },
      },
    ]);
    const [pass] = (await world.events('billing.cost-ingested')).filter(
      (event) => event.data.accountId === world.accountId,
    );
    expect(pass!.data.leaks).toBe(1);
    // at most once per instance-day, whatever later passes see
    for (let again = 0; again < 2; again++) {
      await world.fixture.advance(6 * HOUR);
      await world.scan();
    }
    expect(await world.events('billing.leak')).toHaveLength(1);
  });

  it('within tolerance raises nothing', async () => {
    const world = await costWorld();
    const vm = await freshVm(world);
    const day1 = Math.floor((world.now() - 2 * DAY) / DAY) * DAY;
    const day2 = day1 + DAY;
    // day 1: 5 billed hours, 4 metered (a start or stop inside an hour): within the default 1 hour
    computeHours(world, vm.id, day1 + 2 * HOUR, 5);
    await running(world, vm.id, day1 + 2 * HOUR + 30 * 60_000, day1 + 6 * HOUR);
    // day 2: 5 billed, 3 metered: over it
    computeHours(world, vm.id, day2 + 2 * HOUR, 5);
    await running(world, vm.id, day2 + 2 * HOUR, day2 + 5 * HOUR);
    await world.scan();
    expect((await world.events('billing.leak')).map((event) => event.data)).toEqual([
      expect.objectContaining({
        instanceId: vm.id,
        day: new Date(day2).toISOString().slice(0, 10),
        providerHours: 5,
        meteredHours: 3,
      }),
    ]);
  });

  it('a zero tolerance raises a one-hour gap', async () => {
    const world = await costWorld({ costs: { leakToleranceHours: 0 } });
    const vm = await freshVm(world);
    const day = Math.floor((world.now() - 2 * DAY) / DAY) * DAY;
    computeHours(world, vm.id, day + 2 * HOUR, 2);
    await running(world, vm.id, day + 2 * HOUR, day + 3 * HOUR);
    await world.scan();
    expect((await world.events('billing.leak')).map((event) => event.data.meteredHours)).toEqual([
      1,
    ]);
    expect(() => vps({ costs: { leakToleranceHours: -1 } })).toThrow(/leakToleranceHours/);
  });
});

describe('ingestion fix round 1 (F15-1, F15-2)', () => {
  /** Acme's own pool on its own account, offered to `other`, with a flavor. */
  async function byoPool(world: CostWorld) {
    const site = await world.api.sites.create(world.acme, {
      tenantId: world.acmeTenant,
      kind: 'custom',
      region: 'us-central1',
      idempotencyKey: 'acme-site',
    });
    const pool = await world.api.pools.create(world.acme, {
      tenantId: world.acmeTenant,
      siteId: site.id,
      class: 'provider',
      providerAccountId: world.byoAccountId,
      ownerQuota: { vcpu: 100, memoryGiB: 1000, diskGiB: 10_000, gpu: 8 },
      idempotencyKey: 'acme-pool',
    });
    await world.api.pools.offer(world.acme, {
      tenantId: world.acmeTenant,
      poolId: pool.id,
      toTenantId: world.otherTenant,
      quota: { vcpu: 100, memoryGiB: 1000, diskGiB: 1000, gpu: 8 },
    });
    await world.api.flavors.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: pool.id,
      name: 'a2.byo',
      vcpu: 12,
      memoryGiB: 85,
      diskGiB: 100,
      gpus: 1,
      offerId: 'us-central1-a/a2-highgpu-1g',
    });
    return pool;
  }

  it("a BYO account's rows are its tenant's, whoever runs on its pool", async () => {
    const world = await costWorld();
    const pool = await byoPool(world);
    const create = (who: { token: string }, tenantId: string, key: string) =>
      world.api.instances.create(who, {
        tenantId,
        poolId: pool.id,
        flavor: 'a2.byo',
        imageId: 'debian-12',
        idempotencyKey: key,
      });
    const theirs = await create(world.other, world.otherTenant, 'other-vm');
    const own = await create(world.acme, world.acmeTenant, 'acme-vm');
    const at = world.now() - DAY;
    world.byoLedger.rows.push(
      costRow({ sourceRowId: 'theirs', usageStart: at, labels: { [instanceLabel]: theirs.id } }),
      costRow({ sourceRowId: 'own', usageStart: at, labels: { [instanceLabel]: own.id } }),
    );
    await world.scan();
    const byId = new Map((await world.costs()).map((cost) => [cost.sourceRowId, cost]));
    expect(byId.get('theirs')).toMatchObject({
      accountId: world.byoAccountId,
      attribution: 'account',
      tenantId: world.acmeTenant,
      instanceId: null,
    });
    expect(byId.get('own')).toMatchObject({
      attribution: 'account',
      tenantId: world.acmeTenant,
      instanceId: own.id,
    });
  });

  it('a platform tenant label naming a tenant compute does not know is unattributed', async () => {
    const world = await costWorld();
    const at = world.now() - DAY;
    world.ledger.rows.push(
      costRow({
        sourceRowId: 'known',
        usageStart: at,
        labels: { [tenantLabel]: world.acmeTenant },
      }),
      costRow({ sourceRowId: 'unknown', usageStart: at, labels: { [tenantLabel]: 'ten_nobody' } }),
    );
    await world.scan();
    const byId = new Map((await world.costs()).map((cost) => [cost.sourceRowId, cost]));
    expect(byId.get('known')).toMatchObject({
      attribution: 'tenant-label',
      tenantId: world.acmeTenant,
    });
    expect(byId.get('unknown')).toMatchObject({ attribution: 'unattributed', tenantId: null });
  });

  it('a pass out of time stops between batches and continues in another run', async () => {
    const world = await costWorld({ costs: { passBudgetMs: 5_000 } });
    const at = world.now() - DAY;
    // The read takes 6 s of the run's clock: the 5 s budget is gone before the first batch is written.
    world.ledger.onRead = async () => {
      await world.fixture.advance(6_000);
      delete world.ledger.onRead;
    };
    for (let index = 0; index < 501; index++)
      world.ledger.rows.push(
        costRow({ sourceRowId: `row-${String(index).padStart(4, '0')}`, usageStart: at }),
      );
    await world.scan();
    const ours = async () =>
      (await world.costs()).filter((cost) => cost.accountId === world.accountId).length;
    const ingested = async () =>
      (await world.events('billing.cost-ingested')).filter(
        (event) => event.data.accountId === world.accountId,
      );
    expect(await ours()).toBe(500);
    expect(await ingested()).toEqual([]);
    const { rows: queued } = await world.fixture.database.query<{ key: string }>(
      `SELECT key FROM work_queue WHERE kind = 'vps.costs' AND key = $1`,
      [world.accountId],
    );
    expect(queued).toHaveLength(1);
    // the next run finds the first batch unchanged and finishes the pass
    await world.fixture.compute.jobs['vps.costs']!.tick();
    expect(await ours()).toBe(501);
    const [pass] = await ingested();
    expect(pass!.data).toMatchObject({ rows: 501, inserted: 1, unchanged: 500 });
    for (const passBudgetMs of [0, 4_999, 60_000, Number.NaN])
      expect(() => vps({ costs: { passBudgetMs } })).toThrow(/passBudgetMs/);
    expect(() => vps({ costs: { passBudgetMs: 5_000 } })).not.toThrow();
  });

  it('transient failures without a hint back off 5 minutes; others wait a period', async () => {
    const world = await costWorld();
    const nextIn = async () => {
      const { rows } = await world.fixture.database.query<{ next_ms: number }>(
        `SELECT (extract(epoch FROM next_at) * 1000)::float8 AS next_ms
           FROM provider_cost_scans WHERE account_id = $1`,
        [world.accountId],
      );
      return Number(rows[0]!.next_ms) - world.now();
    };
    world.ledger.failNext = new ComputeError('UNAVAILABLE', 'BigQuery is down');
    await world.scan();
    expect(await nextIn()).toBe(5 * 60_000);
    await world.fixture.advance(5 * 60_000);
    world.ledger.failNext = new ComputeError('RATE_LIMITED', 'slow down');
    await world.scan();
    expect(await nextIn()).toBe(5 * 60_000);
    await world.fixture.advance(5 * 60_000);
    world.ledger.failNext = new ComputeError('ACCESS_DENIED', 'no dataViewer');
    await world.scan();
    expect(await nextIn()).toBe(6 * HOUR);
  });
});

describe('pass-through fix round 1 (F16-1, F16-2)', () => {
  const egressMeter = 'network.egress.gib';
  function meters(world: CostWorld) {
    Object.assign(world.fixture.iam, {
      listMeters: async () => [{ key: egressMeter, pricing: 'reported' }],
    });
  }
  const setRules = (world: CostWorld, passThrough: unknown[]) =>
    world.api.providerAccounts.update(world.root, {
      tenantId: world.rootTenant,
      accountId: world.accountId,
      config: {},
      billing: { passThrough },
    });
  const passed = async (world: CostWorld) =>
    (await world.costs()).filter((cost) => cost.passedThrough).map((cost) => cost.sourceRowId);

  it('a broad pattern never passes a disk or local SSD row through', async () => {
    const world = await costWorld();
    meters(world);
    const vm = await createVm(world);
    await setRules(world, [{ skuPattern: 'Storage', meter: egressMeter, multiplier: 1 }]);
    const at = world.now() - DAY;
    const row = (id: string, skuDescription: string, service = 'Compute Engine') =>
      costRow({
        sourceRowId: id,
        service,
        skuDescription,
        usageStart: at,
        labels: { [instanceLabel]: vm.id },
      });
    world.ledger.rows.push(
      row('pd', 'Storage PD Capacity'),
      row('local-ssd', 'SSD backed Local Storage'),
      row('local-ssd-spot', 'SSD backed Local Storage attached to Spot Preemptible VMs'),
      row('gcs', 'Standard Storage US Multi-region', 'Cloud Storage'),
    );
    await world.scan();
    expect(await passed(world)).toEqual(['gcs']);
  });

  it('nothing passes through for an instance billed none or a pool that is not metered', async () => {
    const world = await costWorld();
    meters(world);
    await setRules(world, [{ skuPattern: 'egress', meter: egressMeter, multiplier: 1 }]);
    const free = await createVm(world, 'vm-free');
    const billed = await createVm(world, 'vm-billed');
    await world.fixture.database.query(`UPDATE instances SET billing = 'none' WHERE id = $1`, [
      free.id,
    ]);
    const at = world.now() - DAY;
    const egress = (id: string, instanceId: string) =>
      costRow({ sourceRowId: id, usageStart: at, labels: { [instanceLabel]: instanceId } });
    world.ledger.rows.push(egress('free-1', free.id), egress('billed-1', billed.id));
    await world.scan();
    expect(await passed(world)).toEqual(['billed-1']);
    for (const mode of ['platform-fee', 'none']) {
      await world.fixture.database.query(
        `UPDATE pools SET policy = jsonb_set(policy, '{billing}', $2::jsonb) WHERE id = $1`,
        [world.poolId, JSON.stringify({ mode })],
      );
      world.ledger.rows.push(egress(`billed-${mode}`, billed.id));
      await world.fixture.advance(6 * HOUR);
      await world.scan();
      expect(await passed(world)).toEqual(['billed-1']);
    }
  });
});

describe('margins and leaks fix round 1 (F17-1..F17-3)', () => {
  /** `hours` hours of N2 cores of `instanceId` from `start`, on a ledger. */
  function cores(ledger: Ledger, instanceId: string, start: number, hours: number, prefix: string) {
    for (let hour = 0; hour < hours; hour++)
      ledger.rows.push(
        costRow({
          sourceRowId: `${prefix}-${hour}`,
          skuDescription: 'N2 Instance Core running in Americas',
          usageStart: start + hour * HOUR,
          usageEnd: start + (hour + 1) * HOUR,
          quantity: 12,
          labels: { [instanceLabel]: instanceId },
        }),
      );
  }

  it("leaks are not looked for on a tenant's own account, nor for an instance billed none", async () => {
    const world = await costWorld();
    const free = await createVm(world, 'vm-free');
    await world.fixture.database.query(`UPDATE instances SET billing = 'none' WHERE id = $1`, [
      free.id,
    ]);
    const day = Math.floor((world.now() - 2 * DAY) / DAY) * DAY;
    cores(world.ledger, free.id, day + 2 * HOUR, 5, 'free');
    // a BYO account's rows: the account tenant's cost, never a platform leak (its own instance id is kept)
    const site = await world.api.sites.create(world.acme, {
      tenantId: world.acmeTenant,
      kind: 'custom',
      region: 'us-central1',
      idempotencyKey: 'acme-site',
    });
    const pool = await world.api.pools.create(world.acme, {
      tenantId: world.acmeTenant,
      siteId: site.id,
      class: 'provider',
      providerAccountId: world.byoAccountId,
      ownerQuota: { vcpu: 100, memoryGiB: 1000, diskGiB: 10_000, gpu: 8 },
      idempotencyKey: 'acme-pool',
    });
    await world.api.flavors.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: pool.id,
      name: 'a2.byo',
      vcpu: 12,
      memoryGiB: 85,
      diskGiB: 100,
      gpus: 1,
      offerId: 'us-central1-a/a2-highgpu-1g',
    });
    const own = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: pool.id,
      flavor: 'a2.byo',
      imageId: 'debian-12',
      idempotencyKey: 'acme-vm',
    });
    cores(world.byoLedger, own.id, day + 2 * HOUR, 5, 'byo');
    await world.scan();
    expect((await world.costs()).filter((cost) => cost.instanceId === own.id)).toHaveLength(5);
    expect(await world.events('billing.leak')).toEqual([]);
  });

  it('provider_costs is indexed by account and day, and by day', async () => {
    const world = await costWorld();
    const { rows } = await world.fixture.database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'provider_costs' ORDER BY indexname`,
    );
    const defs = rows.map((row) => row.indexdef.replace(/^.* USING btree /, ''));
    expect(defs).toEqual(
      expect.arrayContaining([
        '(account_id, usage_start)',
        '(usage_start)',
        '(tenant_id, usage_start)',
      ]),
    );
  });
});

describe('final fix wave: late pass-through charges (FW-4)', () => {
  const egressMeter = 'network.egress.gib';
  const egressRule = { skuPattern: 'egress', meter: egressMeter, multiplier: 1 };
  async function setup(options: Pick<VpsOptions, 'costs' | 'billing'> = {}) {
    const world = await costWorld(options);
    Object.assign(world.fixture.iam, {
      listMeters: async () => [{ key: egressMeter, pricing: 'reported' }],
    });
    const vm = await createVm(world);
    await world.api.providerAccounts.update(world.root, {
      tenantId: world.rootTenant,
      accountId: world.accountId,
      config: {},
      billing: { passThrough: [egressRule] },
    });
    // Seven hours into the next UTC month: the month before has closed (default grace 6 h).
    const now = new Date(world.now());
    const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    await world.fixture.advance(month + 7 * HOUR - world.now());
    const egress = (id: string, at: number) =>
      costRow({
        sourceRowId: id,
        usageStart: at,
        usageEnd: at + HOUR,
        labels: { [instanceLabel]: vm.id },
      });
    world.ledger.rows.push(egress('late', month - HOUR), egress('open', month + HOUR));
    await world.scan();
    const { rows } = await world.fixture.database.query<any>(
      `SELECT idempotency_key AS key, (extract(epoch FROM window_start) * 1000)::float8 AS start_ms,
              (extract(epoch FROM window_end) * 1000)::float8 AS end_ms
         FROM usage_windows WHERE source_kind = 'cost' ORDER BY idempotency_key`,
    );
    const { rows: stored } = await world.fixture.database.query<any>(
      `SELECT source_row_id, (extract(epoch FROM usage_start) * 1000)::float8 AS start_ms
         FROM provider_costs WHERE account_id = $1 ORDER BY source_row_id`,
      [world.accountId],
    );
    return {
      world,
      month,
      windows: rows.map((row) => ({
        key: row.key,
        start: Number(row.start_ms),
        end: Number(row.end_ms),
      })),
      stored: stored.map((row) => [row.source_row_id, Number(row.start_ms)]),
    };
  }

  it('a row whose month has closed lands at the first hour of the current month', async () => {
    const { world, month, windows, stored } = await setup();
    expect(windows).toEqual([
      // the late charge: key unchanged, window at the current month's first hour
      { key: `costx:${world.accountId}:late`, start: month, end: month + HOUR },
      // a row of the open month is unchanged
      { key: `costx:${world.accountId}:open`, start: month + HOUR, end: month + 2 * HOUR },
    ]);
    // the stored row keeps its usage start
    expect(stored).toEqual([
      ['late', month - HOUR],
      ['open', month + HOUR],
    ]);
  });

  it('billing.closeGraceHours moves the close; it is validated', async () => {
    const { world, month, windows } = await setup({ billing: { closeGraceHours: 12 } });
    // 7 h into the month with a 12 h grace: the previous month is still open.
    expect(windows).toEqual([
      { key: `costx:${world.accountId}:late`, start: month - HOUR, end: month },
      { key: `costx:${world.accountId}:open`, start: month + HOUR, end: month + 2 * HOUR },
    ]);
    for (const closeGraceHours of [-1, 73, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => vps({ billing: { closeGraceHours } })).toThrow(/closeGraceHours/);
  });
});
