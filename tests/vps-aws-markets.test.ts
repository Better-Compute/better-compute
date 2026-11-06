import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { CapacityEmulator } from './support/aws-emulator/capacity.js';

// AWS A3 through vps: a Spot instance is metered on the Spot GPU meter (the machine reports
// market spot, whatever the flavor says), and a reclaimed Spot Instance ends its instance.

afterEach(closeFixtures);

type Api = any;
const ZONE = 'us-east-1a';

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  new CapacityEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({ clock: 'sim', modules: [vps({ providers: [aws] })] });
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
    config: { region: 'us-east-1', zones: [ZONE], spot: true },
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
    quota: { vcpu: 1000, memoryGiB: 10_000, diskGiB: 10_000, gpu: 16 },
  });
  for (const [name, offerId] of [
    ['g6.spot', `${ZONE}/g6.xlarge:spot`],
    ['g6.ondemand', `${ZONE}/g6.xlarge`],
  ])
    await api.flavors.create(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      name,
      vcpu: 4,
      memoryGiB: 16,
      diskGiB: 100,
      gpus: 1,
      offerId,
    });
  return {
    emu,
    ec2,
    fixture,
    api,
    acme,
    acmeTenant: tenants.acme.id,
    poolId: pool.id,
    create: (flavor: string, key: string) =>
      api.instances.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        flavor,
        imageId: 'ubuntu-24.04',
        sshKeys: [],
        idempotencyKey: key,
      }),
    view: (instanceId: string) =>
      api.instances.get(acme, { tenantId: tenants.acme.id, instanceId }),
    async settle(instanceId: string, state: string) {
      let current = await this.view(instanceId);
      for (let round = 0; round < 8 && current.state !== state; round++) {
        ec2.tick();
        await fixture.advance(15_000);
        for (let pass = 0; pass < 2; pass++) await compute.jobs['vps.instances']!.tick();
        current = await this.view(instanceId);
      }
      return current;
    },
    async shapes(instanceId: string) {
      const { rows } = await fixture.database.query<{ shape: unknown }>(
        `SELECT shape FROM instance_usage_intervals WHERE instance_id = $1 ORDER BY started_at`,
        [instanceId],
      );
      return rows.map((row) =>
        typeof row.shape === 'string' ? JSON.parse(row.shape) : row.shape,
      ) as { spot: boolean; gpus?: { model: string; count: number } }[];
    },
  };
}

describe('AWS markets through vps', () => {
  it('a Spot instance is metered as spot; an on-demand one is not', async () => {
    const w = await world();
    const spot = await w.create('g6.spot', 'spot-1');
    const plain = await w.create('g6.ondemand', 'plain-1');
    expect((await w.settle(spot.id, 'running')).state).toBe('running');
    expect((await w.settle(plain.id, 'running')).state).toBe('running');
    const runs = w.emu
      .calls('RunInstances')
      .map((call) => call.params.get('InstanceMarketOptions.MarketType'));
    expect(runs.sort()).toEqual([null, 'spot'].sort());
    expect((await w.shapes(spot.id))[0]).toMatchObject({ spot: true, gpus: { count: 1 } });
    expect((await w.shapes(plain.id))[0]).toMatchObject({ spot: false });
  });
});
