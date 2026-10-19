import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { ComputeError, type SqlExecutor, type SqlTx } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  assertFlavorEntitled,
  capacityMigrations,
  chargeQuota,
  countQuotaResources,
  listTenantOffers,
  parseFlavorAllowlist,
  readQuotas,
  refundQuota,
  setQuota,
  tenantQuotaScope,
} from '@better-compute/capacity';

// Admission for every caller (U-02), capacity's half, on PGlite: tenant-level (`*`) quota rows that move with the
// pool rows (gpu per model included), counted resources (`instances`, `sandboxes`) that limit only where a row
// exists and are refunded as recorded, flavor allowlists on offers and quota rows, and the listing of the offers
// a tenant holds or inherits (`includeDescendants`, priority).

let db: SqlExecutor;
const SITE = 'site_01jz00000000000000000000aa';
const H100 = 'pool_01jz000000000000000000h100';
const H100B = 'pool_01jz00000000000000000h100b';
const L40S = 'pool_01jz000000000000000000l40s';
const CPU = 'pool_01jz0000000000000000000cpu';

const tx = <T>(fn: (tx: SqlTx) => Promise<T>) => db.transaction(fn);
const used = async (tenantId: string, poolId: string, resource: string) => {
  const { rows } = await db.query<{ used: string }>(
    `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
    [tenantId, poolId, resource],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].used);
};
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: ComputeError) => error,
  );

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  for (const table of ['quota_usage', 'pool_offers', 'pools', 'sites'])
    await db.query(`DELETE FROM ${table}`);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  for (const [id, model] of [
    [H100, 'H100'],
    [H100B, 'H100'],
    [L40S, 'L40S'],
    [CPU, null],
  ] as const)
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ($1, 'root', $2, 'vps-host', $3, 'exclusive', 'bcd', '{}', 1)`,
      [id, SITE, model],
    );
  for (const pool of [H100, H100B, L40S, CPU])
    for (const [resource, max] of [
      ['gpu', 8],
      ['vcpu', 64],
      ['memoryGiB', 256],
      ['diskGiB', 1000],
    ] as const)
      await tx((t) => setQuota(t, 'acme', pool, resource, max));
});

describe('tenant-level quota rows (*)', () => {
  it('limit the tenant total across pools, and move with every charge and refund', async () => {
    await tx((t) => chargeQuota(t, 'acme', H100, { vcpu: 10 }));
    await tx((t) => chargeQuota(t, 'acme', CPU, { vcpu: 6 }));
    // A row set later starts at the tenant's total over its pool rows.
    await tx((t) => setQuota(t, 'acme', tenantQuotaScope, 'vcpu', 20));
    expect(await used('acme', '*', 'vcpu')).toBe(16);

    await tx((t) => chargeQuota(t, 'acme', L40S, { vcpu: 4 }));
    expect(await used('acme', '*', 'vcpu')).toBe(20);
    const refused = await failure(
      tx((t) => chargeQuota(t, 'acme', CPU, { vcpu: 1, memoryGiB: 1 })),
    );
    expect(refused).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'vcpu', poolId: '*', scope: 'tenant', requested: 1, max: 20, used: 20 },
    });
    // All or nothing: the pool rows it would have charged are untouched.
    expect(await used('acme', CPU, 'vcpu')).toBe(6);
    expect(await used('acme', CPU, 'memoryGiB')).toBe(0);

    await tx((t) => refundQuota(t, 'acme', H100, { vcpu: 10 }));
    expect(await used('acme', '*', 'vcpu')).toBe(10);
    expect(await used('acme', H100, 'vcpu')).toBe(0);
    await tx((t) => chargeQuota(t, 'acme', CPU, { vcpu: 1 }));
    expect(await used('acme', '*', 'vcpu')).toBe(11);
    // Another tenant is not limited by acme's row.
    await tx((t) => setQuota(t, 'other', CPU, 'vcpu', 64));
    await tx((t) => chargeQuota(t, 'other', CPU, { vcpu: 30 }));
    expect(await used('acme', '*', 'vcpu')).toBe(11);
  });

  it('a missing tenant row limits nothing; a missing pool row still grants 0', async () => {
    await tx((t) => chargeQuota(t, 'acme', CPU, { vcpu: 64 }));
    expect(await used('acme', '*', 'vcpu')).toBeUndefined();
    expect(await failure(tx((t) => chargeQuota(t, 'acme', CPU, { hugepages: 1 })))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'hugepages', poolId: CPU, scope: 'pool' },
    });
  });

  it('limit GPUs per model: gpu.<gpuModel> counts the GPUs of pools of that model only', async () => {
    await tx((t) => chargeQuota(t, 'acme', H100, { gpu: 2 }));
    await tx((t) => setQuota(t, 'acme', '*', 'gpu.H100', 4));
    expect(await used('acme', '*', 'gpu.H100')).toBe(2);
    await tx((t) => chargeQuota(t, 'acme', H100B, { gpu: 2 }));
    expect(await used('acme', '*', 'gpu.H100')).toBe(4);
    expect(await failure(tx((t) => chargeQuota(t, 'acme', H100, { gpu: 1 })))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'gpu.H100', poolId: '*', scope: 'tenant' },
    });
    // L40S GPUs are another model.
    await tx((t) => chargeQuota(t, 'acme', L40S, { gpu: 3 }));
    expect(await used('acme', '*', 'gpu.H100')).toBe(4);
    await tx((t) => refundQuota(t, 'acme', H100B, { gpu: 2 }));
    expect(await used('acme', '*', 'gpu.H100')).toBe(2);
  });

  it('readQuotas lists the tenant rows with poolId *', async () => {
    await tx((t) => setQuota(t, 'acme', '*', 'instances', 5));
    const rows = await tx((t) => readQuotas(t, 'acme', '*'));
    expect(rows).toEqual([
      { tenantId: 'acme', poolId: '*', resource: 'instances', max: 5, used: 0, available: 5 },
    ]);
  });
});

