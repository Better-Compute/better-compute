import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meterCatalog } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { cloudResources } from '@better-compute/cloud-resources';
import { kubernetes } from '@better-compute/kubernetes';
import { vps } from '@better-compute/vps';
import type { CloudResourceView } from '@better-compute/cloud-resources';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets } from './support/memory-secrets.js';

// cloud.resource.hours: one per resource per hour from the provider's first acceptance until it is deleted or
// released, billed to the resource's tenant as `cloud-resource` usage windows; a pool whose billing mode is `none`
// records none. The kind's own meters (sampled rates the provider reports in `usage`) are written only for the
// meters the operator names in `kindMeters`, since better-iam prices only meters it has defined.

const hourMs = 3_600_000;
const graceMs = 6 * 60_000;
let world: CloudResourcesWorld;
let metered: CloudResourcesWorld;
let counter = 0;

type Window = {
  tenant_id: string;
  meter: string;
  quantity: string;
  window_start: Date | string;
  tags: Record<string, string>;
  idempotency_key: string;
};
const windows = async (on: CloudResourcesWorld, resourceId: string, meter?: string) =>
  (
    await on.fixture.database.query<Window>(
      `SELECT tenant_id, meter, quantity::text AS quantity, window_start, tags, idempotency_key
         FROM usage_windows
        WHERE source_kind = 'cloud-resource' AND source_id = $1 AND ($2::text IS NULL OR meter = $2)
        ORDER BY window_start, meter`,
      [resourceId, meter ?? null],
    )
  ).rows;
const total = (rows: readonly Window[]) => rows.reduce((sum, row) => sum + Number(row.quantity), 0);
const column = async (on: CloudResourcesWorld, resourceId: string) =>
  (
    await on.fixture.database.query<{
      provisioned: number | null;
      deleted: number | null;
      metered: number | null;
      meter_rates: Record<string, number>;
    }>(
      `SELECT (extract(epoch FROM provisioned_at) * 1000)::float8 AS provisioned,
              (extract(epoch FROM deleted_at) * 1000)::float8 AS deleted,
              (extract(epoch FROM metered_until) * 1000)::float8 AS metered, meter_rates
         FROM cloud_resources WHERE id = $1`,
      [resourceId],
    )
  ).rows[0]!;
const create = (
  on: CloudResourcesWorld,
  extra: Record<string, unknown> = {},
): Promise<CloudResourceView> => {
  counter++;
  return on.api.cloudResources.create(on.acme, {
    tenantId: on.acmeTenant,
    poolId: on.poolId,
    kind: 'fake.database',
    name: `u${counter}`,
    spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', nodes: 2 },
    idempotencyKey: `uk-${counter}`,
    ...extra,
  });
};
const stateOf = async (on: CloudResourcesWorld, resourceId: string) =>
  (
    await on.fixture.database.query<{ state: string }>(
      `SELECT state FROM cloud_resources WHERE id = $1`,
      [resourceId],
    )
  ).rows[0]!.state;

beforeAll(async () => {
  world = await cloudResourcesWorld({ secrets: memorySecrets() });
  metered = await cloudResourcesWorld({
    secrets: memorySecrets(),
    kindMeters: ['fake.database.hours'],
  });
});
afterAll(closeFixtures);

