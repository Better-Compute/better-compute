import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator, type EmuInstance } from './support/aws-emulator/ec2.js';

// The real provider-aws against the AWS emulator, wired through vps: one root (platform) AWS
// account in us-east-1 backs a provider pool offered to acme; discovery runs every minute. Covers
// create through the pool, EC2 eventual consistency, attach/detach, an async stockout, and F1.

afterEach(closeFixtures);

const ZONE = 'us-east-1a';

type Api = any;

interface World {
  emu: AwsEmulator;
  ec2: Ec2Emulator;
  fixture: ComputeFixture;
  api: Api;
  root: { token: string };
  acme: { token: string };
  rootTenant: string;
  acmeTenant: string;
  accountId: string;
  poolId: string;
  tick(job: string, advanceMs?: number): Promise<void>;
  view(instanceId: string): Promise<any>;
}

async function world(): Promise<World> {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [aws], discovery: { every: '1m' } })],
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
    config: { region: 'us-east-1', zones: [ZONE, 'us-east-1b'] },
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
    offerId: `${ZONE}/m7i.large`,
  });
  return {
    emu,
    ec2,
    fixture,
    api,
    root,
    acme,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    accountId: account.id,
    poolId: pool.id,
    async tick(job, advanceMs = 1_000) {
      await fixture.advance(advanceMs);
      for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
    },
    view: (instanceId) => api.instances.get(acme, { tenantId: tenants.acme.id, instanceId }),
  };
}

const createInput = (w: World, extra: Record<string, unknown> = {}) => ({
  tenantId: w.acmeTenant,
  poolId: w.poolId,
  flavor: 'm7i.large',
  imageId: 'ubuntu-24.04',
  sshKeys: [],
  idempotencyKey: 'vm-1',
  ...extra,
});

/** The emulated instance an instance created (its better-compute:instance tag). */
const vmOf = (w: World, instanceId: string): EmuInstance | undefined =>
  [...w.ec2.instances.values()].find(
    (instance) => instance.tags.get('better-compute:instance') === instanceId,
  );

/** Runs `vps.instances` (letting EC2 state move in between) until the instance settles. */
async function settle(w: World, instanceId: string, state: string, rounds = 8): Promise<any> {
  let current = await w.view(instanceId);
  for (let round = 0; round < rounds && current.state !== state; round++) {
    w.ec2.tick();
    await w.tick('vps.instances', 15_000);
    current = await w.view(instanceId);
  }
  return current;
}