describe('counted resources (instances, sandboxes)', () => {
  it('are counted only where a row exists, and the charge says where', async () => {
    expect(countQuotaResources).toEqual(['sandboxes', 'instances']);
    // No rows: nothing is limited and nothing is recorded for them.
    expect(await tx((t) => chargeQuota(t, 'acme', CPU, { instances: 1, vcpu: 2 }))).toEqual({
      vcpu: 2,
    });

    await tx((t) => setQuota(t, 'acme', CPU, 'instances', 2));
    await tx((t) => setQuota(t, 'acme', '*', 'instances', 3));
    const first = await tx((t) => chargeQuota(t, 'acme', CPU, { instances: 1 }));
    expect(first).toEqual({ instances: 1, '*:instances': 1 });
    await tx((t) => chargeQuota(t, 'acme', CPU, { instances: 1 }));
    expect(await failure(tx((t) => chargeQuota(t, 'acme', CPU, { instances: 1 })))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'instances', poolId: CPU },
    });
    // Another pool has no instances row: only the tenant row limits it.
    expect(await tx((t) => chargeQuota(t, 'acme', L40S, { instances: 1 }))).toEqual({
      '*:instances': 1,
    });
    expect(await failure(tx((t) => chargeQuota(t, 'acme', L40S, { instances: 1 })))).toMatchObject({
      details: { resource: 'instances', poolId: '*', scope: 'tenant' },
    });

    // A refund takes back exactly what was recorded.
    await tx((t) => refundQuota(t, 'acme', L40S, { '*:instances': 1 }));
    expect(await used('acme', '*', 'instances')).toBe(2);
    await tx((t) => refundQuota(t, 'acme', CPU, first));
    expect(await used('acme', CPU, 'instances')).toBe(1);
    expect(await used('acme', '*', 'instances')).toBe(1);
    // A charge recorded before the tenant row existed never touches it.
    await tx((t) => refundQuota(t, 'acme', CPU, { instances: 1 }));
    expect(await used('acme', CPU, 'instances')).toBe(0);
    expect(await used('acme', '*', 'instances')).toBe(1);
  });

  it('a recorded charge passed back to chargeQuota is never charged again', async () => {
    await tx((t) => setQuota(t, 'acme', '*', 'sandboxes', 1));
    expect(await tx((t) => chargeQuota(t, 'acme', CPU, { '*:sandboxes': 1, vcpu: 1 }))).toEqual({
      vcpu: 1,
    });
    expect(await used('acme', '*', 'sandboxes')).toBe(0);
  });
});