describe('cloud.resource.hours', () => {
  it('bills the managed resource, not what lives in it: a child (a database user) bills no fee of its own', async () => {
    const parent = await create(world);
    const child = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      kind: 'fake.database-user',
      name: `child-${parent.id.slice(-6)}`,
      spec: { user: 'billing' },
      parentId: parent.id,
      idempotencyKey: `child-${parent.id}`,
    });
    await world.until(async () => (await stateOf(world, child.id)) === 'ready');
    // The child has its provider id, so it would count as provisioned.
    expect((await column(world, child.id)).provisioned).not.toBeNull();
    await world.fixture.advance(3 * hourMs);
    await world.tick('cloud.resources.usage', 1, graceMs);
    expect(total(await windows(world, parent.id, 'cloud.resource.hours'))).toBeGreaterThan(2);
    expect(await windows(world, child.id)).toEqual([]);
    // Its watermark still advances: it is never scanned for those hours again.
    expect((await column(world, child.id)).metered).not.toBeNull();
  });

  it('is a root meter of the catalog better-iam is given', () => {
    expect(
      meterCatalog({ gpuModels: [] }).find((meter) => meter.key === 'cloud.resource.hours'),
    ).toMatchObject({
      unit: 'hour',
      pricing: 'rate-card',
    });
  });

  it('meters a hosted resource from its creation at the provider until it is deleted', async () => {
    const resource = await create(world);
    await world.until(async () => (await stateOf(world, resource.id)) === 'ready');
    const provisioned = Number((await column(world, resource.id)).provisioned);
    await world.fixture.advance(3 * hourMs);
    await world.tick('cloud.resources.usage', 1, graceMs);
    const written = await windows(world, resource.id);
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const window of written)
      expect(window).toMatchObject({
        tenant_id: world.acmeTenant,
        meter: 'cloud.resource.hours',
        tags: {
          pool: world.poolId,
          region: 'nyc3',
          provider: 'fake-cloud',
          source: 'fake.database',
        },
      });
    expect(written[0]!.idempotency_key).toMatch(
      new RegExp(`^cmp:cloud-resource:${resource.id}:\\d+:cloud\\.resource\\.hours$`),
    );
    const covered = Math.floor((world.fixture.clock.now() - 5 * 60_000) / hourMs) * hourMs;
    expect(total(written)).toBeCloseTo((covered - provisioned) / hourMs, 4);
    // The kind's own meter is not written unless the operator names it in kindMeters.
    expect(written.every((window) => window.meter === 'cloud.resource.hours')).toBe(true);
    // A second pass writes nothing new.
    await world.tick('cloud.resources.usage', 1, 60_000);
    expect((await windows(world, resource.id)).length).toBe(written.length);

    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: resource.id,
    });
    await world.until(async () => (await stateOf(world, resource.id)) === 'deleted');
    await world.fixture.advance(4 * hourMs);
    await world.tick('cloud.resources.usage', 1, graceMs);
    const final = await column(world, resource.id);
    expect(final.metered).toBe(final.deleted);
    const all = await windows(world, resource.id);
    expect(total(all)).toBeCloseTo((Number(final.deleted) - provisioned) / hourMs, 4);
    expect(all.every((window) => new Date(window.window_start).getTime() < final.deleted!)).toBe(
      true,
    );
  });

  it('meters nothing on a pool whose billing mode is none, nor for a resource never accepted', async () => {
    const free = await world.api.pools.create(world.root, {
      tenantId: world.rootTenant,
      siteId: world.siteId,
      class: 'provider',
      providerAccountId: world.accountId,
      idempotencyKey: 'free-pool',
    });
    await world.fixture.database.query(
      `UPDATE pools SET policy = jsonb_set(coalesce(policy, '{}'::jsonb), '{billing}', '{"mode":"none"}'::jsonb)
        WHERE id = $1`,
      [free.id],
    );
    const unbilled = await world.api.cloudResources.create(world.root, {
      tenantId: world.rootTenant,
      poolId: free.id,
      kind: 'fake.database',
      name: 'unbilled',
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small' },
      idempotencyKey: 'unbilled',
    });
    await world.until(async () => (await stateOf(world, unbilled.id)) === 'ready');
    world.cloud.refuse.add('fake.app');
    const never = await create(world, {
      kind: 'fake.app',
      name: 'never',
      spec: { image: 'nginx' },
    });
    await world.until(async () => (await stateOf(world, never.id)) === 'error');
    world.cloud.refuse.clear();
    await world.fixture.advance(3 * hourMs);
    await world.tick('cloud.resources.usage', 1, graceMs);
    expect(await windows(world, unbilled.id)).toEqual([]);
    expect(await windows(world, never.id)).toEqual([]);
    // The unbilled resource's watermark still advanced.
    expect((await column(world, unbilled.id)).metered).not.toBeNull();
  });

  it("a tenant's own (BYO) account is metered too: the fee is better-compute's, not the provider's", async () => {
    const own = await create(world, { poolId: world.acmePoolId, name: 'own-db' });
    await world.until(async () => (await stateOf(world, own.id)) === 'ready');
    await world.fixture.advance(2 * hourMs);
    await world.tick('cloud.resources.usage', 1, graceMs);
    const written = await windows(world, own.id);
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written[0]!.tags.pool).toBe(world.acmePoolId);
  });
});

