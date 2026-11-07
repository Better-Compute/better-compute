import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { CeEmulator } from './support/aws-emulator/ce.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';

// A11 through vps: a platform AWS account that opts in to Cost Explorer (`costs: 'region'`) is read by the
// vps.costs worker; rows tagged with a better-compute instance are attributed to the instance's tenant, tenant-
// tagged rows (an operator's tag: provider-aws never writes it) to that tenant, and the rest (a platform account's) are unattributed.

afterEach(closeFixtures);

type Api = any;

async function world() {
  const emu = new AwsEmulator();
  new Ec2Emulator(emu);
  const ce = new CeEmulator(emu);
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [awsProvider({ fetch: emu.fetch, credentials: emu.ambient })] })],
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
    config: { region: 'us-east-1', zones: ['us-east-1a'], costs: 'region' },
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
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: 'us-east-1a/m7i.large',
  });
  return { emu, ce, fixture, api, root, acme, tenants, accountId: account.id, poolId: pool.id };
}

describe('provider-aws costs through vps', () => {
  it('vps.costs reads Cost Explorer and attributes rows by instance and tenant tags', async () => {
    const w = await world();
    const vm = await w.api.instances.create(w.acme, {
      tenantId: w.tenants.acme.id,
      poolId: w.poolId,
      flavor: 'm7i.large',
      imageId: 'ubuntu-24.04',
      sshKeys: [],
      idempotencyKey: 'vm-1',
    });
    const day = new Date(w.fixture.clock.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const base = {
      day,
      account: platformAccount,
      region: 'us-east-1',
      service: 'Amazon Elastic Compute Cloud - Compute',
      unit: 'Hrs',
    };
    w.ce.lines.push(
      {
        ...base,
        usageType: 'BoxUsage:m7i.large',
        cost: '2.4192',
        quantity: '24',
        tags: { 'better-compute:instance': vm.id },
      },
      {
        ...base,
        service: 'EC2 - Other',
        usageType: 'USE1-DataTransfer-Regional-Bytes',
        cost: '0.5',
        quantity: '50',
        unit: 'GB',
        tags: { 'better-compute:tenant': w.tenants.acme.id },
      },
      { ...base, service: 'AWS Support (Business)', usageType: '', recordType: 'Fee', cost: '100' },
    );
    for (let round = 0; round < 2; round++) await w.fixture.compute.jobs['vps.costs']!.tick();
    const { rows } = await w.fixture.database.query<{
      attribution: string;
      instance_id: string | null;
      tenant_id: string | null;
      cost_micros: string | number;
      record: { sku: string; costType?: string };
    }>(
      `SELECT attribution, instance_id, tenant_id, cost_micros, record FROM provider_costs
        WHERE account_id = $1 ORDER BY cost_micros`,
      [w.accountId],
    );
    expect(
      rows.map((row) => [
        row.record.sku,
        row.attribution,
        row.instance_id,
        row.tenant_id,
        Number(row.cost_micros),
      ]),
    ).toEqual([
      ['USE1-DataTransfer-Regional-Bytes', 'tenant-label', null, w.tenants.acme.id, 500_000],
      ['BoxUsage:m7i.large', 'instance', vm.id, w.tenants.acme.id, 2_419_200],
      // a platform account's untagged cost is the platform's: unattributed
      ['Fee', 'unattributed', null, null, 100_000_000],
    ]);
    expect(rows[2]!.record.costType).toBe('fee');
    expect(w.emu.calls('GetCostAndUsage')).toHaveLength(3);
    expect(w.emu.unrouted).toEqual([]);
  });
});
