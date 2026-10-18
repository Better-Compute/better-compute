import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isComputeError,
  type IamPort,
  type MeterSpec,
  type PriceSpecInput,
  type UsageEvent,
} from '@better-compute/core';
import {
  createComputeIamBridge,
  embeddedIam,
  spyIamPort,
  type ComputeIamBridge,
} from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { createMetrics, meteredIamPort, standardMetrics } from '@better-compute/observability';
import { ORIGIN, closeIamFixtures, iamFixture, type IamFixture } from './support/iam.js';
import { guardIamPort } from '../packages/server/src/iam-guard.js';

// The billing members of the IamPort (platform compute billing, D13): compute manages meters, prices, quotes and
// spend on the IAM root tenant. The same suite runs against the embedded port and against the remote port, which
// reaches the same better-iam over its HTTP handler.

const open: EmbeddedTestIam[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
  await closeIamFixtures();
});

const gpu: MeterSpec = {
  key: 'gpu.h100.hours',
  name: 'H100 GPU hours',
  unit: 'gpu-hour',
  pricing: 'rate-card',
};
const vcpu: MeterSpec = {
  key: 'vps.vcpu.hours',
  name: 'vCPU hours',
  unit: 'vcpu-hour',
  pricing: 'rate-card',
};
const passthrough: MeterSpec = {
  key: 'vps.passthrough',
  name: 'Provider pass-through',
  unit: 'currency',
  pricing: 'reported',
};

const perUnit = (unitAmountMicros: number): PriceSpecInput => ({
  model: 'per-unit',
  unitAmountMicros,
});

