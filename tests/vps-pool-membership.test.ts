import { afterEach, describe, expect, it } from 'vitest';
import { apiSurface, type ProviderDefinition, type ProviderImpl } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { maxInstanceLabels } from '@better-compute/vps';
import {
  fakeGceProvider,
  gceVm,
  gceWorld,
  type FakeGce,
  type GceWorld,
} from './support/vps-gce.js';

// Pool membership: the platform (or the provider account's own tenant) binds discovered machines to
// a provider pool (pools.bindMachines), tenants the pool is offered to see them (pools.machines) and
// attach them, and a machine detached or deleted from its instance goes back to its pool. Also the
// tenant's labels on instances.create, passed to the provider's create.

afterEach(closeFixtures);

const LEGACY = 'us-central1-a/legacy';
const SPARE = 'us-central1-a/spare';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

async function world(options: Parameters<typeof gceWorld>[0] = {}): Promise<GceWorld> {
  const w = await gceWorld({ discovery: { every: '1m' }, ...options });
  w.cloud.machines.set(LEGACY, gceVm('legacy'));
  w.cloud.machines.set(SPARE, gceVm('spare'));
  await w.discover(0);
  return w;
}

/** Room in a pool for root's own instances (an owner's quota rows start with `gpu` only). */
async function rootQuota(w: GceWorld, poolId: string): Promise<void> {
  for (const [resource, max] of Object.entries({ vcpu: 4096, memoryGiB: 65_536, diskGiB: 100_000 }))
    await w.api.quotas.set(w.root, { tenantId: w.rootTenant, poolId, resource, max });
}

/** A second provider pool on the same account (another site), owned by root and not offered. */
async function secondPool(w: GceWorld, region = 'us-east1'): Promise<string> {
  const site = await w.api.sites.create(w.root, {
    tenantId: w.rootTenant,
    kind: 'shared',
    region,
    idempotencyKey: `site-${region}`,
  });
  const pool = await w.api.pools.create(w.root, {
    tenantId: w.rootTenant,
    siteId: site.id,
    class: 'provider',
    providerAccountId: w.accountId,
    idempotencyKey: `pool-${region}`,
  });
  await rootQuota(w, pool.id);
  return pool.id;
}

const bind = (w: GceWorld, externalIds: string[], poolId = w.poolId, who = w.root) =>
  w.api.pools.bindMachines(who, { tenantId: w.rootTenant, poolId, externalIds });