describe('provider-aws through vps, end to end', () => {
  it('a tenant creates an EC2 instance through a provider pool', async () => {
    const w = await world();
    const created = await w.api.instances.create(w.acme, createInput(w));
    const running = await settle(w, created.id, 'running');
    expect(running).toMatchObject({ state: 'running' });
    const vm = vmOf(w, created.id)!;
    expect(vm).toBeDefined();
    expect(vm.state).toBe('running');
    expect(vm.type).toBe('m7i.large');
    expect(vm.tags.get('better-compute:managed')).toBe('true');
    const { rows } = await w.fixture.database.query<{ external_id: string }>(
      'SELECT external_id FROM instances WHERE id = $1',
      [created.id],
    );
    expect(rows[0]!.external_id).toBe(vm.id);
    expect(rows[0]!.external_id).toMatch(/^i-[0-9a-f]{17}$/);
    // One RunInstances, however many reconciler passes.
    expect(w.emu.calls('RunInstances')).toHaveLength(1);
    expect(w.emu.unrouted).toEqual([]);
  });

  it('the instance survives EC2 eventual consistency', async () => {
    const w = await world();
    w.ec2.newInstanceNotFound = { byId: 2, byToken: 2 };
    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { idempotencyKey: 'vm-ec' }),
    );
    const states: string[] = [];
    let current = await w.view(created.id);
    for (let round = 0; round < 8 && current.state !== 'running'; round++) {
      w.ec2.tick();
      await w.tick('vps.instances', 15_000);
      current = await w.view(created.id);
      states.push(current.state);
    }
    expect(current.state).toBe('running');
    expect(states).not.toContain('lost');
    expect(w.emu.calls('RunInstances')).toHaveLength(1);
  });

  it('discovery lists account instances and attach adopts one without recreating it', async () => {
    const w = await world();
    const legacy = w.ec2.addInstance({ type: 'm7i.large', tags: { Name: 'legacy', team: 'ml' } });
    await w.tick('vps.discovery', 60_000);
    const machines = await w.api.providerAccounts.machines(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
    });
    expect(machines.items).toEqual([
      expect.objectContaining({ externalId: legacy.id, state: 'running' }),
    ]);
    const instance = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: legacy.id,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-legacy',
    });
    expect(instance).toMatchObject({ origin: 'attached', onDelete: 'detach' });
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    expect(legacy.tags.get('better-compute:instance')).toBe(instance.id);
    expect(w.emu.calls('RunInstances')).toHaveLength(0);

    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    await w.api.instances.stop(w.acme, ref);
    expect(await settle(w, instance.id, 'stopped')).toMatchObject({ state: 'stopped' });
    // A graceful stop: EC2 reports stopping (vps sees stopped) until the guest is down.
    expect(['stopping', 'stopped']).toContain(legacy.state);
    w.ec2.tick();
    expect(legacy.state).toBe('stopped');
    expect(w.emu.calls('StopInstances')[0]!.params.get('Force')).toBeNull();
  });

  it('delete of an attached instance detaches by default and leaves it running', async () => {
    const w = await world();
    const legacy = w.ec2.addInstance({ type: 'm7i.large', tags: { team: 'ml' } });
    await w.tick('vps.discovery', 60_000);
    const instance = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: legacy.id,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-del',
    });
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    expect(await settle(w, instance.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(legacy.state).toBe('running');
    expect(Object.fromEntries(legacy.tags)).toEqual({ team: 'ml' });
    expect(w.emu.calls('TerminateInstances')).toHaveLength(0);
  });

  it('delete of a created instance terminates it', async () => {
    const w = await world();
    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { idempotencyKey: 'vm-del' }),
    );
    expect(await settle(w, created.id, 'running')).toMatchObject({ state: 'running' });
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: created.id });
    expect(await settle(w, created.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(['shutting-down', 'terminated']).toContain(vmOf(w, created.id)!.state);
    expect(w.emu.calls('TerminateInstances').length).toBeGreaterThanOrEqual(1);
  });

  it('a tenant account without a role is refused at providerAccounts.create', async () => {
    const w = await world();
    await expect(
      w.api.providerAccounts.create(w.acme, {
        tenantId: w.acmeTenant,
        provider: 'aws',
        name: 'mine',
        config: { region: 'us-east-1', zones: [ZONE] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      w.api.providerAccounts.create(w.acme, {
        tenantId: w.acmeTenant,
        provider: 'aws',
        name: 'bad-zone',
        config: {
          region: 'us-east-1',
          zones: ['eu-west-1a'],
          assumeRoleArn: 'arn:aws:iam::222222222222:role/bc',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // With a role in its own AWS account, the tenant's account is stored.
    const ok = await w.api.providerAccounts.create(w.acme, {
      tenantId: w.acmeTenant,
      provider: 'aws',
      name: 'with-role',
      config: {
        region: 'us-east-1',
        zones: [ZONE],
        assumeRoleArn: 'arn:aws:iam::222222222222:role/bc',
      },
    });
    expect(ok.provider).toBe('aws');
  });

  it('async stockout fails the instance permanently with CAPACITY_UNAVAILABLE', async () => {
    const w = await world();
    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { idempotencyKey: 'stockout' }),
    );
    // The reconciler's first pass launches it; EC2 then fails it for capacity.
    for (let round = 0; round < 4 && !vmOf(w, created.id); round++)
      await w.tick('vps.instances', 5_000);
    const vm = vmOf(w, created.id)!;
    expect(vm).toBeDefined();
    w.ec2.asyncFailure(vm.id, 'Server.InsufficientInstanceCapacity');
    const failed = await settle(w, created.id, 'error');
    expect(failed).toMatchObject({
      state: 'error',
      conditions: [
        expect.objectContaining({
          type: 'ProvisionFailed',
          status: 'true',
          reason: 'CAPACITY_UNAVAILABLE',
        }),
      ],
    });
    const requests = w.emu.requests.length;
    await w.tick('vps.instances', 60_000);
    await w.tick('vps.instances', 60_000);
    expect(w.emu.requests.length).toBe(requests);
    expect(w.emu.calls('RunInstances')).toHaveLength(1);
  });
});
