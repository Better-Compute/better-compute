import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator, type EmuInstance } from './support/aws-emulator/ec2.js';
import { PlacementEmulator } from './support/aws-emulator/placement.js';

// AWS A10 through vps: instances.create({ placement }) on an AWS provider pool lands every
// instance of one tenant's group in one EC2 placement group, named by vps so tenants never share.

afterEach(closeFixtures);

const ZONE = 'us-east-1a';

type Api = any;

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const placement = new PlacementEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture: ComputeFixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [aws] })],
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  iam.allow({ token: tenants.other.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const other = { token: tenants.other.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: [ZONE] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.other.id,
    quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: `${ZONE}/m7i.large`,
  });
  const w = {
    emu,
    ec2,
    placement,
    fixture,
    api,
    root,
    acme,
    other,
    otherTenant: tenants.other.id,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    poolId: pool.id,
    async tick(job: string, advanceMs = 1_000) {
      await fixture.advance(advanceMs);
      for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
    },
    view: (instanceId: string, as = acme, tenantId = tenants.acme.id) =>
      api.instances.get(as, { tenantId, instanceId }),
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

const createInput = (w: World, key: string, extra: Record<string, unknown> = {}) => ({
  tenantId: w.acmeTenant,
  poolId: w.poolId,
  flavor: 'm7i.large',
  imageId: 'ubuntu-24.04',
  sshKeys: [],
  idempotencyKey: key,
  ...extra,
});

const vmOf = (w: World, instanceId: string): EmuInstance | undefined =>
  [...w.ec2.instances.values()].find(
    (instance) => instance.tags.get('better-compute:instance') === instanceId,
  );

async function settle(w: World, instanceId: string, as?: { token: string }, tenantId?: string) {
  let current = await w.view(instanceId, as, tenantId);
  for (let round = 0; round < 8 && current.state !== 'running'; round++) {
    w.ec2.tick();
    await w.tick('vps.instances', 15_000);
    current = await w.view(instanceId, as, tenantId);
  }
  return current;
}

describe('placement groups through vps', () => {
  it("lands a tenant's group in one placement group that no other tenant shares", async () => {
    const w = await world();
    const train = { group: 'train-1', strategy: 'cluster' };
    const a = await w.api.instances.create(w.acme, createInput(w, 'a', { placement: train }));
    const b = await w.api.instances.create(w.acme, createInput(w, 'b', { placement: train }));
    expect(a.placement).toEqual(train);
    expect((await settle(w, a.id)).state).toBe('running');
    expect((await settle(w, b.id)).state).toBe('running');
    const groupA = w.placement.members.get(vmOf(w, a.id)!.id)?.group;
    expect(groupA).toMatch(/^bc-pg-[0-9a-f]{32}$/);
    expect(w.placement.members.get(vmOf(w, b.id)!.id)?.group).toBe(groupA);
    expect(w.placement.groups.get(groupA!)?.strategy).toBe('cluster');
    expect(await w.view(a.id)).toMatchObject({ placement: train });

    // Another tenant's group of the same name in the same pool is another placement group.
    const mine = await w.api.instances.create(w.other, {
      ...createInput(w, 'r'),
      tenantId: w.otherTenant,
      placement: train,
    });
    expect((await settle(w, mine.id, w.other, w.otherTenant)).state).toBe('running');
    const groupR = w.placement.members.get(vmOf(w, mine.id)!.id)?.group;
    expect(groupR).toMatch(/^bc-pg-[0-9a-f]{32}$/);
    expect(groupR).not.toBe(groupA);
  });

  it('a partition placement names its partition', async () => {
    const w = await world();
    const created = await w.api.instances.create(
      w.acme,
      createInput(w, 'p', { placement: { group: 'db', strategy: 'partition', partition: 2 } }),
    );
    await settle(w, created.id);
    expect(w.placement.members.get(vmOf(w, created.id)!.id)).toMatchObject({ partition: 2 });
  });

  it('refuses another strategy for a group in use, and placement is part of the request', async () => {
    const w = await world();
    await w.api.instances.create(
      w.acme,
      createInput(w, 'a', { placement: { group: 'train', strategy: 'cluster' } }),
    );
    await expect(
      w.api.instances.create(
        w.acme,
        createInput(w, 'b', { placement: { group: 'train', strategy: 'spread' } }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      w.api.instances.create(
        w.acme,
        createInput(w, 'a', { placement: { group: 'other', strategy: 'cluster' } }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('concurrent creates naming one group with different strategies: one is refused', async () => {
    const w = await world();
    const results = await Promise.allSettled([
      w.api.instances.create(
        w.acme,
        createInput(w, 'a', { placement: { group: 'train', strategy: 'cluster' } }),
      ),
      w.api.instances.create(
        w.acme,
        createInput(w, 'b', { placement: { group: 'train', strategy: 'spread' } }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });
    // Only one instance names the group (PGlite runs one transaction at a time; on Postgres the
    // group's advisory lock serializes the check).
    const { rows } = await w.fixture.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM instances WHERE placement->>'group' = 'train'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it.each([
    [{ group: 'Train', strategy: 'cluster' }],
    [{ group: 'train', strategy: 'mesh' }],
    [{ group: 'train', strategy: 'cluster', partition: 1 }],
    [{ group: 'train', strategy: 'partition', partition: 8 }],
    [{ group: 'train', strategy: 'cluster', extra: true }],
  ])('refuses placement %j', async (placement) => {
    const w = await world();
    await expect(
      w.api.instances.create(w.acme, createInput(w, 'x', { placement })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
