import { afterEach, describe, expect, it } from 'vitest';
import { gcpProvider } from '@better-compute/provider-gcp';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { networkTag, providerResourceName, vps } from '@better-compute/vps';
import { GceEmulator, type Json } from './support/gce-emulator.js';

// The real provider-gcp against the Compute Engine emulator, wired through vps (ruling P2's
// counterpart: the vps tests use inline fakes, this one proves the two packages agree). One root
// GCP account backs a provider pool offered to acme; discovery and the reservations worker run
// every minute. Covers attach/stop/detach, reservation admission, a tenant network, and a create
// GCE fails after accepting it (W3a).

afterEach(closeFixtures);

const ZONE = 'us-central1-a';
const base = 'https://compute.googleapis.com/compute/v1';

type Api = any;

interface World {
  emu: GceEmulator;
  fixture: ComputeFixture;
  api: Api;
  root: { token: string };
  acme: { token: string };
  rootTenant: string;
  acmeTenant: string;
  accountId: string;
  poolId: string;
  /** Moves the sim clock, then runs a job's due keys (twice: a periodic pass enqueues per-account keys). */
  tick(job: string, advanceMs?: number): Promise<void>;
  view(instanceId: string): Promise<any>;
}

async function world(): Promise<World> {
  const emu = new GceEmulator();
  // The host's own credentials (workload identity) instead of a service-account key.
  emu.validTokens.add('host-token');
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [gcp], discovery: { every: '1m' }, reservations: { every: '1m' } })],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'gcp',
    name: 'gcp-main',
    config: { projectId: 'p', zones: [ZONE] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'gcp-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'gcp-pool',
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
    name: 'n2.standard.4',
    vcpu: 4,
    memoryGiB: 16,
    diskGiB: 100,
    offerId: `${ZONE}/n2-standard-4`,
  });
  return {
    emu,
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
  flavor: 'n2.standard.4',
  imageId: 'debian-12',
  sshKeys: [],
  idempotencyKey: 'vm-1',
  ...extra,
});

/** The emulator VM an instance created (`bc-` + its lowercased id). */
const vmOf = (w: World, instanceId: string): Json | undefined =>
  [...w.emu.instances.values()].find(
    (instance) => instance.labels?.['better-compute-instance'] === instanceId,
  );

/** Runs `vps.instances` (letting GCE operations finish in between) until the instance settles. */
async function settle(w: World, instanceId: string, state: string, rounds = 6): Promise<any> {
  let current = await w.view(instanceId);
  for (let round = 0; round < rounds && current.state !== state; round++) {
    w.emu.finishOperations();
    await w.tick('vps.instances', 5_000);
    current = await w.view(instanceId);
  }
  return current;
}

