import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultMeterGpuModels,
  manualClock,
  meterCatalog,
  type Credential,
  type PriceSpecInput,
  type SqlExecutor,
} from '@better-compute/core';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';

// The root-only `billing` API group (platform compute billing, D13): meters and prices on the IAM root tenant,
// decided on `compute:billing:*` @ fleet. Everything runs against a REAL better-iam (embedded, with compute's
// plugin and resolver), as tests/root-issued-compute-iam.test.ts does: the root administrator (MFA) is let through
// by ROOT_OVERRIDE, a tenant administrator is turned away before any IAM decision, and a root-tenant member holds
// only what its policy grants on the fleet.

// A model the bridge's own catalog does not name, so its VM meters are missing until syncMeters creates them.
const MODEL = 'zz9';

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let api: any;
let root: Credential;
let R: string;
let A: string;
let B: string;
let acmeAdmin: Credential;
let reader: Credential;
// Hides the billing members from the port while set: the "port without the member" case.
let hidden = false;
const billingMembers = new Set<PropertyKey>([
  'ensureMeters',
  'listMeters',
  'setPrice',
  'listPrices',
  'quote',
  'spend',
]);

const clock = manualClock(Math.floor(Date.now() / 1000) * 1000);
const period = new Date(clock.now()).toISOString().slice(0, 7);
const perUnit = (unitAmountMicros: number): PriceSpecInput => ({
  model: 'per-unit',
  unitAmountMicros,
});
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error?.code ?? String(error),
  );
const failure = (promise: Promise<unknown>): Promise<{ code?: string; message: string }> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error) => error,
  );

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  const port = new Proxy(t.port, {
    get: (target, key) =>
      hidden && billingMembers.has(key) ? undefined : Reflect.get(target, key),
  });
  compute = betterCompute({
    database,
    iam: port,
    secret: 'better-compute-vps-pricing-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [
      ...t.bridge.modules,
      vps({ billing: { gpuModels: [...defaultMeterGpuModels, MODEL] } }),
    ],
  } as any);
  await compute.initialize();
  await useSimClock(database, clock.now());
  api = compute.api;
  root = t.root.credential;
  R = t.root.tenantId;
  A = t.acme.tenantId;
  B = t.other.tenantId;

  const admin = await t.acme.member('admin');
  await t.acme.grant(admin.identityId, {
    version: 1,
    statements: [{ effect: 'allow', actions: ['compute:*'], resources: ['*'] }],
  });
  acmeAdmin = await t.acme.signIn('admin');

  // A member of the root tenant that holds only `compute:billing:read` on the fleet.
  const member = await t.iam.api.identities.create(root, {
    tenantId: R,
    email: 'biller@root.test',
    name: 'Biller',
    password: 'a strong root biller password',
  });
  const policy = await t.iam.api.policies.create(root, {
    tenantId: R,
    name: 'billing-read',
    document: {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:billing:read'], resources: ['compute-fleet/global'] },
      ],
    },
  });
  const role = await t.iam.api.roles.create(root, {
    tenantId: R,
    name: 'billing-read',
    policyIds: [policy.id],
  });
  await t.iam.api.bindings.create(root, {
    tenantId: R,
    roleId: role.id,
    subjectType: 'identity',
    subjectId: member.id,
  });
  const signedIn = await t.iam.api.auth.signIn({
    tenantId: R,
    email: 'biller@root.test',
    password: 'a strong root biller password',
  });
  if (!('token' in signedIn)) throw new Error('Unexpected MFA for a root member');
  reader = { token: signedIn.token };
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