describe('kind meters (kindMeters)', () => {
  it('writes the sampled rate the provider reports for a named kind meter, and the rate follows the spec', async () => {
    const resource = await create(metered);
    await metered.until(async () => (await stateOf(metered, resource.id)) === 'ready');
    expect((await column(metered, resource.id)).meter_rates).toEqual({ 'fake.database.hours': 2 });
    await metered.fixture.advance(3 * hourMs);
    await metered.tick('cloud.resources.usage', 1, graceMs);
    const fee = await windows(metered, resource.id, 'cloud.resource.hours');
    const nodes = await windows(metered, resource.id, 'fake.database.hours');
    expect(nodes.length).toBe(fee.length);
    // Two nodes: twice the resource's hours.
    expect(total(nodes)).toBeCloseTo(2 * total(fee), 4);
    expect(nodes[0]!.idempotency_key).toMatch(/:fake\.database\.hours$/);

    // Scaled to three nodes: the next hours bill three per hour.
    await metered.api.cloudResources.update(metered.acme, {
      tenantId: metered.acmeTenant,
      resourceId: resource.id,
      spec: { nodes: 3 },
    });
    await metered.until(async () => (await stateOf(metered, resource.id)) === 'ready');
    expect((await column(metered, resource.id)).meter_rates).toEqual({ 'fake.database.hours': 3 });
    const before = (await windows(metered, resource.id, 'fake.database.hours')).length;
    await metered.fixture.advance(2 * hourMs);
    await metered.tick('cloud.resources.usage', 1, graceMs);
    const after = await windows(metered, resource.id, 'fake.database.hours');
    expect(after.length).toBeGreaterThan(before);
    expect(Number(after.at(-1)!.quantity)).toBeCloseTo(3, 4);
  });

  it('drops a meter the kind does not declare, and a rate that is not a finite non-negative number', async () => {
    metered.cloud.usageExtra = { 'fake.undeclared': 7, 'fake.database.hours': Number.NaN };
    try {
      const resource = await create(metered);
      await metered.until(async () => (await stateOf(metered, resource.id)) === 'ready');
      expect((await column(metered, resource.id)).meter_rates).toEqual({});
    } finally {
      delete metered.cloud.usageExtra;
    }
  });
});

describe('cloud-resources/0002_metering', () => {
  it('appends cloud-resource to the usage source CHECK, keeping a kind another module added before it', async () => {
    const fixture = await computeFixture({
      clock: 'sim',
      modules: [vps({ providers: [] }), kubernetes(), cloudResources()],
    });
    const { rows } = await fixture.database.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'usage_windows_source_kind_ck' AND conrelid = 'usage_windows'::regclass`,
    );
    expect(rows).toHaveLength(1);
    for (const kind of [
      'allocation',
      'instance',
      'grant',
      'network',
      'snapshot',
      'cost',
      'kubernetes',
      'cloud-resource',
    ])
      expect(rows[0]!.def).toContain(`'${kind}'`);
    expect(rows[0]!.def).toContain('NOT VALID');
  });

  it('keeps cloud-resource when kubernetes/0001 runs after it (cloudResources registered first)', async () => {
    const module = cloudResources();
    const fixture = await computeFixture({
      clock: 'sim',
      modules: [vps({ providers: [] }), module, kubernetes()],
    });
    const { rows } = await fixture.database.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'usage_windows_source_kind_ck' AND conrelid = 'usage_windows'::regclass`,
    );
    expect(rows).toHaveLength(1);
    for (const kind of ['instance', 'cost', 'kubernetes', 'cloud-resource'])
      expect(rows[0]!.def).toContain(`'${kind}'`);
    const findings = await module.selfCheck!({ sql: fixture.database } as never);
    expect(findings.map((finding) => finding.check)).not.toContain('cloud-resources.usage-source');
  });
});

describe('selfCheck', () => {
  it('reports a usage source CHECK that lost cloud-resource (a later migration replaced it)', async () => {
    const db = metered.fixture.database;
    const check = () =>
      metered.module.selfCheck!({ sql: db } as never).then((findings) =>
        findings.map((finding) => finding.check),
      );
    expect(await check()).not.toContain('cloud-resources.usage-source');
    await db.query(`ALTER TABLE usage_windows DROP CONSTRAINT usage_windows_source_kind_ck`);
    await db.query(
      `ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_kind_ck
         CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost')) NOT VALID`,
    );
    try {
      expect(await check()).toContain('cloud-resources.usage-source');
    } finally {
      await db.query(`ALTER TABLE usage_windows DROP CONSTRAINT usage_windows_source_kind_ck`);
      await db.query(
        `ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_kind_ck
           CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost',
                                  'cloud-resource')) NOT VALID`,
      );
    }
  });
});