describe('provider-gcp through vps, end to end', () => {
  it('discovers a VM, attaches it, stops it, and detaches it on delete', async () => {
    const w = await world();
    w.emu.addInstance(ZONE, 'legacy', { labels: { team: 'ml' } });
    await w.tick('vps.discovery', 60_000);
    const machines = await w.api.providerAccounts.machines(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
    });
    expect(machines.items).toEqual([
      expect.objectContaining({ externalId: `${ZONE}/legacy`, state: 'running' }),
    ]);

    const instance = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: `${ZONE}/legacy`,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-legacy',
    });
    expect(instance).toMatchObject({
      origin: 'attached',
      onDelete: 'detach',
      flavor: 'n2-standard-4',
    });
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    const legacy = w.emu.instances.get(`${ZONE}/legacy`)!;
    expect(legacy.labels).toEqual({ team: 'ml', 'better-compute-instance': instance.id });

    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    await w.api.instances.stop(w.acme, ref);
    expect(await settle(w, instance.id, 'stopped')).toMatchObject({ state: 'stopped' });
    expect(legacy.status).toBe('TERMINATED');

    await w.api.instances.delete(w.acme, ref);
    expect(await settle(w, instance.id, 'deleted')).toMatchObject({ state: 'deleted' });
    // Detached, not deleted: the VM runs on in GCE without better-compute's label.
    expect(w.emu.instances.get(`${ZONE}/legacy`)).toBeDefined();
    expect(w.emu.instances.get(`${ZONE}/legacy`)!.labels).toEqual({ team: 'ml' });
    expect(w.emu.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('a detach GCE refuses with resourceNotReady is retried; instance.detached only after (I5)', async () => {
    const w = await world();
    w.emu.addInstance(ZONE, 'legacy', { labels: { team: 'ml' } });
    await w.tick('vps.discovery', 60_000);
    const instance = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: `${ZONE}/legacy`,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-legacy',
    });
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    const legacy = w.emu.instances.get(`${ZONE}/legacy`)!;
    const detached = async () =>
      (await w.fixture.database.query(`SELECT 1 FROM outbox WHERE topic = 'instance.detached'`))
        .rows.length;

    // The customer stops the VM and detaches at once: GCE refuses the label write meanwhile.
    w.emu.failAction = { action: 'setLabels', status: 400, reason: 'resourceNotReady', times: 2 };
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    await w.tick('vps.instances', 1_000);
    // One label write was refused (the next is refused too): the detach is not done.
    expect(w.emu.failAction?.times).toBe(1);
    expect(legacy.labels['better-compute-instance']).toBe(instance.id);
    expect(await detached()).toBe(0);
    expect((await w.view(instance.id)).state).not.toBe('deleted');

    expect(await settle(w, instance.id, 'deleted', 40)).toMatchObject({ state: 'deleted' });
    expect(w.emu.failAction).toBeUndefined();
    expect(legacy.labels).toEqual({ team: 'ml' });
    expect(await detached()).toBe(1);
    // The machine is free again: it can be attached anew.
    await w.tick('vps.discovery', 60_000);
    const again = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: `${ZONE}/legacy`,
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-legacy-again',
    });
    expect(again.id).not.toBe(instance.id);
  });

  it('detects a reservation, binds it, and admits only its free slot', async () => {
    const w = await world();
    w.emu.reservations.push({
      kind: 'compute#reservation',
      name: 'rsv-a',
      zone: `${base}/projects/p/zones/${ZONE}`,
      selfLink: `${base}/projects/p/zones/${ZONE}/reservations/rsv-a`,
      status: 'READY',
      specificReservationRequired: true,
      specificReservation: {
        count: '2',
        inUseCount: '1',
        instanceProperties: { machineType: 'a3-highgpu-8g' },
      },
    });
    await w.tick('vps.reservations', 60_000);
    const listed = await w.api.providerAccounts.reservations(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
    });
    expect(listed.items).toEqual([
      expect.objectContaining({ id: `${ZONE}/rsv-a`, state: 'ready', total: 2, inUse: 1, free: 1 }),
    ]);
    const bound = await w.api.providerAccounts.bindReservation(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
      reservationId: `${ZONE}/rsv-a`,
      poolId: w.poolId,
      idempotencyKey: 'bind-rsv-a',
    });
    expect(bound.poolId).toBe(w.poolId);

    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { flavor: 'rsv-rsv-a', idempotencyKey: 'rsv-1' }),
    );
    expect(await settle(w, created.id, 'running')).toMatchObject({ state: 'running' });
    const vm = vmOf(w, created.id)!;
    expect(vm.machineType).toMatch(/\/machineTypes\/a3-highgpu-8g$/);
    expect(vm.reservationAffinity).toEqual({
      consumeReservationType: 'SPECIFIC_RESERVATION',
      key: 'compute.googleapis.com/reservation-name',
      values: ['rsv-a'],
    });
    // One slot was free and this instance holds it: a second create is refused.
    await expect(
      w.api.instances.create(
        w.acme,
        createInput(w, { flavor: 'rsv-rsv-a', idempotencyKey: 'rsv-2' }),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
  });

  it('converges a tenant network, its subnet and a firewall rule targeting an instance', async () => {
    const w = await world();
    const network = await w.api.networks.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      name: 'prod',
      idempotencyKey: 'net-prod',
    });
    const withSubnet = await w.api.networks.addSubnet(w.acme, {
      tenantId: w.acmeTenant,
      networkId: network.id,
      name: 'app',
      region: 'us-central1',
      cidr: '10.10.0.0/24',
    });
    const subnet = withSubnet.subnets[0];
    const networkView = () =>
      w.api.networks.get(w.acme, { tenantId: w.acmeTenant, networkId: network.id });
    const converge = async () => {
      let current = await networkView();
      for (let round = 0; round < 8 && current.state !== 'ready'; round++) {
        w.emu.finishOperations();
        await w.tick('vps.networks', 5_000);
        current = await networkView();
      }
      return current;
    };
    expect(await converge()).toMatchObject({ state: 'ready' });

    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { networkId: network.id, subnetId: subnet.id, idempotencyKey: 'net-vm' }),
    );
    expect(await settle(w, created.id, 'running')).toMatchObject({ state: 'running' });
    const rule = await w.api.firewallRules.create(w.acme, {
      tenantId: w.acmeTenant,
      networkId: network.id,
      name: 'ssh',
      direction: 'ingress',
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
      targets: { instanceIds: [created.id] },
    });
    expect(rule).toMatchObject({ state: 'pending' });
    // A rule has its own state (the network's covers the VPC and its subnets).
    const ruleState = async () =>
      (
        await w.api.firewallRules.list(w.acme, { tenantId: w.acmeTenant, networkId: network.id })
      ).items.find((item: { id: string }) => item.id === rule.id)?.state;
    for (let round = 0; round < 8 && (await ruleState()) !== 'ready'; round++) {
      w.emu.finishOperations();
      await w.tick('vps.networks', 5_000);
    }
    expect(await ruleState()).toBe('ready');
    expect(await networkView()).toMatchObject({ state: 'ready' });

    // GCE holds the network, its subnetwork and the rule under vps's names, and the VM carries
    // the rule's tag.
    const networkName = providerResourceName(network.id);
    expect([...w.emu.networks.keys()]).toEqual([networkName]);
    expect([...w.emu.subnetworks.entries()]).toEqual([
      [
        `us-central1/${providerResourceName(subnet.id)}`,
        expect.objectContaining({
          ipCidrRange: '10.10.0.0/24',
          network: expect.stringMatching(new RegExp(`/networks/${networkName}$`)),
        }),
      ],
    ]);
    expect(w.emu.firewalls.get(providerResourceName(rule.id))).toMatchObject({
      network: expect.stringMatching(new RegExp(`/networks/${networkName}$`)),
      direction: 'INGRESS',
      targetTags: [networkTag(created.id)],
      sourceRanges: ['0.0.0.0/0'],
      allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    });
    const vm = vmOf(w, created.id)!;
    expect(vm.tags.items).toContain(networkTag(created.id));
    expect(vm.networkInterfaces[0].network).toMatch(new RegExp(`/networks/${networkName}$`));
    expect(vm.networkInterfaces[0].subnetwork).toMatch(
      new RegExp(`/subnetworks/${providerResourceName(subnet.id)}$`),
    );
  });

  it('a create GCE accepts and then fails for capacity ends the instance in error (W3a)', async () => {
    const w = await world();
    w.emu.failNextOperation = {
      code: 'ZONE_RESOURCE_POOL_EXHAUSTED',
      message: `The zone '${ZONE}' does not have enough resources available to fulfill the request.`,
    };
    const created = await w.api.instances.create(
      w.acme,
      createInput(w, { idempotencyKey: 'stockout' }),
    );
    const failed = await settle(w, created.id, 'error');
    expect(failed).toMatchObject({
      state: 'error',
      conditions: [
        expect.objectContaining({
          type: 'ProvisionFailed',
          status: 'true',
          reason: 'CAPACITY_UNAVAILABLE',
          message: expect.stringContaining('does not have enough resources'),
        }),
      ],
    });
    // No retry loop: later passes ask GCE nothing.
    const requests = w.emu.requests.length;
    await w.tick('vps.instances', 60_000);
    await w.tick('vps.instances', 60_000);
    expect(w.emu.requests.length).toBe(requests);
    // And it deletes cleanly: the VM never existed.
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: created.id });
    expect(await settle(w, created.id, 'deleted')).toMatchObject({ state: 'deleted' });
  });
});