describe('billing: meters and prices', () => {
  it('root lists meters and sees missing ones', async () => {
    const listed = await api.billing.meters(root, {});
    const keys = listed.catalog.map((meter: { key: string }) => meter.key);
    expect(listed.catalog).toEqual(meterCatalog({ gpuModels: [...defaultMeterGpuModels, MODEL] }));
    // The bridge syncs its own catalog at start; the extra model's VM meters are not in it.
    expect(listed.missing).toContain(`vm.gpu.${MODEL}.hours`);
    expect(listed.missing).toContain(`vm.reserved.gpu.${MODEL}.hours`);
    expect(listed.missing).not.toContain('gpu.h100.hours');
    for (const key of listed.missing) expect(keys).toContain(key);

    const synced = await api.billing.syncMeters(root, {});
    expect(synced.created).toEqual(listed.missing);
    expect(synced.existing.length + synced.created.length).toBe(keys.length);

    expect((await api.billing.meters(root, {})).missing).toEqual([]);
    // Idempotent: the second sync creates nothing.
    expect(await api.billing.syncMeters(root, {})).toMatchObject({ created: [] });
  });

  it('root sets a list price and a negotiated price for tenant A', async () => {
    const result = await api.billing.setPrices(root, {
      prices: [
        { meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(4_000_000) },
        {
          meter: 'gpu.h100.hours',
          targetTenantId: A,
          effectiveFrom: period,
          spec: perUnit(3_000_000),
        },
      ],
    });
    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(2);

    const all = await api.billing.prices(root, { meter: 'gpu.h100.hours' });
    expect(all).toHaveLength(2);
    const negotiated = await api.billing.prices(root, {
      meter: 'gpu.h100.hours',
      targetTenantId: A,
    });
    expect(negotiated).toEqual([
      {
        meter: 'gpu.h100.hours',
        targetTenantId: A,
        effectiveFrom: period,
        spec: perUnit(3_000_000),
      },
    ]);
    const list = (await api.billing.prices(root, { meter: 'gpu.h100.hours' })).find(
      (price: { targetTenantId?: string }) => price.targetTenantId === R,
    );
    expect(list).toMatchObject({ spec: perUnit(4_000_000) });
    // Without a meter, every rate-card meter's prices.
    expect((await api.billing.prices(root, {})).length).toBeGreaterThanOrEqual(2);
  });

  it('setPrices answers the prices it applied and the ones better-iam refused', async () => {
    const result = await api.billing.setPrices(root, {
      prices: [
        { meter: 'gpu.h200.hours', effectiveFrom: period, spec: perUnit(5_000_000) },
        {
          meter: 'gpu.h200.hours',
          targetTenantId: 'ten_does_not_exist',
          effectiveFrom: period,
          spec: perUnit(1_000_000),
        },
        {
          meter: 'gpu.b200.hours',
          targetTenantId: B,
          effectiveFrom: period,
          spec: perUnit(7_000_000),
        },
      ],
    });
    expect(result.applied.map((price: { meter: string }) => price.meter)).toEqual([
      'gpu.h200.hours',
      'gpu.b200.hours',
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      index: 1,
      meter: 'gpu.h200.hours',
      targetTenantId: 'ten_does_not_exist',
    });
    expect(typeof result.failed[0].code).toBe('string');
    expect(typeof result.failed[0].message).toBe('string');
  });

  it('setPrices refuses an unknown meter and applies nothing', async () => {
    const before = (await api.billing.prices(root, { meter: 'gpu.l4.hours' })).length;
    expect(
      await outcome(
        api.billing.setPrices(root, {
          prices: [
            { meter: 'gpu.l4.hours', effectiveFrom: period, spec: perUnit(1_000_000) },
            { meter: 'not.in.the.catalog', effectiveFrom: period, spec: perUnit(1_000_000) },
          ],
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect((await api.billing.prices(root, { meter: 'gpu.l4.hours' })).length).toBe(before);
  });

  it('setPrices takes at most 100 prices and well-formed ones', async () => {
    const price = { meter: 'gpu.l4.hours', effectiveFrom: period, spec: perUnit(1_000_000) };
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: Array.from({ length: 101 }, () => price) }),
      ),
    ).toBe('INVALID_INPUT');
    expect(await outcome(api.billing.setPrices(root, { prices: [] }))).toBe('INVALID_INPUT');
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: [{ ...price, effectiveFrom: '2026-13' }] }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: [{ ...price, spec: { model: 'flat' } }] }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(api.billing.setPrices(root, { prices: [{ ...price, spec: perUnit(-1) }] })),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(api.billing.setPrices(root, { prices: [{ ...price, extra: true }] })),
    ).toBe('INVALID_INPUT');
    expect(await outcome(api.billing.prices(root, { meter: 'Not A Meter' }))).toBe('INVALID_INPUT');
  });

  it('a tenant admin is denied on every billing method', async () => {
    const price = { meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) };
    for (const credential of [acmeAdmin]) {
      expect(await outcome(api.billing.meters(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.syncMeters(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.prices(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.setPrices(credential, { prices: [price] }))).toBe(
        'ACCESS_DENIED',
      );
    }
    // Nothing leaked through: the list price root set earlier is unchanged.
    const list = (await api.billing.prices(root, { meter: 'gpu.h100.hours' })).find(
      (entry: { targetTenantId?: string }) => entry.targetTenantId === R,
    );
    expect(list.spec).toEqual(perUnit(4_000_000));
  });

  it('a root member holds only the billing actions its policy grants', async () => {
    expect(await outcome(api.billing.meters(reader, {}))).toBe('allowed');
    expect(await outcome(api.billing.prices(reader, {}))).toBe('allowed');
    expect(await outcome(api.billing.syncMeters(reader, {}))).toBe('ACCESS_DENIED');
    expect(
      await outcome(
        api.billing.setPrices(reader, {
          prices: [{ meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) }],
        }),
      ),
    ).toBe('ACCESS_DENIED');
  });

  it('UNSUPPORTED without the port member, naming the fix', async () => {
    hidden = true;
    try {
      const calls = {
        meters: () => api.billing.meters(root, {}),
        syncMeters: () => api.billing.syncMeters(root, {}),
        prices: () => api.billing.prices(root, {}),
        setPrices: () =>
          api.billing.setPrices(root, {
            prices: [{ meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) }],
          }),
      };
      for (const [name, call] of Object.entries(calls)) {
        const error = await failure(call());
        expect(error.code, name).toBe('UNSUPPORTED');
        expect(error.message, name).toContain('serviceCredential');
        expect(error.message, name).toContain('iam:billing:manage');
      }
    } finally {
      hidden = false;
    }
  });
});
