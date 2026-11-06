import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type Logger,
  type ProviderResourceKind,
  type ProviderResources,
  type ProviderResourceState,
} from '@better-compute/core';
import { cloudResources } from '@better-compute/cloud-resources';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import {
  defineProvider,
  readQuotaBooking,
  releaseQuotaBooking,
  setQuotaBooking,
  vps,
} from '@better-compute/vps';

// External quota bookings (DigitalOcean P8, task 1): a cloud resource whose kind declares `quota(spec)` (a dedicated
// inference endpoint's GPUs) holds that much of the tenant's capacity quota on its pool, without a node: booked when
// the resource is recorded, re-booked by the difference when its spec changes, returned once it is deleted. The
// booking ledger (`quota_bookings`, vps/0108) makes each step idempotent, so a retried release never refunds twice.

type Api = any;

const gpuKind: ProviderResourceKind = {
  kind: 'fake.gpu-endpoint',
  family: 'ai',
  description: 'An inference endpoint on dedicated GPUs',
  spec: manifest({
    region: field.option(['nyc3']).describe('Region'),
    gpusPerReplica: field.int({ min: 1, max: 8 }).describe('GPUs per replica'),
    replicas: field.int({ min: 1, max: 8 }).default(1).describe('Replicas'),
  }),
  outputs: ['url'],
  regional: true,
  updatable: ['replicas'],
  quota: (spec) => {
    const { gpusPerReplica, replicas } = spec as { gpusPerReplica: number; replicas: number };
    return { gpu: gpusPerReplica * replicas };
  },
};

interface Endpoint {
  id: string;
  spec: Record<string, unknown>;
  deleted: boolean;
}

function gpuCloud() {
  const endpoints = new Map<string, Endpoint>();
  const calls: string[] = [];
  let next = 0;
  const state = (endpoint: Endpoint): ProviderResourceState => ({
    id: endpoint.id,
    state: 'ready',
    outputs: { url: `https://${endpoint.id}.inference.fake` },
    spec: { ...endpoint.spec },
  });
  const resources: ProviderResources = {
    kinds: () => [gpuKind],
    async ensure(request, context) {
      calls.push(`ensure ${request.kind}`);
      let endpoint =
        (request.id !== undefined ? endpoints.get(request.id) : undefined) ??
        [...endpoints.values()].find((entry) => entry.id === context.idempotencyKey);
      if (!endpoint) {
        endpoint = { id: `ep-${++next}`, spec: { ...(request.spec as object) }, deleted: false };
        endpoints.set(endpoint.id, endpoint);
      }
      endpoint.spec = { ...(request.spec as object) };
      return state(endpoint);
    },
    async get(_kind, id) {
      const endpoint = endpoints.get(id);
      return endpoint && !endpoint.deleted ? state(endpoint) : undefined;
    },
    async delete(_kind, id) {
      calls.push(`delete ${id}`);
      const endpoint = endpoints.get(id);
      if (endpoint) endpoint.deleted = true;
      return { id, state: 'deleted' };
    },
    async *discover() {
      for (const endpoint of endpoints.values())
        if (!endpoint.deleted) yield { id: endpoint.id, name: endpoint.id, spec: endpoint.spec };
    },
    async adopt(_kind, id) {
      return state(endpoints.get(id)!);
    },
    async release() {},
  };
  const anyConfig = {
    '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
  };
  const provider = defineProvider({
    id: 'fake-gpu',
    version: '1.0.0',
    provides: ['vps'],
    config: anyConfig as never,
    create: () => ({
      async listOffers() {
        return [];
      },
      async create() {
        throw new ComputeError('UNSUPPORTED', 'unused');
      },
      async get() {
        return undefined;
      },
      async delete() {},
      resources,
    }),
  });
  return { provider, endpoints, calls };
}

let fixture: ComputeFixture;
let api: Api;
let cloud: ReturnType<typeof gpuCloud>;
let acme: { token: string };
let acmeTenant: string;
let poolId: string;
let ownPoolId: string;
let counter = 0;

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} } as Logger;

async function used(pool = poolId): Promise<number> {
  const { rows } = await fixture.database.query<{ used: string | number }>(
    `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu'`,
    [acmeTenant, pool],
  );
  return Number(rows[0]?.used ?? 0);
}