async function setup(mode: 'embedded' | 'remote') {
  const t = await createEmbeddedTestIam({ inbox: 'memory', mode });
  open.push(t);
  const port: IamPort = t.port;
  const period = new Date(t.now()).toISOString().slice(0, 7);
  const usage = (
    tenantId: string,
    meter: string,
    quantity: number,
    key: string,
    tags: Record<string, string> = {},
  ): UsageEvent => ({
    tenantId,
    meter,
    quantity,
    occurredAt: t.now(),
    tags,
    idempotencyKey: `cmp:test:${key}`,
  });
  return { t, port, period, usage };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe.each(['embedded', 'remote'] as const)('the IamPort billing members (%s)', (mode) => {
  it('has all five members', async () => {
    const { port } = await setup(mode);
    for (const member of ['ensureMeters', 'setPrice', 'listPrices', 'quote', 'spend'] as const)
      expect(typeof port[member], member).toBe('function');
  });

  it('ensureMeters creates missing meters on root and is idempotent', async () => {
    const { t, port } = await setup(mode);
    const first = await port.ensureMeters!([gpu, vcpu, passthrough]);
    expect(first).toEqual({ created: [gpu.key, vcpu.key, passthrough.key], existing: [] });

    const second = await port.ensureMeters!([gpu, vcpu, passthrough]);
    expect(second).toEqual({ created: [], existing: [gpu.key, vcpu.key, passthrough.key] });

    // A new key among old ones: only that one is created.
    const extra: MeterSpec = { ...vcpu, key: 'vps.memory.gib.hours', name: 'Memory GiB hours' };
    expect(await port.ensureMeters!([gpu, extra, gpu])).toEqual({
      created: [extra.key],
      existing: [gpu.key],
    });

    const meters = await t.iam.api.billing.listMeters(t.root.credential, {
      tenantId: t.root.tenantId,
    });
    expect(meters.find((meter) => meter.key === gpu.key)).toMatchObject({
      name: 'H100 GPU hours',
      unit: 'gpu-hour',
      pricing: 'rate-card',
      scope: 'platform',
    });
    expect(meters.find((meter) => meter.key === passthrough.key)).toMatchObject({
      pricing: 'reported',
    });
  });

  it('refuses a malformed meter key', async () => {
    const { port } = await setup(mode);
    expect(await failure(port.ensureMeters!([{ ...gpu, key: 'GPU Hours' }]))).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('setPrice then listPrices round-trips, and a negotiated price beats the list price in quotes', async () => {
    const { t, port, period } = await setup(mode);
    await port.ensureMeters!([gpu, vcpu]);

    const list = await port.setPrice!({
      meter: gpu.key,
      effectiveFrom: period,
      spec: perUnit(2_500_000),
    });
    expect(list).toEqual({
      meter: gpu.key,
      targetTenantId: t.root.tenantId,
      effectiveFrom: period,
      spec: perUnit(2_500_000),
    });

    const negotiated = await port.setPrice!({
      meter: gpu.key,
      targetTenantId: t.acme.tenantId,
      effectiveFrom: period,
      spec: perUnit(1_999_999),
    });
    expect(negotiated).toMatchObject({
      targetTenantId: t.acme.tenantId,
      spec: perUnit(1_999_999),
    });

    const all = await port.listPrices!({ meter: gpu.key });
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([list, negotiated]));
    expect(await port.listPrices!({ meter: gpu.key, targetTenantId: t.acme.tenantId })).toEqual([
      negotiated,
    ]);
    // No meter named: every rate-card meter is searched (vcpu has no price yet).
    expect(await port.listPrices!({ targetTenantId: t.acme.tenantId })).toEqual([negotiated]);
    expect((await port.listPrices!({})).map((price) => price.meter)).toEqual([gpu.key, gpu.key]);

    const lines = [{ meter: gpu.key, quantity: 10 }];
    const acme = await port.quote!({ tenantId: t.acme.tenantId, lines });
    const other = await port.quote!({ tenantId: t.other.tenantId, lines });
    expect(acme).toEqual([{ meter: gpu.key, quantity: 10, amountMicros: 19_999_990 }]);
    expect(other).toEqual([{ meter: gpu.key, quantity: 10, amountMicros: 25_000_000 }]);
    expect(acme[0]!.amountMicros!).toBeLessThan(other[0]!.amountMicros!);
  });

  it('round-trips graduated, volume and package prices with included units and bounds', async () => {
    const { port, period } = await setup(mode);
    await port.ensureMeters!([gpu, vcpu]);
    const graduated: PriceSpecInput = {
      model: 'graduated',
      tiers: [
        { upTo: 100, unitAmountMicros: 3_000_000 },
        { upTo: 1000, unitAmountMicros: 2_000_000, flatAmountMicros: 500_000 },
        { upTo: null, unitAmountMicros: 1_500_000 },
      ],
      includedQuantity: 10,
      minimumAmountMicros: 1_000_000,
      maximumAmountMicros: 900_000_000,
    };
    const set = await port.setPrice!({ meter: gpu.key, effectiveFrom: period, spec: graduated });
    expect(set.spec).toEqual(graduated);
    expect((await port.listPrices!({ meter: gpu.key }))[0]!.spec).toEqual(graduated);

    const bundle: PriceSpecInput = {
      model: 'package',
      packageSize: 4,
      packageAmountMicros: 1_250_000,
    };
    expect(
      (await port.setPrice!({ meter: vcpu.key, effectiveFrom: period, spec: bundle })).spec,
    ).toEqual(bundle);
  });

  it('quote marks unpriced meters null', async () => {
    const { t, port, period } = await setup(mode);
    await port.ensureMeters!([gpu, vcpu]);
    await port.setPrice!({ meter: gpu.key, effectiveFrom: period, spec: perUnit(4_000_000) });

    const lines = [
      { meter: gpu.key, quantity: 3 },
      { meter: vcpu.key, quantity: 8 },
      { meter: gpu.key, quantity: 0 },
    ];
    expect(await port.quote!({ tenantId: t.acme.tenantId, lines })).toEqual([
      { meter: gpu.key, quantity: 3, amountMicros: 12_000_000 },
      { meter: vcpu.key, quantity: 8, amountMicros: null },
      { meter: gpu.key, quantity: 0, amountMicros: 0 },
    ]);
    expect(await port.quote!({ tenantId: t.acme.tenantId, lines: [] })).toEqual([]);
  });

  it('quote prices each line alone: unknown, reported and archived meters are null lines', async () => {
    const { t, port, period } = await setup(mode);
    const archived: MeterSpec = { ...vcpu, key: 'vps.old.hours', name: 'Retired meter' };
    await port.ensureMeters!([gpu, passthrough, archived]);
    await port.setPrice!({ meter: gpu.key, effectiveFrom: period, spec: perUnit(4_000_000) });
    await port.setPrice!({ meter: archived.key, effectiveFrom: period, spec: perUnit(1_000_000) });
    await t.iam.api.billing.updateMeter(t.root.credential, {
      tenantId: t.root.tenantId,
      key: archived.key,
      archived: true,
    });

    const lines = [
      { meter: 'no.such.meter', quantity: 1 },
      { meter: gpu.key, quantity: 2 },
      { meter: passthrough.key, quantity: 5 },
      { meter: archived.key, quantity: 5 },
      { meter: 'Not A Key', quantity: 1 },
    ];
    expect(await port.quote!({ tenantId: t.acme.tenantId, lines })).toEqual([
      { meter: 'no.such.meter', quantity: 1, amountMicros: null },
      { meter: gpu.key, quantity: 2, amountMicros: 8_000_000 },
      { meter: passthrough.key, quantity: 5, amountMicros: null },
      { meter: archived.key, quantity: 5, amountMicros: null },
      { meter: 'Not A Key', quantity: 1, amountMicros: null },
    ]);
  });

  it('quote refuses a negative or non-finite quantity, and an unknown tenant', async () => {
    const { t, port } = await setup(mode);
    for (const quantity of [-1, Number.NaN])
      expect(
        await failure(
          port.quote!({ tenantId: t.acme.tenantId, lines: [{ meter: gpu.key, quantity }] }),
        ),
      ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await failure(
        port.quote!({ tenantId: 'ten_nope', lines: [{ meter: gpu.key, quantity: 1 }] }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('spend groups by meter for a tenant', async () => {
    const { t, port, period, usage } = await setup(mode);
    await port.ensureMeters!([gpu, vcpu]);
    await port.setPrice!({ meter: gpu.key, effectiveFrom: period, spec: perUnit(2_000_000) });
    await port.setPrice!({ meter: vcpu.key, effectiveFrom: period, spec: perUnit(100_000) });
    await port.recordUsage([
      usage(t.acme.tenantId, gpu.key, 5, 'a1', { region: 'eu' }),
      usage(t.acme.tenantId, gpu.key, 7, 'a2', { region: 'us' }),
      usage(t.acme.tenantId, vcpu.key, 40, 'a3', { region: 'eu' }),
      usage(t.other.tenantId, gpu.key, 1, 'o1', { region: 'eu' }),
    ]);

    const from = Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)) - 1, 1);
    const to = t.now() + 3_600_000;

    const {
      rows: byMeter,
      coveredFrom,
      coveredTo,
    } = await port.spend!({
      tenantId: t.acme.tenantId,
      from,
      to,
      groupBy: 'meter',
    });
    expect(byMeter).toHaveLength(2);
    expect(byMeter).toEqual(
      expect.arrayContaining([
        { key: gpu.key, meter: gpu.key, amountMicros: 24_000_000, quantity: 12 },
        { key: vcpu.key, meter: vcpu.key, amountMicros: 4_000_000, quantity: 40 },
      ]),
    );

    expect([coveredFrom, coveredTo]).toEqual([
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)) - 1, 1),
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 1),
    ]);

    // The root sees the whole subtree, by tenant and by tag.
    const { rows: byTenant } = await port.spend!({
      tenantId: t.root.tenantId,
      from,
      to,
      groupBy: 'tenant',
    });
    expect(byTenant).toEqual(
      expect.arrayContaining([
        { key: t.acme.tenantId, tenantId: t.acme.tenantId, amountMicros: 28_000_000, quantity: 52 },
        { key: t.other.tenantId, tenantId: t.other.tenantId, amountMicros: 2_000_000, quantity: 1 },
      ]),
    );
    const { rows: byRegion } = await port.spend!({
      tenantId: t.root.tenantId,
      from,
      to,
      groupBy: 'tag',
      tag: 'region',
    });
    expect(byRegion).toEqual(
      expect.arrayContaining([
        { key: 'eu', amountMicros: 2_000_000 * 6 + 4_000_000, quantity: 46 },
        { key: 'us', amountMicros: 14_000_000, quantity: 7 },
      ]),
    );
  });

  it('spend covers whole billing periods and says which', async () => {
    const { t, port, period, usage } = await setup(mode);
    await port.ensureMeters!([gpu]);
    await port.setPrice!({ meter: gpu.key, effectiveFrom: period, spec: perUnit(1_000_000) });
    await port.recordUsage([usage(t.acme.tenantId, gpu.key, 3, 'm1')]);
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5)) - 1;
    const end = Date.UTC(year, month + 1, 1);
    const row = { key: gpu.key, meter: gpu.key, amountMicros: 3_000_000, quantity: 3 };

    // A range inside the month is widened to the whole month.
    expect(
      await port.spend!({
        tenantId: t.acme.tenantId,
        from: t.now() - 1_000,
        to: t.now() + 1,
        groupBy: 'meter',
      }),
    ).toEqual({ rows: [row], coveredFrom: Date.UTC(year, month, 1), coveredTo: end });

    // A range crossing months merges them and covers all of them.
    expect(
      await port.spend!({
        tenantId: t.acme.tenantId,
        from: Date.UTC(year, month - 2, 15),
        to: t.now() + 1,
        groupBy: 'meter',
      }),
    ).toEqual({ rows: [row], coveredFrom: Date.UTC(year, month - 2, 1), coveredTo: end });

    // A range that ends before the usage's period reports nothing, over its own periods.
    expect(
      await port.spend!({
        tenantId: t.acme.tenantId,
        from: Date.UTC(year, month - 3, 1),
        to: Date.UTC(year, month - 1, 1),
        groupBy: 'meter',
      }),
    ).toEqual({
      rows: [],
      coveredFrom: Date.UTC(year, month - 3, 1),
      coveredTo: Date.UTC(year, month - 1, 1),
    });
  });

  it('spend refuses an empty range and a tag grouping without a tag', async () => {
    const { t, port } = await setup(mode);
    const query = { tenantId: t.root.tenantId, from: 1_000, to: 1_000 };
    expect(await failure(port.spend!({ ...query, groupBy: 'meter' }))).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await failure(port.spend!({ ...query, to: 2_000, groupBy: 'tag' }))).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('the billing members without a service credential', () => {
  it('are absent from an embedded port that holds none, except the trusted spend report', async () => {
    const t = await createEmbeddedTestIam({ inbox: 'memory', mode: 'embedded' });
    open.push(t);
    const port = embeddedIam(t.iam as never, { rootTenantId: t.root.tenantId });
    for (const member of ['ensureMeters', 'setPrice', 'listPrices', 'quote'] as const)
      expect(port[member], member).toBeUndefined();
    expect(typeof port.spend).toBe('function');
    // Without the root id the port cannot know whose meters to manage.
    expect(embeddedIam(t.iam as never, {}).spend).toBeUndefined();
  });
  it('a session reviewer is not a billing credential', async () => {
    const t = await createEmbeddedTestIam({ inbox: 'memory', mode: 'embedded' });
    open.push(t);
    const port = embeddedIam(t.iam as never, {
      rootTenantId: t.root.tenantId,
      sessionReviewer: t.root.credential,
    });
    expect(typeof port.authorizeSession).toBe('function');
    for (const member of ['ensureMeters', 'setPrice', 'listPrices', 'quote'] as const)
      expect(port[member], member).toBeUndefined();
  });
});

describe('the iam module doctor and the billing members', () => {
  const doctor = async (configure: (bridge: ComputeIamBridge, f: IamFixture) => unknown) => {
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin()],
      resolveResource: bridge.resolveResource(),
    });
    configure(bridge, f);
    const findings = await bridge.modules[0].selfCheck!({} as never);
    return findings.filter((item) => item.check === 'iam.billing-port');
  };

  it('warns when an embedded port has a root tenant but no billing credential', async () => {
    const findings = await doctor((bridge, f) =>
      bridge.embedded(f.iam, { rootTenantId: f.rootTenantId }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning' });
    expect(findings[0]!.fix).toContain('bridge.embedded(iam, { rootTenantId, serviceCredential })');
    expect(findings[0]!.fix).toContain('iam:billing:manage');
    expect(findings[0]!.fix).toContain('iam:billing:read');
  });

  it('is quiet with a service credential, with a remote port, and with no port or root tenant', async () => {
    expect(
      await doctor((bridge, f) =>
        bridge.embedded(f.iam, {
          rootTenantId: f.rootTenantId,
          serviceCredential: f.rootCredential,
        }),
      ),
    ).toEqual([]);
    expect(
      await doctor((bridge, f) =>
        bridge.remote({
          baseURL: ORIGIN,
          fetch: async (input, init) => f.iam.handler(new Request(input, init)),
          serviceToken: f.rootCredential.token,
          rootTenantId: f.rootTenantId,
        }),
      ),
    ).toEqual([]);
    expect(await doctor(() => undefined)).toEqual([]);
    expect(await doctor((bridge, f) => bridge.embedded(f.iam))).toEqual([]);
  });
});

