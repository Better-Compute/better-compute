import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, type AdmissionPolicyRequest } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  maxAuthzAttributes,
  placementAttributes,
  vpsQuotaCountsMigration,
} from '@better-compute/vps';
import { gceVm, gceWorld, type GceWorld } from './support/vps-gce.js';

// Admission for every caller (U-02) through the API, on a provider pool: the `instances` count, tenant-level (`*`)
// rows, flavor allowlists on the offer and on quota rows (create and attach), the host's admission policy inside
// the admission transaction, the IAM attributes poolId/flavor/region/provider/labels.<key>, and the backfill of
// `instances` rows that existed before the upgrade (vps/0048).

afterEach(closeFixtures);

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: ComputeError) => error,
  );

const createVm = (world: GceWorld, key: string, extra: Record<string, unknown> = {}) =>
  world.api.instances.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
    ...extra,
  });

async function settle(world: GceWorld, rounds = 3, ms = 1_000) {
  for (let round = 0; round < rounds; round++) {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  }
}

const setQuota = (
  world: GceWorld,
  poolId: string,
  resource: string,
  max: number,
  extra: object = {},
) =>
  world.api.quotas.set(world.root, { tenantId: world.acmeTenant, poolId, resource, max, ...extra });

async function quotaRow(world: GceWorld, poolId: string, resource: string) {
  const { rows } = await world.fixture.database.query<{ used: string; max: string }>(
    `SELECT used, max FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
    [world.acmeTenant, poolId, resource],
  );
  return rows[0] ? { used: Number(rows[0].used), max: Number(rows[0].max) } : undefined;
}

async function charged(world: GceWorld, instanceId: string) {
  const { rows } = await world.fixture.database.query<{
    quota_charged: Record<string, number> | null;
  }>(`SELECT quota_charged FROM instances WHERE id = $1`, [instanceId]);
  return rows[0]?.quota_charged ?? null;
}

const smallFlavor = (world: GceWorld) =>
  world.api.flavors.create(world.root, {
    tenantId: world.rootTenant,
    poolId: world.poolId,
    name: 'n2.small',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 20,
    gpus: 0,
    offerId: 'us-central1-a/n2-standard-2',
  });

describe('the instances count', () => {
  it('limits instances per pool where a row exists, records the charge, and refunds it on delete', async () => {
    const world = await gceWorld();
    // No row: nothing limits the count, and nothing is recorded for it.
    const free = await createVm(world, 'free');
    expect(await charged(world, free.id)).toEqual({
      vcpu: 12,
      memoryGiB: 85,
      diskGiB: 100,
      gpu: 1,
    });

    await setQuota(world, world.poolId, 'instances', 2);
    const first = await createVm(world, 'vm-1');
    expect(await charged(world, first.id)).toMatchObject({ instances: 1, gpu: 1 });
    await createVm(world, 'vm-2');
    expect(await failure(createVm(world, 'vm-3'))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'instances', poolId: world.poolId, scope: 'pool', max: 2, used: 2 },
    });
    await settle(world);
    await world.api.instances.delete(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: first.id,
    });
    await settle(world, 4, 30_000);
    expect(await quotaRow(world, world.poolId, 'instances')).toEqual({ used: 1, max: 2 });
    await createVm(world, 'vm-3');
  });

  it('a tenant-level row limits the total over every pool', async () => {
    const world = await gceWorld();
    await setQuota(world, '*', 'vcpu', 24);
    await setQuota(world, '*', 'instances', 5);
    await createVm(world, 'vm-1');
    await createVm(world, 'vm-2');
    expect(await failure(createVm(world, 'vm-3'))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'vcpu', poolId: '*', scope: 'tenant', max: 24, used: 24 },
    });
    const { items } = await world.api.quotas.get(world.acme, {
      tenantId: world.acmeTenant,
      poolId: '*',
    });
    expect(items).toEqual([
      {
        tenantId: world.acmeTenant,
        poolId: '*',
        resource: 'instances',
        max: 5,
        used: 2,
        available: 3,
      },
      {
        tenantId: world.acmeTenant,
        poolId: '*',
        resource: 'vcpu',
        max: 24,
        used: 24,
        available: 0,
      },
    ]);
    // The pool's own rows are unchanged by the refusal.
    expect(await quotaRow(world, world.poolId, 'vcpu')).toEqual({ used: 24, max: 512 });
  });
});

describe('flavor allowlists', () => {
  it('an offer that lists flavors refuses the others at create, until the list is cleared', async () => {
    const world = await gceWorld();
    await smallFlavor(world);
    const offered = await world.api.pools.offer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.acmeTenant,
      quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
      flavors: ['n2.small'],
    });
    expect(offered.flavors).toEqual(['n2.small']);
    const seen = await world.api.pools.get(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
    });
    expect(seen.flavors).toEqual(['n2.small']);
    expect(await failure(createVm(world, 'gpu'))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { reason: 'flavor-not-offered', flavor: 'a2.highgpu.1g', poolId: world.poolId },
    });
    await createVm(world, 'small', { flavor: 'n2.small' });
    // A re-offer without flavors keeps the list.
    await world.api.pools.offer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.acmeTenant,
      quota: { gpu: 16 },
    });
    expect(await failure(createVm(world, 'gpu'))).toMatchObject({
      details: { reason: 'flavor-not-offered' },
    });
    const cleared = await world.api.pools.updateOffer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.acmeTenant,
      flavors: null,
    });
    expect(cleared).not.toHaveProperty('flavors');
    await createVm(world, 'gpu');
  });

  it('a quota row that lists flavors refuses the others that would consume it', async () => {
    const world = await gceWorld();
    await smallFlavor(world);
    await setQuota(world, world.poolId, 'gpu', 16, { flavors: ['a3.8g'] });
    expect(await failure(createVm(world, 'gpu'))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { reason: 'flavor-not-allowed', resource: 'gpu', flavors: ['a3.8g'] },
    });
    // A flavor without GPUs does not consume the gpu row.
    await createVm(world, 'small', { flavor: 'n2.small' });
    await setQuota(world, world.poolId, 'gpu', 16, { flavors: ['a3.8g', 'a2.highgpu.1g'] });
    await createVm(world, 'gpu');
    const { items } = await world.api.quotas.get(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
    });
    expect(items.find((row: { resource: string }) => row.resource === 'gpu')).toMatchObject({
      flavors: ['a3.8g', 'a2.highgpu.1g'],
      used: 1,
    });
  });

  it('attach judges a machine by the flavor its type maps to', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    await world.discover(0);
    await world.api.pools.offer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.acmeTenant,
      quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16, instances: 3 },
      flavors: ['a2.highgpu.1g'],
    });
    const attach = (key: string) =>
      world.api.instances.attach(world.root, {
        tenantId: world.acmeTenant,
        poolId: world.poolId,
        externalId: 'us-central1-a/legacy',
        ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
        idempotencyKey: key,
      });
    // No flavor offers a3-highgpu-8g: the machine has no flavor, and the offer lists flavors.
    expect(await failure(attach('a'))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { reason: 'flavor-not-offered', flavor: null },
    });
    await world.api.flavors.create(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      name: 'a3.8g',
      vcpu: 208,
      memoryGiB: 1872,
      diskGiB: 100,
      gpus: 8,
      offerId: 'us-central1-a/a3-highgpu-8g',
    });
    expect(await failure(attach('b'))).toMatchObject({
      details: { reason: 'flavor-not-offered', flavor: 'a3.8g' },
    });
    await world.api.pools.updateOffer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.acmeTenant,
      flavors: ['a2.highgpu.1g', 'a3.8g'],
    });
    const attached = await attach('c');
    expect(await charged(world, attached.id)).toMatchObject({ instances: 1, gpu: 8 });
    expect(await quotaRow(world, world.poolId, 'instances')).toEqual({ used: 1, max: 3 });
    const { rows } = await world.fixture.database.query<{ attributes: Record<string, unknown> }>(
      `SELECT attributes FROM authz_projection WHERE type = 'instance' AND id = $1`,
      [attached.id],
    );
    expect(rows[0]!.attributes).toMatchObject({
      poolId: world.poolId,
      flavor: 'a3.8g',
      region: 'us-central1',
    });
  });
});

describe('the host admission policy', () => {
  it('runs inside the admission transaction for every caller, and refuses before anything is charged', async () => {
    const seen: AdmissionPolicyRequest[] = [];
    let draftVisible: boolean | undefined;
    const world = await gceWorld({
      admissionPolicy: async (tx, request) => {
        seen.push(request);
        const { rows } = await tx.query<{ draft: boolean }>(
          `SELECT draft FROM instances WHERE id = $1`,
          [request.instanceId],
        );
        draftVisible = rows[0]?.draft;
        if (request.labels?.env !== 'prod')
          throw new ComputeError('ACCESS_DENIED', 'Instances need the env=prod label', undefined, {
            reason: 'label-required',
          });
      },
    });
    expect(await failure(createVm(world, 'bare'))).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'label-required' },
    });
    expect(await quotaRow(world, world.poolId, 'vcpu')).toEqual({ used: 0, max: 512 });
    const vm = await createVm(world, 'prod', { labels: { env: 'prod', team: 'ml' } });
    expect(draftVisible).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      method: 'instances.create',
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      poolClass: 'provider',
      flavor: 'a2.highgpu.1g',
      shape: { vcpu: 12, memoryGiB: 85, diskGiB: 100, gpus: 1 },
      demand: { instances: 1, vcpu: 12, memoryGiB: 85, diskGiB: 100, gpu: 1 },
      region: 'us-central1',
      provider: 'fake-gce',
      labels: { env: 'prod', team: 'ml' },
      imageId: 'debian-12',
      instanceId: vm.id,
      ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
      admission: { tenantId: world.acmeTenant, action: 'compute:instances:create' },
    });
    // IAM decides on the same facts: poolId, flavor, region, provider and each label.
    const { rows } = await world.fixture.database.query<{ attributes: Record<string, unknown> }>(
      `SELECT attributes FROM authz_projection WHERE type = 'instance' AND id = $1`,
      [vm.id],
    );
    expect(rows[0]!.attributes).toMatchObject({
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      region: 'us-central1',
      provider: 'fake-gce',
      'labels.env': 'prod',
      'labels.team': 'ml',
      vcpu: 12,
      gpus: 1,
    });
  });
});

/** Runs vps/0048 again, statement by statement. */
async function backfill(world: GceWorld) {
  for (const statement of String(vpsQuotaCountsMigration.sql).split(';'))
    if (statement.trim()) await world.fixture.database.query(statement);
}

describe('vps/0048: instances rows that predate the count', () => {
  it('start at what is live, and the live instances record the count', async () => {
    const world = await gceWorld();
    const a = await createVm(world, 'a');
    const b = await createVm(world, 'b');
    // As before the upgrade: an offer row with an instances limit that nothing charged.
    await world.fixture.database.query(
      `INSERT INTO quota_usage (tenant_id, pool_id, resource, max, used) VALUES ($1, $2, 'instances', 1, 0)`,
      [world.acmeTenant, world.poolId],
    );
    await backfill(world);
    expect(await quotaRow(world, world.poolId, 'instances')).toEqual({ used: 2, max: 2 });
    for (const vm of [a, b])
      expect(await charged(world, vm.id)).toMatchObject({ instances: 1, vcpu: 12 });
    // Idempotent.
    await backfill(world);
    expect(await quotaRow(world, world.poolId, 'instances')).toEqual({ used: 2, max: 2 });
    expect(await failure(createVm(world, 'c'))).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await settle(world);
    await world.api.instances.delete(world.acme, { tenantId: world.acmeTenant, instanceId: a.id });
    await settle(world, 4, 30_000);
    expect(await quotaRow(world, world.poolId, 'instances')).toEqual({ used: 1, max: 2 });
  });
});

describe('IAM attributes of labels', () => {
  it('fit the 64 attributes of a row, in key order, and say when some did not', () => {
    const base = { vcpu: 2, memoryGiB: 4, gpus: 0, imageId: 'img', imageVerified: true };
    const few = placementAttributes(
      { poolId: 'pool_x', flavor: 'f', labels: { b: '2', a: '1' } },
      base,
    );
    expect(few).toEqual({
      ...base,
      poolId: 'pool_x',
      flavor: 'f',
      'labels.a': '1',
      'labels.b': '2',
    });
    const labels = Object.fromEntries(
      Array.from({ length: 62 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'v']),
    );
    const many = placementAttributes(
      { poolId: 'pool_x', flavor: 'f', region: 'eu', provider: 'gcp', labels },
      { ...base, projectId: 'prj' },
    );
    expect(Object.keys(many)).toHaveLength(maxAuthzAttributes);
    expect(many.labelsTruncated).toBe(true);
    expect(many['labels.k00']).toBe('v');
    expect(many['labels.k61']).toBeUndefined();
  });
});