const get = (resourceId: string) =>
  api.cloudResources.get(acme, { tenantId: acmeTenant, resourceId });
async function until(resourceId: string, state: string) {
  for (let round = 0; round < 12; round++) {
    await fixture.advance(10_000);
    await fixture.compute.jobs['cloud.resources']!.tick();
    if ((await get(resourceId)).state === state) return;
  }
  throw new Error(`${resourceId} never reached ${state}`);
}
const create = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  counter++;
  return api.cloudResources.create(acme, {
    tenantId: acmeTenant,
    poolId,
    kind: 'fake.gpu-endpoint',
    name: `ep${counter}`,
    spec: { region: 'nyc3', ...spec },
    idempotencyKey: `ep-${counter}`,
    ...extra,
  });
};

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

beforeAll(async () => {
  cloud = gpuCloud();
  fixture = await computeFixture({
    clock: 'sim',
    log: quiet,
    modules: [
      vps({ providers: [cloud.provider] }),
      cloudResources({ providers: [cloud.provider] }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  api = compute.api as Api;
  const root = { token: tenants.root.token };
  acme = { token: tenants.acme.token };
  acmeTenant = tenants.acme.id;
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-gpu',
    name: 'gpu-main',
    config: { regions: ['nyc3'] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'nyc3',
    idempotencyKey: 'gpu-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'gpu-pool',
  });
  poolId = pool.id;
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId,
    toTenantId: acmeTenant,
    quota: { vcpu: 8, memoryGiB: 32, diskGiB: 100, gpu: 4 },
  });
  // acme's own account and pool, to try an adoption.
  const own = await api.providerAccounts.create(acme, {
    tenantId: acmeTenant,
    provider: 'fake-gpu',
    name: 'acme-gpu',
    config: { regions: ['nyc3'] },
  });
  const ownSite = await api.sites.create(acme, {
    tenantId: acmeTenant,
    kind: 'custom',
    region: 'nyc3',
    idempotencyKey: 'acme-gpu-site',
  });
  const ownPool = await api.pools.create(acme, {
    tenantId: acmeTenant,
    siteId: ownSite.id,
    class: 'provider',
    providerAccountId: own.id,
    idempotencyKey: 'acme-gpu-pool',
  });
  ownPoolId = ownPool.id;
});
afterAll(closeFixtures);

describe('external quota bookings of cloud resources', () => {
  it('a create books the GPUs its spec declares; one over the quota is refused before anything is recorded', async () => {
    expect(await used()).toBe(0);
    const endpoint = await create({ gpusPerReplica: 2, replicas: 1 });
    expect(await used()).toBe(2);
    await until(endpoint.id, 'ready');
    expect(await used()).toBe(2);

    const calls = cloud.calls.length;
    const refused = await failure(create({ gpusPerReplica: 2, replicas: 2 }));
    expect(refused.code).toBe('QUOTA_EXCEEDED');
    expect(refused.details).toMatchObject({ resource: 'gpu', requested: 4, max: 4, used: 2 });
    expect(await used()).toBe(2);
    const { items } = await api.cloudResources.list(acme, { tenantId: acmeTenant, poolId });
    expect(items).toHaveLength(1);
    expect(cloud.calls.length).toBe(calls);

    // A retried create under the same key replays: the GPUs are booked once.
    const replay = await api.cloudResources.create(acme, {
      tenantId: acmeTenant,
      poolId,
      kind: 'fake.gpu-endpoint',
      name: endpoint.name,
      spec: { region: 'nyc3', gpusPerReplica: 2, replicas: 1 },
      idempotencyKey: `ep-1`,
    });
    expect(replay.id).toBe(endpoint.id);
    expect(await used()).toBe(2);

    await api.cloudResources.delete(acme, { tenantId: acmeTenant, resourceId: endpoint.id });
    // Held until the provider resource is gone, then returned.
    expect(await used()).toBe(2);
    await until(endpoint.id, 'deleted');
    expect(await used()).toBe(0);
  });

  it('a spec change books the difference: more is refused over the quota, less is returned', async () => {
    const endpoint = await create({ gpusPerReplica: 1, replicas: 1 });
    await until(endpoint.id, 'ready');
    expect(await used()).toBe(1);
    await api.cloudResources.update(acme, {
      tenantId: acmeTenant,
      resourceId: endpoint.id,
      spec: { replicas: 3 },
    });
    expect(await used()).toBe(3);
    const refused = await failure(
      api.cloudResources.update(acme, {
        tenantId: acmeTenant,
        resourceId: endpoint.id,
        spec: { replicas: 5 },
      }),
    );
    expect(refused.code).toBe('QUOTA_EXCEEDED');
    expect((await get(endpoint.id)).spec.replicas).toBe(3);
    expect(await used()).toBe(3);
    await api.cloudResources.update(acme, {
      tenantId: acmeTenant,
      resourceId: endpoint.id,
      spec: { replicas: 2 },
    });
    expect(await used()).toBe(2);
    // A description change books nothing.
    await api.cloudResources.update(acme, {
      tenantId: acmeTenant,
      resourceId: endpoint.id,
      description: 'chat model',
    });
    expect(await used()).toBe(2);
    await until(endpoint.id, 'ready');
    await api.cloudResources.delete(acme, { tenantId: acmeTenant, resourceId: endpoint.id });
    await until(endpoint.id, 'deleted');
    expect(await used()).toBe(0);
  });

  it('a kind that books quota cannot be adopted: its spec is not known until the takeover', async () => {
    const seeded = await cloud.provider.create({}, {} as never);
    const made = await seeded.resources!.ensure(
      {
        kind: 'fake.gpu-endpoint',
        name: 'by-hand',
        spec: { region: 'nyc3', gpusPerReplica: 1, replicas: 1 },
      },
      { idempotencyKey: 'by-hand' } as never,
    );
    const refused = await failure(
      api.cloudResources.adopt(acme, {
        tenantId: acmeTenant,
        poolId: ownPoolId,
        kind: 'fake.gpu-endpoint',
        providerId: made.id,
        name: 'taken',
        idempotencyKey: 'adopt-gpu',
      }),
    );
    expect(refused.code).toBe('UNSUPPORTED');
    expect(refused.details).toMatchObject({ reason: 'quotaBooked' });
  });
});

describe('quota bookings (vps)', () => {
  it('book, re-book and release are idempotent per owner; a release never refunds twice', async () => {
    const owner = { kind: 'test-owner', id: 'o-1' };
    const at = { tenantId: acmeTenant, poolId };
    await fixture.database.transaction(async (tx) => {
      await setQuotaBooking(tx, owner, at, { gpu: 1 });
      await setQuotaBooking(tx, owner, at, { gpu: 1 });
    });
    expect(await used()).toBe(1);
    expect(await fixture.database.transaction((tx) => readQuotaBooking(tx, owner))).toMatchObject({
      tenantId: acmeTenant,
      poolId,
      resources: { gpu: 1 },
      released: false,
    });
    await fixture.database.transaction((tx) => setQuotaBooking(tx, owner, at, { gpu: 3 }));
    expect(await used()).toBe(3);
    // All-or-nothing: a booking over the quota changes nothing.
    await expect(
      fixture.database.transaction((tx) => setQuotaBooking(tx, owner, at, { gpu: 9 })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await used()).toBe(3);
    await fixture.database.transaction(async (tx) => {
      await releaseQuotaBooking(tx, owner);
      await releaseQuotaBooking(tx, owner);
    });
    expect(await used()).toBe(0);
    expect(
      (await fixture.database.transaction((tx) => readQuotaBooking(tx, owner)))?.released,
    ).toBe(true);
    // Releasing an owner that never booked is a no-op.
    await fixture.database.transaction((tx) =>
      releaseQuotaBooking(tx, { kind: 'test-owner', id: 'never' }),
    );
  });

  it('refuses an owner kind or a demand that is not well formed', async () => {
    const at = { tenantId: acmeTenant, poolId };
    await expect(
      fixture.database.transaction((tx) =>
        setQuotaBooking(tx, { kind: 'Bad Kind', id: 'x' }, at, { gpu: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const demand of [{ gpu: -1 }, { gpu: 1.5 }, { gpu: Number.NaN }])
      await expect(
        fixture.database.transaction((tx) =>
          setQuotaBooking(tx, { kind: 'test-owner', id: 'bad' }, at, demand),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