async function poolOf(w: GceWorld, externalId: string, accountId = w.accountId) {
  const { rows } = await w.fixture.database.query<{
    pool_id: string | null;
    instance_id: string | null;
  }>(
    `SELECT pool_id, instance_id FROM provider_machines WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId],
  );
  return rows[0];
}

const attachAs = (w: GceWorld, who: { token: string }, extra: Record<string, unknown> = {}) =>
  w.api.instances.attach(who, {
    tenantId: w.acmeTenant,
    poolId: w.poolId,
    externalId: LEGACY,
    idempotencyKey: 'attach-legacy',
    ...extra,
  });

/** A few instance reconciler steps, a second of sim time apart. */
const settle = async (w: GceWorld, rounds = 3) => {
  for (let round = 0; round < rounds; round++) await step(w);
};

/** One instance reconciler step after `ms` of sim time. */
const step = async (w: GceWorld, ms = 1_000) => {
  await w.fixture.advance(ms);
  await w.tick('vps.instances', 1);
};

describe('pools.bindMachines', () => {
  it('binds free machines, publishes the event, and skips each machine it cannot bind', async () => {
    const w = await world();
    const other = await secondPool(w);
    w.cloud.machines.set('us-central1-a/going', gceVm('going'));
    w.cloud.machines.set('us-central1-a/dying', gceVm('dying', { state: 'deleting' }));
    w.cloud.machines.set('us-central1-a/elsewhere', gceVm('elsewhere'));
    w.cloud.machines.set('us-central1-a/held', gceVm('held'));
    await w.discover();
    // Gone: discovery no longer sees it.
    w.cloud.machines.delete('us-central1-a/going');
    await w.discover();
    // Bound elsewhere: to the second pool.
    expect(await bind(w, ['us-central1-a/elsewhere'], other)).toEqual({
      bound: ['us-central1-a/elsewhere'],
      skipped: [],
    });
    // Held: attached to an instance of the second pool.
    await w.api.instances.attach(w.root, {
      tenantId: w.rootTenant,
      poolId: other,
      externalId: 'us-central1-a/held',
      idempotencyKey: 'held',
    });

    const result = await bind(w, [
      LEGACY,
      'us-central1-a/going',
      'us-central1-a/dying',
      'us-central1-a/elsewhere',
      'us-central1-a/held',
      'us-central1-a/never-seen',
      LEGACY,
    ]);
    expect(result).toEqual({
      bound: [LEGACY],
      skipped: [
        { externalId: 'us-central1-a/going', reason: 'gone' },
        { externalId: 'us-central1-a/dying', reason: 'deleting' },
        { externalId: 'us-central1-a/elsewhere', reason: 'bound-elsewhere' },
        { externalId: 'us-central1-a/held', reason: 'held' },
        { externalId: 'us-central1-a/never-seen', reason: 'not-found' },
      ],
    });
    expect((await poolOf(w, LEGACY))?.pool_id).toBe(w.poolId);
    expect((await poolOf(w, 'us-central1-a/held'))?.pool_id).toBeNull();
    const events = (await w.events('pool.machines.')).filter(
      (event) => event.data.poolId === w.poolId,
    );
    expect(events).toEqual([
      {
        type: 'pool.machines.bound',
        tenantId: w.rootTenant,
        data: { poolId: w.poolId, accountId: w.accountId, externalIds: [LEGACY] },
      },
    ]);
  });

  it('rebinding is idempotent: listed as bound, no second event', async () => {
    const w = await world();
    expect(await bind(w, [LEGACY])).toEqual({ bound: [LEGACY], skipped: [] });
    expect(await bind(w, [LEGACY, SPARE])).toEqual({ bound: [LEGACY, SPARE], skipped: [] });
    expect(await bind(w, [LEGACY, SPARE])).toEqual({ bound: [LEGACY, SPARE], skipped: [] });
    expect((await w.events('pool.machines.bound')).map((event) => event.data.externalIds)).toEqual([
      [LEGACY],
      [SPARE],
    ]);
    // A discovery pass keeps the binding.
    await w.discover();
    expect((await poolOf(w, LEGACY))?.pool_id).toBe(w.poolId);
  });

  it('a binding to an archived pool counts as none', async () => {
    const w = await world();
    const other = await secondPool(w);
    await bind(w, [LEGACY], other);
    await w.api.pools.archive(w.root, { tenantId: w.rootTenant, poolId: other });
    expect(await bind(w, [LEGACY])).toEqual({ bound: [LEGACY], skipped: [] });
    expect((await poolOf(w, LEGACY))?.pool_id).toBe(w.poolId);
    expect((await attachAs(w, w.acme)).poolId).toBe(w.poolId);
  });

  it('a machine held by an instance of the same pool can be bound', async () => {
    const w = await world();
    await attachAs(w, w.root);
    expect(await bind(w, [LEGACY])).toEqual({ bound: [LEGACY], skipped: [] });
  });

  it('unbinds, skipping machines it never saw or that another pool holds', async () => {
    const w = await world();
    const other = await secondPool(w);
    await bind(w, [LEGACY]);
    await bind(w, [SPARE], other);
    const result = await w.api.pools.unbindMachines(w.root, {
      tenantId: w.rootTenant,
      poolId: w.poolId,
      externalIds: [LEGACY, SPARE, 'us-central1-a/never-seen'],
    });
    expect(result).toEqual({
      unbound: [LEGACY],
      skipped: [
        { externalId: SPARE, reason: 'bound-elsewhere' },
        { externalId: 'us-central1-a/never-seen', reason: 'not-found' },
      ],
    });
    expect((await poolOf(w, LEGACY))?.pool_id).toBeNull();
    expect((await poolOf(w, SPARE))?.pool_id).toBe(other);
    expect((await w.events('pool.machines.unbound')).map((event) => event.data)).toEqual([
      { poolId: w.poolId, accountId: w.accountId, externalIds: [LEGACY] },
    ]);
    // Unbinding again is a no-op.
    expect(
      await w.api.pools.unbindMachines(w.root, {
        tenantId: w.rootTenant,
        poolId: w.poolId,
        externalIds: [LEGACY],
      }),
    ).toEqual({ unbound: [LEGACY], skipped: [] });
    expect(await w.events('pool.machines.unbound')).toHaveLength(1);
  });

  it('refuses input outside the limits', async () => {
    const w = await world();
    expect(await code(bind(w, []))).toBe('INVALID_INPUT');
    expect(
      await code(
        bind(
          w,
          Array.from({ length: 101 }, (_, index) => `us-central1-a/vm-${index}`),
        ),
      ),
    ).toBe('INVALID_INPUT');
    expect(await code(bind(w, ['not an id']))).toBe('INVALID_INPUT');
  });

  it('the api surface has the rows, contributed by vps to the pools group', () => {
    const rows = apiSurface.filter(
      (row) =>
        row.group === 'pools' &&
        ['bindMachines', 'unbindMachines', 'machines'].includes(row.method),
    );
    expect(rows.map((row) => [row.method, row.action, row.resource, row.kind, row.module])).toEqual(
      [
        ['bindMachines', 'compute:pools:manage', 'pool', 'mutation', 'vps'],
        ['unbindMachines', 'compute:pools:manage', 'pool', 'mutation', 'vps'],
        ['machines', 'compute:pools:read', 'pool', 'read', 'vps'],
      ],
    );
  });
});

describe('attach and pool membership', () => {
  it('refuses a machine bound to another pool', async () => {
    const w = await world();
    const other = await secondPool(w);
    await bind(w, [LEGACY], other);
    await expect(attachAs(w, w.root)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { poolId: other },
    });
    expect((await poolOf(w, LEGACY))?.instance_id).toBeNull();
  });

  it('a tenant the pool is offered to attaches a machine bound to it, and only such a machine', async () => {
    const w = await world();
    // Not bound: refused as before.
    expect(await code(attachAs(w, w.acme))).toBe('ACCESS_DENIED');
    // Never seen, from acme: the same answer, so nothing is learnt about the account.
    expect(
      await code(attachAs(w, w.acme, { externalId: 'us-central1-a/nope', idempotencyKey: 'nope' })),
    ).toBe('ACCESS_DENIED');
    await bind(w, [LEGACY]);
    const instance = await attachAs(w, w.acme);
    expect(instance).toMatchObject({
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      origin: 'attached',
      externalId: LEGACY,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
    });
    expect(await poolOf(w, LEGACY)).toEqual({ pool_id: w.poolId, instance_id: instance.id });
    // Still only into itself: acme naming another tenant is refused by the envelope.
    expect(
      await code(
        attachAs(w, w.acme, {
          tenantId: w.fixture.tenants.other.id,
          externalId: SPARE,
          idempotencyKey: 'into-other',
        }),
      ),
    ).toBe('ACCESS_DENIED');
  });

  it('detach and delete leave the machine in its pool, free for the next attach', async () => {
    const w = await world();
    await bind(w, [LEGACY, SPARE]);
    const first = await attachAs(w, w.acme);
    await step(w);
    await w.api.instances.detach(w.acme, { tenantId: w.acmeTenant, instanceId: first.id });
    await step(w);
    expect(await poolOf(w, LEGACY)).toEqual({ pool_id: w.poolId, instance_id: null });
    const free = await w.api.pools.machines(w.acme, { tenantId: w.acmeTenant, poolId: w.poolId });
    expect(free.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      LEGACY,
      SPARE,
    ]);
    // Deleting an attached instance (onDelete: detach) does the same.
    await w.discover();
    const second = await attachAs(w, w.acme, { idempotencyKey: 'attach-legacy-2' });
    await step(w);
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: second.id });
    await step(w);
    expect(await poolOf(w, LEGACY)).toEqual({ pool_id: w.poolId, instance_id: null });
    expect(w.cloud.machines.get(LEGACY)).toMatchObject({ state: 'running', labels: {} });
  });

  it('checks the region only for Compute Engine accounts', async () => {
    const gcp: FakeGce = { machines: new Map(), requests: [] };
    const w = await world({ providers: [fakeGceProvider(gcp, 'gcp')] });
    const account = await w.api.providerAccounts.create(w.root, {
      tenantId: w.rootTenant,
      provider: 'gcp',
      name: 'gcp-real',
      config: {},
    });
    const site = await w.api.sites.create(w.root, {
      tenantId: w.rootTenant,
      kind: 'shared',
      region: 'us-central1',
      idempotencyKey: 'gcp-site',
    });
    const pool = await w.api.pools.create(w.root, {
      tenantId: w.rootTenant,
      siteId: site.id,
      class: 'provider',
      providerAccountId: account.id,
      idempotencyKey: 'gcp-pool',
    });
    await rootQuota(w, pool.id);
    const europe = (name: string) =>
      gceVm(name, { id: `europe-west4-a/${name}`, region: 'europe-west4', zone: 'europe-west4-a' });
    gcp.machines.set('europe-west4-a/eu', europe('eu'));
    gcp.machines.set('us-central1-a/local', gceVm('local'));
    // A machine that only knows its zone: its region is the zone's.
    gcp.machines.set('europe-west4-a/zoned', { ...europe('zoned'), region: undefined } as never);
    w.cloud.machines.set('europe-west4-a/far', europe('far'));
    await w.discover();

    expect(
      await w.api.pools.bindMachines(w.root, {
        tenantId: w.rootTenant,
        poolId: pool.id,
        externalIds: ['europe-west4-a/eu', 'europe-west4-a/zoned', 'us-central1-a/local'],
      }),
    ).toEqual({
      bound: ['us-central1-a/local'],
      skipped: [
        { externalId: 'europe-west4-a/eu', reason: 'other-region' },
        { externalId: 'europe-west4-a/zoned', reason: 'other-region' },
      ],
    });
    await expect(
      w.api.instances.attach(w.root, {
        tenantId: w.rootTenant,
        poolId: pool.id,
        externalId: 'europe-west4-a/eu',
        idempotencyKey: 'eu',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { machineRegion: 'europe-west4', poolRegion: 'us-central1' },
    });
    expect(
      (
        await w.api.instances.attach(w.root, {
          tenantId: w.rootTenant,
          poolId: pool.id,
          externalId: 'us-central1-a/local',
          idempotencyKey: 'local',
        })
      ).origin,
    ).toBe('attached');
    // Other providers' sites name regions freely: not compared.
    expect(await bind(w, ['europe-west4-a/far'])).toEqual({
      bound: ['europe-west4-a/far'],
      skipped: [],
    });
    expect(
      (
        await w.api.instances.attach(w.root, {
          tenantId: w.acmeTenant,
          poolId: w.poolId,
          externalId: 'europe-west4-a/far',
          idempotencyKey: 'far',
        })
      ).origin,
    ).toBe('attached');
  });
});

describe('pools.machines and isolation', () => {
  it('lists the pool’s machines to tenants it is offered to, without other tenants’ instances', async () => {
    const w = await world();
    w.cloud.machines.set('us-central1-a/roots', gceVm('roots'));
    w.cloud.machines.set('us-central1-a/unbound', gceVm('unbound'));
    await w.discover();
    await bind(w, [LEGACY, SPARE, 'us-central1-a/roots']);
    await rootQuota(w, w.poolId);
    // Root keeps one for itself; acme attaches another.
    const roots = await w.api.instances.attach(w.root, {
      tenantId: w.rootTenant,
      poolId: w.poolId,
      externalId: 'us-central1-a/roots',
      idempotencyKey: 'roots',
    });
    const mine = await attachAs(w, w.acme);

    const all = await w.api.pools.machines(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      filter: 'all',
    });
    const byId = Object.fromEntries(
      all.items.map((machine: { externalId: string }) => [machine.externalId, machine]),
    );
    expect(Object.keys(byId)).toEqual([LEGACY, 'us-central1-a/roots', SPARE]);
    expect(byId[LEGACY]).toMatchObject({
      instanceId: mine.id,
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    // Root's instance is not named to acme, and acme is not shown the account.
    expect(byId['us-central1-a/roots'].instanceId).toBeUndefined();
    expect(byId['us-central1-a/roots'].tenantId).toBeUndefined();
    for (const machine of all.items) expect(machine.accountId).toBeUndefined();
    expect(all.discoveredAt).toEqual(expect.any(Number));

    const free = await w.api.pools.machines(w.acme, { tenantId: w.acmeTenant, poolId: w.poolId });
    expect(free.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      SPARE,
    ]);
    const attached = await w.api.pools.machines(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      filter: 'attached',
      limit: 1,
    });
    expect(attached.items).toHaveLength(1);
    expect(attached.cursor).toEqual(expect.any(String));
    const next = await w.api.pools.machines(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      filter: 'attached',
      limit: 1,
      cursor: attached.cursor,
    });
    expect(next.items.map((machine: { externalId: string }) => machine.externalId)).toEqual([
      'us-central1-a/roots',
    ]);
    expect(next.cursor).toBeUndefined();

    // The platform sees everything, and the owner's account view shows the binding.
    const platform = await w.api.pools.machines(w.root, {
      tenantId: w.rootTenant,
      poolId: w.poolId,
      filter: 'all',
    });
    expect(
      platform.items.find(
        (machine: { externalId: string }) => machine.externalId === 'us-central1-a/roots',
      ),
    ).toMatchObject({ instanceId: roots.id, tenantId: w.rootTenant, accountId: w.accountId });
    const account = await w.api.providerAccounts.machines(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
      filter: 'all',
    });
    const poolIds = Object.fromEntries(
      account.items.map((machine: { externalId: string; poolId?: string }) => [
        machine.externalId,
        machine.poolId ?? null,
      ]),
    );
    expect(poolIds).toMatchObject({ [SPARE]: w.poolId, 'us-central1-a/unbound': null });
  });

  it('keeps tenants apart: only the platform or the account’s tenant binds, offered tenants only read', async () => {
    const w = await world();
    const { other } = w.fixture.tenants;
    w.fixture.iam.allow({ token: other.token });
    const asOther = { token: other.token };
    // acme is offered the pool: it reads, but does not bind or unbind.
    expect(await code(bind(w, [LEGACY], w.poolId, w.acme))).toBe('ACCESS_DENIED');
    expect(
      await code(
        w.api.pools.bindMachines(w.acme, {
          tenantId: w.acmeTenant,
          poolId: w.poolId,
          externalIds: [LEGACY],
        }),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await code(
        w.api.pools.unbindMachines(w.acme, {
          tenantId: w.acmeTenant,
          poolId: w.poolId,
          externalIds: [LEGACY],
        }),
      ),
    ).toBe('ACCESS_DENIED');
    expect((await poolOf(w, LEGACY))?.pool_id).toBeNull();
    // A tenant the pool is not offered to sees no pool at all.
    expect(
      await code(w.api.pools.machines(asOther, { tenantId: other.id, poolId: w.poolId })),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        w.api.pools.bindMachines(asOther, {
          tenantId: other.id,
          poolId: w.poolId,
          externalIds: [LEGACY],
        }),
      ),
    ).toBe('NOT_FOUND');
    await bind(w, [LEGACY]);
    expect(
      await code(
        w.api.instances.attach(asOther, {
          tenantId: other.id,
          poolId: w.poolId,
          externalId: LEGACY,
          idempotencyKey: 'steal',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect((await poolOf(w, LEGACY))?.instance_id).toBeNull();
  });

  it('refuses a pool that is not a provider pool', async () => {
    const w = await world();
    const site = await w.api.sites.create(w.root, {
      tenantId: w.rootTenant,
      kind: 'shared',
      region: 'eu',
      idempotencyKey: 'hosted-site',
    });
    const hosted = await w.api.pools.create(w.root, {
      tenantId: w.rootTenant,
      siteId: site.id,
      class: 'vps-host',
      idempotencyKey: 'hosted',
    });
    expect(await code(bind(w, [LEGACY], hosted.id))).toBe('INVALID_INPUT');
  });
});

// --- Instance labels ---------------------------------------------------------------------------

/** A fake-gce provider that also records what each `create` was asked for. */
function recordingProvider(cloud: FakeGce, seen: { labels?: Readonly<Record<string, string>> }[]) {
  const inner = fakeGceProvider(cloud, 'fake-labels');
  return {
    ...inner,
    create: async (...args: Parameters<ProviderDefinition['create']>) => {
      const impl = (await inner.create(...args)) as ProviderImpl;
      return {
        ...impl,
        async create(request, call) {
          seen.push({ ...(request.labels ? { labels: request.labels } : {}) });
          return impl.create(request, call);
        },
      } satisfies ProviderImpl;
    },
  } as ProviderDefinition;
}

async function labelWorld() {
  const cloud: FakeGce = { machines: new Map(), requests: [] };
  const seen: { labels?: Readonly<Record<string, string>> }[] = [];
  const w = await gceWorld({ providers: [recordingProvider(cloud, seen)] });
  const account = await w.api.providerAccounts.create(w.root, {
    tenantId: w.rootTenant,
    provider: 'fake-labels',
    name: 'labels',
    config: {},
  });
  const site = await w.api.sites.create(w.root, {
    tenantId: w.rootTenant,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'labels-site',
  });
  const pool = await w.api.pools.create(w.root, {
    tenantId: w.rootTenant,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'labels-pool',
  });
  await w.api.pools.offer(w.root, {
    tenantId: w.rootTenant,
    poolId: pool.id,
    toTenantId: w.acmeTenant,
    quota: { vcpu: 64, memoryGiB: 512, diskGiB: 1000, gpu: 4 },
  });
  await w.api.flavors.create(w.root, {
    tenantId: w.rootTenant,
    poolId: pool.id,
    name: 'a2.highgpu.1g',
    vcpu: 12,
    memoryGiB: 85,
    diskGiB: 100,
    gpus: 1,
    offerId: 'us-central1-a/a2-highgpu-1g',
  });
  const create = (extra: Record<string, unknown>, key = 'vm') =>
    w.api.instances.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: pool.id,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: key,
      ...extra,
    });
  return { w, cloud, seen, create };
}

describe('instances.create labels', () => {
  it('passes the tenant’s labels to the provider and shows them on the instance', async () => {
    const { w, seen, create } = await labelWorld();
    const instance = await create({ labels: { team: 'ml', 'cost-center': 'r_and_d' } });
    expect(instance.labels).toEqual({ team: 'ml', 'cost-center': 'r_and_d' });
    await settle(w);
    expect(seen).toEqual([{ labels: { team: 'ml', 'cost-center': 'r_and_d' } }]);
    // Without labels the provider is given none.
    const plain = await create({}, 'plain');
    expect(plain.labels).toBeUndefined();
    await settle(w);
    expect(seen[1]).toEqual({});
    // The same key with other labels is another request.
    expect(await code(create({ labels: { team: 'infra' } }))).toBe('CONFLICT');
  });

  it('checks labels against Compute Engine’s rules', async () => {
    const { create } = await labelWorld();
    const refused = async (labels: unknown) => code(create({ labels }, `bad-${Math.random()}`));
    expect(await refused({ Team: 'ml' })).toBe('INVALID_INPUT');
    expect(await refused({ '1team': 'ml' })).toBe('INVALID_INPUT');
    expect(await refused({ ['k'.repeat(64)]: 'v' })).toBe('INVALID_INPUT');
    expect(await refused({ team: 'ML' })).toBe('INVALID_INPUT');
    expect(await refused({ team: 'v'.repeat(64) })).toBe('INVALID_INPUT');
    expect(await refused({ team: 7 })).toBe('INVALID_INPUT');
    expect(await refused({ 'better-compute-instance': 'inst_x' })).toBe('INVALID_INPUT');
    expect(
      await refused(
        Object.fromEntries(Array.from({ length: maxInstanceLabels + 1 }, (_, i) => [`k${i}`, 'v'])),
      ),
    ).toBe('INVALID_INPUT');
    expect(maxInstanceLabels).toBe(62);
    // At the limit, with an empty value: fine.
    const many = Object.fromEntries(
      Array.from({ length: maxInstanceLabels }, (_, i) => [`k${i}`, i === 0 ? '' : 'v']),
    );
    expect((await create({ labels: many }, 'many')).labels).toEqual(many);
  });

  it('refuses labels on a hosted pool', async () => {
    const { w } = await labelWorld();
    const site = await w.api.sites.create(w.root, {
      tenantId: w.rootTenant,
      kind: 'shared',
      region: 'eu',
      idempotencyKey: 'hosted-site',
    });
    const hosted = await w.api.pools.create(w.root, {
      tenantId: w.rootTenant,
      siteId: site.id,
      class: 'vps-host',
      idempotencyKey: 'hosted',
    });
    await w.api.pools.offer(w.root, {
      tenantId: w.rootTenant,
      poolId: hosted.id,
      toTenantId: w.acmeTenant,
      quota: { vcpu: 8 },
    });
    await w.api.flavors.create(w.root, {
      tenantId: w.rootTenant,
      poolId: hosted.id,
      name: 'small',
      vcpu: 1,
      memoryGiB: 1,
      diskGiB: 10,
    });
    expect(
      await code(
        w.api.instances.create(w.acme, {
          tenantId: w.acmeTenant,
          poolId: hosted.id,
          flavor: 'small',
          imageId: 'debian-12',
          labels: { team: 'ml' },
          idempotencyKey: 'hosted-vm',
        }),
      ),
    ).toBe('INVALID_INPUT');
  });
});
