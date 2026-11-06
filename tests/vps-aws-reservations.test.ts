import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { CapacityEmulator } from './support/aws-emulator/capacity.js';

// AWS A3 exit: the GCP plan's reservation admission (`claimReservationSlot`) covers ODCRs and
// Capacity Blocks unchanged. The real provider-aws against the emulator, through vps: the
// vps.reservations worker reads the account's reservations, bindReservation makes a flavor of
// one, and instances.create on it is admitted by the database, so it never over-commits.

afterEach(closeFixtures);

type Api = any;
const ZONE = 'us-east-1a';

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [aws], reservations: { every: '5m' } })],
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
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
    quota: { vcpu: 4000, memoryGiB: 40_000, diskGiB: 40_000, gpu: 100 },
  });
  return {
    emu,
    ec2,
    capacity,
    fixture,
    api,
    root,
    acme,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    accountId: account.id,
    poolId: pool.id,
    async scan() {
      await fixture.advance(6 * 60_000);
      for (let round = 0; round < 2; round++) await compute.jobs['vps.reservations']!.tick();
    },
    listed: async () =>
      (
        await api.providerAccounts.reservations(root, {
          tenantId: tenants.root.id,
          accountId: account.id,
        })
      ).items as any[],
    bind: (reservationId: string) =>
      api.providerAccounts.bindReservation(root, {
        tenantId: tenants.root.id,
        accountId: account.id,
        reservationId,
        poolId: pool.id,
        idempotencyKey: `bind-${reservationId}`,
      }),
    create: (flavor: string, key: string) =>
      api.instances.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        flavor,
        imageId: 'ubuntu-24.04',
        sshKeys: [],
        idempotencyKey: key,
      }),
  };
}

describe('AWS reservations through vps', () => {
  it('admits only the free slots between polls (ODCR)', async () => {
    const w = await world();
    // total 2, one slot held outside better-compute.
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', type: 'p5.48xlarge', total: 2, usedElsewhere: 1 });
    await w.scan();
    expect((await w.listed()).map((r) => [r.id, r.state, r.total, r.inUse, r.free])).toEqual([
      ['cr-0aaaaaaaaaaaaaaa1', 'ready', 2, 1, 1],
    ]);
    const bound = await w.bind('cr-0aaaaaaaaaaaaaaa1');
    expect(bound.poolId).toBe(w.poolId);
    const outcomes = await Promise.allSettled([
      w.create('rsv-cr-0aaaaaaaaaaaaaaa1', 'race-1'),
      w.create('rsv-cr-0aaaaaaaaaaaaaaa1', 'race-2'),
    ]);
    const admitted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
    });
    // Later attempts are refused too, until a poll shows a slot freed.
    await expect(w.create('rsv-cr-0aaaaaaaaaaaaaaa1', 'later')).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
    });
    // The admitted instance launches into the reservation.
    for (let round = 0; round < 3; round++) {
      await w.fixture.advance(15_000);
      await w.fixture.compute.jobs['vps.instances']!.tick();
    }
    const run = w.emu.calls('RunInstances');
    expect(run).toHaveLength(1);
    expect(
      run[0]!.params.get(
        'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId',
      ),
    ).toBe('cr-0aaaaaaaaaaaaaaa1');
  });

  it('admits only the free slots between polls (Capacity Block)', async () => {
    const w = await world();
    w.capacity.add({
      id: 'cr-0bbbbbbbbbbbbbbb2',
      type: 'p5.48xlarge',
      reservationType: 'capacity-block',
      total: 1,
      end: w.emu.now() + 48 * 3_600_000,
    });
    await w.scan();
    expect((await w.listed()).map((r) => [r.id, r.free])).toEqual([['cb:cr-0bbbbbbbbbbbbbbb2', 1]]);
    await w.bind('cb:cr-0bbbbbbbbbbbbbbb2');
    const outcomes = await Promise.allSettled([
      w.create('rsv-cb-cr-0bbbbbbbbbbbbbbb2', 'race-1'),
      w.create('rsv-cb-cr-0bbbbbbbbbbbbbbb2', 'race-2'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    for (let round = 0; round < 3; round++) {
      await w.fixture.advance(15_000);
      await w.fixture.compute.jobs['vps.instances']!.tick();
    }
    const run = w.emu.calls('RunInstances');
    expect(run).toHaveLength(1);
    expect(run[0]!.params.get('InstanceMarketOptions.MarketType')).toBe('capacity-block');
  });
});