describe('port wrappers keep the billing members', () => {
  const members = () => ({
    ensureMeters: vi.fn(async () => ({ created: [], existing: [] })),
    setPrice: vi.fn(async () => ({}) as never),
    listPrices: vi.fn(async () => []),
    quote: vi.fn(async () => []),
    spend: vi.fn(async () => []),
  });
  const base = (extra: object): IamPort =>
    ({
      authenticate: vi.fn(),
      require: vi.fn(),
      authorize: vi.fn(),
      authorizeMany: vi.fn(),
      requestConfirmation: vi.fn(),
      billingCheck: vi.fn(),
      recordUsage: vi.fn(),
      featureEnabled: vi.fn(),
      capabilities: () => ({}),
      ...extra,
    }) as unknown as IamPort;

  it('meteredIamPort counts them as IAM calls', async () => {
    const registry = createMetrics();
    const metered = meteredIamPort(base(members()), standardMetrics(registry));
    await metered.ensureMeters!([]);
    await metered.quote!({ tenantId: 't', lines: [] });
    expect(registry.value('iam_calls_total', { op: 'ensureMeters', outcome: 'ok' })).toBe(1);
    expect(registry.value('iam_calls_total', { op: 'quote', outcome: 'ok' })).toBe(1);
    expect(meteredIamPort(base({}), standardMetrics(createMetrics())).spend).toBeUndefined();
  });

  it('spyIamPort records them, and has only those the inner port has', async () => {
    const spy = spyIamPort(base(members()));
    await spy.quote!({ tenantId: 'acme', lines: [] });
    expect(spy.calls).toMatchObject([{ method: 'quote', tenantId: 'acme', outcome: 'ok' }]);
    expect(spyIamPort(base({})).setPrice).toBeUndefined();
  });

  it('the transaction guard refuses them inside a transaction', async () => {
    const inner = members();
    const guarded = guardIamPort(base(inner), () => true, 'throw', {
      warn: vi.fn(),
    } as never);
    for (const name of ['ensureMeters', 'setPrice', 'listPrices', 'quote', 'spend'] as const)
      await expect(
        (guarded[name] as (input: unknown) => Promise<unknown>)({}),
        name,
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(inner.spend).not.toHaveBeenCalled();
  });
});