describe('flavor allowlists', () => {
  const entitled = (flavor: string | undefined, demand: Record<string, number>, poolId = H100) =>
    tx((t) => assertFlavorEntitled(t, { tenantId: 'acme', poolId, flavor, demand }));

  it('parses allowlists', () => {
    expect(parseFlavorAllowlist(undefined, 'flavors')).toBeUndefined();
    expect(parseFlavorAllowlist(['a', 'b', 'a'], 'flavors')).toEqual(['a', 'b']);
    expect(parseFlavorAllowlist(null, 'flavors', { nullable: true })).toBeNull();
    for (const bad of [null, [], ['Bad Name'], 'a', Array(65).fill('x')])
      expect(() => parseFlavorAllowlist(bad, 'flavors')).toThrow(ComputeError);
  });

  it('an offer lists the flavors a tenant may use on the pool', async () => {
    await entitled('anything', { vcpu: 1 });
    await db.query(
      `INSERT INTO pool_offers (pool_id, tenant_id, flavors) VALUES ($1, 'acme', ARRAY['g1.small', 'g1.large'])`,
      [H100],
    );
    await entitled('g1.small', { vcpu: 2 });
    expect(await failure(entitled('gpu.8x', { gpu: 8 }))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: {
        reason: 'flavor-not-offered',
        flavor: 'gpu.8x',
        flavors: ['g1.small', 'g1.large'],
      },
    });
    // An attached machine whose type no flavor offers has no flavor: refused by any list.
    expect(await failure(entitled(undefined, { vcpu: 2 }))).toMatchObject({
      details: { reason: 'flavor-not-offered', flavor: null },
    });
  });

  it('a quota row lists the flavors that may consume it, on the pool or tenant-wide', async () => {
    await tx((t) => setQuota(t, 'acme', H100, 'gpu', 8, { flavors: ['gpu.1x'] }));
    await entitled('gpu.1x', { gpu: 1, vcpu: 8 });
    // A flavor without GPUs does not consume the gpu row.
    await entitled('cpu.small', { vcpu: 2 });
    expect(await failure(entitled('gpu.8x', { gpu: 8 }))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { reason: 'flavor-not-allowed', resource: 'gpu', poolId: H100, scope: 'pool' },
    });
    // Tenant-wide, per GPU model.
    await tx((t) => setQuota(t, 'acme', '*', 'gpu.L40S', 4, { flavors: ['l40s.1x'] }));
    await entitled('gpu.1x', { gpu: 1 });
    expect(await failure(entitled('l40s.2x', { gpu: 2 }, L40S))).toMatchObject({
      details: { reason: 'flavor-not-allowed', resource: 'gpu.L40S', poolId: '*', scope: 'tenant' },
    });
    await entitled('l40s.1x', { gpu: 1 }, L40S);
  });

  it('setQuota keeps a row list when omitted and clears it with null', async () => {
    await tx((t) => setQuota(t, 'acme', CPU, 'vcpu', 32, { flavors: ['a'] }));
    await tx((t) => setQuota(t, 'acme', CPU, 'vcpu', 48));
    let [row] = (await tx((t) => readQuotas(t, 'acme', CPU))).filter(
      (quota) => quota.resource === 'vcpu',
    );
    expect(row).toMatchObject({ max: 48, flavors: ['a'] });
    await tx((t) => setQuota(t, 'acme', CPU, 'vcpu', 48, { flavors: null }));
    [row] = (await tx((t) => readQuotas(t, 'acme', CPU))).filter(
      (quota) => quota.resource === 'vcpu',
    );
    expect(row).not.toHaveProperty('flavors');
  });
});

describe('offers a tenant holds or inherits', () => {
  // root offers pools to an organization (org) and to one of its projects (proj); proj's ancestors are org, then root.
  beforeEach(async () => {
    const offer = (
      pool: string,
      tenant: string,
      descendants: boolean,
      priority: number,
      flavors?: string[],
    ) =>
      db.query(
        `INSERT INTO pool_offers (pool_id, tenant_id, include_descendants, priority, flavors) VALUES ($1, $2, $3, $4, $5)`,
        [pool, tenant, descendants, priority, flavors ?? null],
      );
    await offer(H100, 'org', true, 10, ['gpu.1x']);
    await offer(H100B, 'org', false, 50);
    await offer(L40S, 'org', true, 5);
    await offer(L40S, 'proj', false, 1);
    await offer(CPU, 'root-parent', true, 20);
    await tx((t) => setQuota(t, 'org', H100, 'gpu', 4));
  });

  it('lists its own offers and its ancestors made with includeDescendants, nearest first, by priority', async () => {
    const offers = await tx((t) => listTenantOffers(t, 'proj', ['org', 'root-parent']));
    expect(
      offers.map((offer) => [offer.poolId, offer.offeredTo, offer.depth, offer.priority]),
    ).toEqual([
      [CPU, 'root-parent', 2, 20],
      [H100, 'org', 1, 10],
      // Its own offer shadows the parent's.
      [L40S, 'proj', 0, 1],
    ]);
    const h100 = offers.find((offer) => offer.poolId === H100)!;
    expect(h100).toMatchObject({
      inherited: true,
      includeDescendants: true,
      flavors: ['gpu.1x'],
      suspended: false,
      pool: { ownerTenantId: 'root', siteId: SITE, class: 'vps-host', gpuModel: 'H100' },
      quotas: [{ tenantId: 'org', poolId: H100, resource: 'gpu', max: 4, used: 0, available: 4 }],
    });
  });

  it('without ancestors, lists only its own offers; archived pools and owned pools are left out', async () => {
    expect((await tx((t) => listTenantOffers(t, 'org', []))).map((offer) => offer.poolId)).toEqual([
      H100B,
      H100,
      L40S,
    ]);
    await db.query(`UPDATE pools SET archived_at = now() WHERE id = $1`, [H100B]);
    expect((await tx((t) => listTenantOffers(t, 'org', []))).map((offer) => offer.poolId)).toEqual([
      H100,
      L40S,
    ]);
    await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'root')`, [CPU]);
    expect(await tx((t) => listTenantOffers(t, 'root', []))).toEqual([]);
  });
});

describe('pools.offers over the API', () => {
  afterEach(closeFixtures);

  it('lists the offers a tenant inherits from the ancestors the host names', async () => {
    const asked: string[] = [];
    const fixture = await computeFixture({
      capacity: {
        tenantAncestors: async (tenantId) => {
          asked.push(tenantId);
          return tenantId === fixture.tenants.acme.id ? ['tenant-parent'] : [];
        },
      },
    });
    const { tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    iam.allow({ token: tenants.acme.token });
    const api = fixture.compute.api as any;
    const root = { token: tenants.root.token };
    const site = await api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region: 'eu',
      idempotencyKey: 'site',
    });
    const pool = (key: string) =>
      api.pools.create(root, {
        tenantId: tenants.root.id,
        siteId: site.id,
        class: 'metal-host',
        gpuModel: 'H100',
        idempotencyKey: key,
      });
    const own = await pool('own');
    const inherited = await pool('inherited');
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: own.id,
      toTenantId: tenants.acme.id,
      quota: { gpu: 2 },
    });
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: inherited.id,
      toTenantId: 'tenant-parent',
      quota: { gpu: 8 },
      includeDescendants: true,
      priority: 5,
      flavors: ['gpu.1x'],
    });
    const { items } = await api.pools.offers(
      { token: tenants.acme.token },
      { tenantId: tenants.acme.id },
    );
    expect(asked).toEqual([tenants.acme.id]);
    expect(
      items.map((offer: { poolId: string; offeredTo: string; inherited: boolean }) => [
        offer.poolId,
        offer.offeredTo,
        offer.inherited,
      ]),
    ).toEqual([
      [inherited.id, 'tenant-parent', true],
      [own.id, tenants.acme.id, false],
    ]);
    expect(items[0]).toMatchObject({
      flavors: ['gpu.1x'],
      priority: 5,
      quotas: [{ resource: 'gpu', max: 8 }],
    });
  });
});
