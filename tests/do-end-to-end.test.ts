import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseFirewallName,
  deploymentTag,
  digitaloceanProvider,
  dropletName,
  firewallName,
  labels,
  networkDescription,
  networkMemberTag,
  resetBudgets,
  shareName,
  shareTag,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { networkTag, providerResourceName, vps } from '@better-compute/vps';
import { failAction } from './support/do-emulator/actions.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';

// The real provider-digitalocean against the DigitalOcean emulator, wired through vps (the vps
// tests use inline fakes, this one proves the two packages agree). One root DO account, its token
// in the fixture's sealed secret store, backs a provider pool offered to acme; discovery runs every
// minute and auto-attaches machines tagged for a tenant and its pool. Covers create/stop/delete,
// attach/detach, auto-attach, a tenant network, a create DO accepts and then fails, and (P2) Block
// Storage volumes, snapshots and Reserved IPs on an instance through its delete, and (P6) an NFS share
// on two instances of a tenant network.

afterEach(closeFixtures);
// The provider's request budgets are per token and process-wide.
beforeEach(() => resetBudgets());

const REGION = 'nyc3';
const OFFER = `${REGION}/s-1vcpu-1gb`;
const IMAGE = 'ubuntu-24-04-x64';
/** The platform's service identity that auto-attach acts as (and makes the owner). */
const PLATFORM = 'svc-platform';
// Generated once with ssh-keygen.
const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

const managed = tagFor(labels.managed, 'true');
const deployment = deploymentTag('default');

type Api = any;

interface World {
  emu: DoEmulator;
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
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token']);
  const fingerprint = seedSshKey(emu.state, 'platform', testKey).fingerprint as string;
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [digitaloceanProvider({ fetch: emu.fetch })],
        discovery: { every: '1m', autoAttach: { ownerIdentityId: PLATFORM } },
      }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const { ref } = await api.secrets.put(root, {
    tenantId: tenants.root.id,
    name: 'do',
    value: 'root-do-token',
    idempotencyKey: 'do-token',
  });
  expect(ref).toMatch(new RegExp(`^secret://${tenants.root.id}/`));
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'digitalocean',
    name: 'do-main',
    config: { token: ref, regions: [REGION], sshKeyFingerprint: fingerprint },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: REGION,
    idempotencyKey: 'do-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'do-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64, addresses: 4 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 's.1vcpu.1gb',
    vcpu: 1,
    memoryGiB: 1,
    diskGiB: 25,
    offerId: OFFER,
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
  flavor: 's.1vcpu.1gb',
  imageId: IMAGE,
  sshKeys: [],
  idempotencyKey: 'vm-1',
  ...extra,
});

/** The emulator Droplet an instance created (it carries the instance's tag). */
const dropletOf = (w: World, instanceId: string): Json | undefined =>
  [...w.emu.state.droplets.values()].find((droplet) =>
    (droplet.tags as string[]).includes(tagFor(labels.instance, instanceId)),
  );

const requests = (w: World, method: string, path: RegExp) =>
  w.emu.requests.filter((request) => request.method === method && path.test(request.url.pathname));

/** Runs `vps.instances` until the instance settles. */
async function settle(w: World, instanceId: string, state: string, rounds = 6): Promise<any> {
  let current = await w.view(instanceId);
  for (let round = 0; round < rounds && current.state !== state; round++) {
    await w.tick('vps.instances', 5_000);
    current = await w.view(instanceId);
  }
  return current;
}

describe('provider-digitalocean through vps, end to end', () => {
  it('creates an instance on a droplet, runs it, stops it and deletes it', async () => {
    const w = await world();
    const created = await w.api.instances.create(w.acme, createInput(w));
    expect(await settle(w, created.id, 'running')).toMatchObject({ state: 'running' });

    const droplet = dropletOf(w, created.id)!;
    expect(droplet).toMatchObject({
      name: dropletName(created.id),
      size_slug: 's-1vcpu-1gb',
      status: 'active',
      region: expect.objectContaining({ slug: REGION }),
      image: expect.objectContaining({ slug: IMAGE }),
    });
    expect(droplet.tags).toEqual(expect.arrayContaining([managed, deployment]));
    // The create sent the account's default key (by id) and carried one key tag.
    const [post] = requests(w, 'POST', /^\/v2\/droplets$/);
    expect(post!.headers.authorization).toBe('Bearer root-do-token');
    expect(post!.body).toMatchObject({
      region: REGION,
      size: 's-1vcpu-1gb',
      image: IMAGE,
      ssh_keys: [w.emu.state.sshKeys.values().next().value!.id],
    });
    const key = (droplet.tags as string[]).filter((tag) => tag.startsWith(`${labels.key}:`));
    expect(key).toHaveLength(1);
    expect(requests(w, 'POST', /^\/v2\/droplets$/)).toHaveLength(1);

    const ref = { tenantId: w.acmeTenant, instanceId: created.id };
    await w.api.instances.stop(w.acme, ref);
    expect(await settle(w, created.id, 'stopped')).toMatchObject({ state: 'stopped' });
    // vps stops with `graceful-off`, which is DO's `shutdown`.
    expect(
      requests(w, 'POST', new RegExp(`^/v2/droplets/${droplet.id}/actions$`)).map(
        (request) => (request.body as Json).type,
      ),
    ).toEqual(['shutdown']);
    expect(droplet.status).toBe('off');

    await w.api.instances.delete(w.acme, ref);
    expect(await settle(w, created.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(requests(w, 'DELETE', new RegExp(`^/v2/droplets/${droplet.id}$`))).toHaveLength(1);
    expect(w.emu.state.droplets.has(droplet.id)).toBe(false);
    // Only ever one Droplet at a time, never by tag.
    expect(
      w.emu.requests.some(
        (request) => request.url.searchParams.has('tag_name') && request.method !== 'GET',
      ),
    ).toBe(false);
  });

  it('discovers a droplet, attaches it, and detaches it on delete', async () => {
    const w = await world();
    const legacy = seedDroplet(w.emu.state, { name: 'legacy', tags: ['team:ml'] });
    await w.tick('vps.discovery', 60_000);
    const machines = await w.api.providerAccounts.machines(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
    });
    expect(machines.items).toEqual([
      expect.objectContaining({ externalId: String(legacy.id), state: 'running' }),
    ]);

    const instance = await w.api.instances.attach(w.root, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      externalId: String(legacy.id),
      ownerIdentityId: w.fixture.tenants.acme.caller.identityId,
      idempotencyKey: 'attach-legacy',
    });
    expect(instance).toMatchObject({
      origin: 'attached',
      onDelete: 'detach',
      flavor: 's-1vcpu-1gb',
    });
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    // Claimed: this deployment's tag and the instance's, never the managed tag (it is a detach).
    expect([...legacy.tags].sort()).toEqual(
      ['team:ml', deployment, tagFor(labels.instance, instance.id)].sort(),
    );

    const ref = { tenantId: w.acmeTenant, instanceId: instance.id };
    await w.api.instances.stop(w.acme, ref);
    expect(await settle(w, instance.id, 'stopped')).toMatchObject({ state: 'stopped' });
    expect(legacy.status).toBe('off');

    await w.api.instances.delete(w.acme, ref);
    expect(await settle(w, instance.id, 'deleted')).toMatchObject({ state: 'deleted' });
    // Detached, not deleted: the Droplet runs on without the instance's tag.
    expect(w.emu.state.droplets.get(legacy.id)).toBe(legacy);
    expect(legacy.tags).not.toContain(tagFor(labels.instance, instance.id));
    expect(legacy.tags).not.toContain(managed);
    expect(legacy.tags).toContain('team:ml');
    expect(
      w.emu.requests.some(
        (request) => request.method === 'DELETE' && /^\/v2\/droplets/.test(request.url.pathname),
      ),
    ).toBe(false);
  });

  it('auto-attaches a droplet tagged for acme and its pool', async () => {
    const w = await world();
    const tagged = seedDroplet(w.emu.state, {
      name: 'tagged',
      tags: [tagFor(labels.tenant, w.acmeTenant), tagFor(labels.pool, w.poolId)],
    });
    // Tagged for a pool but no tenant: left alone.
    const halfTagged = seedDroplet(w.emu.state, {
      name: 'half',
      tags: [tagFor(labels.pool, w.poolId)],
    });
    await w.tick('vps.discovery', 60_000);
    const listed = await w.api.instances.list(w.acme, { tenantId: w.acmeTenant, scope: 'all' });
    expect(listed.items).toEqual([
      expect.objectContaining({
        origin: 'attached',
        onDelete: 'detach',
        externalId: String(tagged.id),
        ownerIdentityId: PLATFORM,
      }),
    ]);
    const instance = listed.items[0];
    expect(await settle(w, instance.id, 'running')).toMatchObject({ state: 'running' });
    expect(tagged.tags).toEqual(
      expect.arrayContaining([deployment, tagFor(labels.instance, instance.id)]),
    );
    expect(halfTagged.tags).toEqual([tagFor(labels.pool, w.poolId)]);
    // Later passes keep the one attachment.
    for (let round = 0; round < 2; round++) await w.tick('vps.discovery', 60_000);
    expect(
      (await w.api.instances.list(w.acme, { tenantId: w.acmeTenant, scope: 'all' })).items,
    ).toHaveLength(1);
  });

  it('converges a tenant network, its subnet, the base firewall and a rule targeting an instance', async () => {
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
      region: REGION,
      cidr: '10.20.0.0/24',
    });
    const subnet = withSubnet.subnets[0];
    const networkView = () =>
      w.api.networks.get(w.acme, { tenantId: w.acmeTenant, networkId: network.id });
    const converge = async () => {
      let current = await networkView();
      for (let round = 0; round < 8 && current.state !== 'ready'; round++) {
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
    const ruleState = async () =>
      (
        await w.api.firewallRules.list(w.acme, { tenantId: w.acmeTenant, networkId: network.id })
      ).items.find((item: { id: string }) => item.id === rule.id)?.state;
    for (let round = 0; round < 8 && (await ruleState()) !== 'ready'; round++)
      await w.tick('vps.networks', 5_000);
    expect(await ruleState()).toBe('ready');
    expect(await networkView()).toMatchObject({ state: 'ready' });

    // DO holds the subnet as a VPC named after it and tied to the network by its description,
    // the network's base firewall, and the rule's firewall targeting the instance's tag.
    const networkName = providerResourceName(network.id);
    const ours = [...w.emu.state.vpcs.values()].filter((vpc) => !vpc.default);
    expect(ours).toEqual([
      expect.objectContaining({
        name: providerResourceName(subnet.id),
        region: REGION,
        ip_range: '10.20.0.0/24',
        description: networkDescription(networkName),
      }),
    ]);
    const firewalls = [...w.emu.state.firewalls.values()];
    expect(firewalls.map((firewall) => firewall.name).sort()).toEqual(
      [
        baseFirewallName(networkName),
        firewallName(providerResourceName(rule.id), networkName, 1000),
      ].sort(),
    );
    const base = firewalls.find((firewall) => firewall.name === baseFirewallName(networkName))!;
    expect(base).toMatchObject({
      inbound_rules: [],
      tags: [networkMemberTag(networkName)],
    });
    expect(base.outbound_rules.length).toBeGreaterThan(0);
    expect(base.outbound_rules.every((out: Json) => out.ports === '0')).toBe(true);
    const ruled = firewalls.find((firewall) => firewall !== base)!;
    expect(ruled).toMatchObject({
      status: 'succeeded',
      outbound_rules: [],
      tags: [networkTag(created.id)],
      inbound_rules: [
        expect.objectContaining({
          protocol: 'tcp',
          ports: '22',
          sources: { addresses: ['0.0.0.0/0'] },
        }),
      ],
    });
    const droplet = dropletOf(w, created.id)!;
    expect(droplet.vpc_uuid).toBe(ours[0]!.id);
    expect(droplet.tags).toEqual(
      expect.arrayContaining([networkMemberTag(networkName), networkTag(created.id)]),
    );
  });

  it('a create DO refuses for capacity ends the instance in error with ProvisionFailed', async () => {
    const w = await world();
    // DO accepts the create with a 202, then its create action ends `errored`.
    failAction(w.emu.state, { type: 'create' });
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
          message: expect.stringContaining('create action errored'),
        }),
      ],
    });
    const droplet = dropletOf(w, created.id)!;
    expect(droplet.status).toBe('new');
    // No retry loop: later passes ask DO nothing.
    const count = w.emu.requests.length;
    await w.tick('vps.instances', 60_000);
    await w.tick('vps.instances', 60_000);
    expect(w.emu.requests.length).toBe(count);
    // And it deletes cleanly: the Droplet that never came up is removed.
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: created.id });
    expect(await settle(w, created.id, 'deleted')).toMatchObject({ state: 'deleted' });
    expect(w.emu.state.droplets.has(droplet.id)).toBe(false);
  });

  it('attaches volumes, snapshots one, assigns a reserved IP, and deletes with the instance (P2)', async () => {
    const w = await world();
    const created = await w.api.instances.create(w.acme, createInput(w, { idempotencyKey: 'p2' }));
    expect(await settle(w, created.id, 'running')).toMatchObject({ state: 'running' });
    const droplet = dropletOf(w, created.id)!;
    const tenantId = w.acmeTenant;
    const volume = (extra: Record<string, unknown>) =>
      w.api.providerVolumes.create(w.acme, {
        tenantId,
        poolId: w.poolId,
        region: REGION,
        sizeGiB: 10,
        instanceId: created.id,
        ...extra,
      });
    const data = await volume({ name: 'data', idempotencyKey: 'v-data' });
    const scratch = await volume({
      name: 'scratch',
      deleteWithInstance: true,
      idempotencyKey: 'v-scratch',
    });
    const ip = await w.api.providerAddresses.create(w.acme, {
      tenantId,
      poolId: w.poolId,
      name: 'ingress',
      region: REGION,
      idempotencyKey: 'ip-1',
    });
    await w.api.providerAddresses.assign(w.acme, { tenantId, addressId: ip.id, instanceId: created.id });
    const converge = async (rounds = 8) => {
      for (let round = 0; round < rounds; round++) await w.tick('vps.provider-resources', 5_000);
    };
    await converge();

    const doVolume = (id: string) =>
      [...w.emu.state.volumes.values()].find((v) => v.name === providerResourceName(id));
    for (const id of [data.id, scratch.id]) {
      const view = await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: id });
      expect(view).toMatchObject({ state: 'ready', attachment: { instanceId: created.id, state: 'ready' } });
      expect(doVolume(id)).toMatchObject({ droplet_ids: [droplet.id], size_gigabytes: 10 });
      expect(doVolume(id)!.tags).toEqual(expect.arrayContaining([managed, deployment]));
    }
    const reserved = await w.api.providerAddresses.get(w.acme, { tenantId, addressId: ip.id });
    expect(reserved).toMatchObject({ state: 'ready', assignmentState: 'ready', instanceId: created.id });
    expect(w.emu.state.reservedIps.get(reserved.address)?.droplet_id).toBe(droplet.id);

    const snapshot = await w.api.providerVolumes.snapshot(w.acme, {
      tenantId,
      volumeId: data.id,
      name: 'data-1',
      idempotencyKey: 's-1',
    });
    await converge(3);
    expect(
      await w.api.providerSnapshots.get(w.acme, { tenantId, snapshotId: snapshot.id }),
    ).toMatchObject({ state: 'ready', sizeGiB: 10 });

    const scratchOnDo = doVolume(scratch.id)!.id;
    await w.api.instances.delete(w.acme, { tenantId, instanceId: created.id });
    expect(await settle(w, created.id, 'deleted')).toMatchObject({ state: 'deleted' });
    // One selective destroy, naming the deleteWithInstance volume only (DO-D16).
    const destroys = requests(w, 'DELETE', new RegExp(`^/v2/droplets/${droplet.id}`));
    expect(destroys.map((request) => request.url.pathname)).toEqual([
      `/v2/droplets/${droplet.id}/destroy_with_associated_resources/selective`,
    ]);
    expect(destroys[0]!.body).toEqual({ volumes: [scratchOnDo] });
    await converge();
    expect(
      await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: scratch.id }),
    ).toMatchObject({ state: 'deleted' });
    expect(doVolume(scratch.id)).toBeUndefined();
    const kept = await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: data.id });
    expect(kept).toMatchObject({ state: 'ready', desiredState: 'present' });
    expect(kept.attachment).toBeUndefined();
    expect(doVolume(data.id)).toMatchObject({ droplet_ids: [] });
    expect(
      await w.api.providerAddresses.get(w.acme, { tenantId, addressId: ip.id }),
    ).toMatchObject({ state: 'ready', assignmentState: 'none' });
    expect(w.emu.state.reservedIps.get(reserved.address)?.droplet_id).toBeUndefined();
    // No delete of a volume by tag or of a volume vps did not delete.
    expect(requests(w, 'DELETE', /^\/v2\/volumes/)).toHaveLength(0);
  });
  it('shares an NFS volume between two instances of a tenant network, then detaches and deletes it (P6)', async () => {
    const w = await world();
    const tenantId = w.acmeTenant;
    const network = await w.api.networks.create(w.acme, {
      tenantId,
      poolId: w.poolId,
      name: 'shared',
      idempotencyKey: 'net-shared',
    });
    const withSubnet = await w.api.networks.addSubnet(w.acme, {
      tenantId,
      networkId: network.id,
      name: 'app',
      region: REGION,
      cidr: '10.30.0.0/24',
    });
    const subnet = withSubnet.subnets[0];
    for (let round = 0; round < 8; round++) {
      if ((await w.api.networks.get(w.acme, { tenantId, networkId: network.id })).state === 'ready') break;
      await w.tick('vps.networks', 5_000);
    }
    const onNetwork = (key: string) =>
      w.api.instances.create(
        w.acme,
        createInput(w, { networkId: network.id, subnetId: subnet.id, idempotencyKey: key }),
      );
    const first = await onNetwork('nfs-1');
    const second = await onNetwork('nfs-2');
    expect(await settle(w, first.id, 'running')).toMatchObject({ state: 'running' });
    expect(await settle(w, second.id, 'running')).toMatchObject({ state: 'running' });

    // A share below DigitalOcean's minimum is refused at once, before any quota or provider call.
    const nfsWrites = () => requests(w, 'POST', /^\/v2\/nfs/).length;
    const small = await w.api.providerVolumes
      .create(w.acme, {
        tenantId,
        poolId: w.poolId,
        name: 'small-share',
        region: REGION,
        sizeGiB: 10,
        kind: 'shared',
        networkId: network.id,
        idempotencyKey: 'v-small-share',
      })
      .then(
        () => undefined,
        (error: { code?: string; details?: unknown }) => error,
      );
    expect(small).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'size' } });
    expect(nfsWrites()).toBe(0);

    const volume = await w.api.providerVolumes.create(w.acme, {
      tenantId,
      poolId: w.poolId,
      name: 'shared',
      region: REGION,
      sizeGiB: 50,
      kind: 'shared',
      networkId: network.id,
      instanceId: first.id,
      idempotencyKey: 'v-shared',
    });
    expect(volume).toMatchObject({ kind: 'shared', networkId: network.id, state: 'pending' });
    await w.api.providerVolumes.attach(w.acme, { tenantId, volumeId: volume.id, instanceId: second.id });
    const converge = async (rounds = 8) => {
      for (let round = 0; round < rounds; round++) await w.tick('vps.provider-resources', 5_000);
    };
    await converge();

    const shares = () => [...w.emu.state.nfsShares.values()];
    const vpc = [...w.emu.state.vpcs.values()].find((v) => v.name === providerResourceName(subnet.id))!;
    expect(shares()).toEqual([
      expect.objectContaining({
        name: shareName(providerResourceName(volume.id), 'default'),
        region: REGION,
        size_gib: 50,
        vpc_ids: [vpc.id],
        status: 'ACTIVE',
      }),
    ]);
    const share = shares()[0]!;
    const source = `${share.host}:${share.mount_path}`;
    const ready = await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: volume.id });
    expect(ready).toMatchObject({
      state: 'ready',
      kind: 'shared',
      device: source,
      mount: { source, type: 'nfs4' },
    });
    expect(ready.attachments.map((a: { instanceId: string; state: string }) => [a.instanceId, a.state]).sort()).toEqual(
      [
        [first.id, 'ready'],
        [second.id, 'ready'],
      ].sort(),
    );
    const tag = shareTag(share.id);
    for (const instance of [first, second])
      expect(dropletOf(w, instance.id)!.tags).toContain(tag);

    // Detach one: its Droplet loses the tag, the other keeps the share; the share keeps its VPC.
    await w.api.providerVolumes.detach(w.acme, { tenantId, volumeId: volume.id, instanceId: first.id });
    await converge(4);
    expect(dropletOf(w, first.id)!.tags).not.toContain(tag);
    expect(dropletOf(w, second.id)!.tags).toContain(tag);
    expect(
      (await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: volume.id })).attachments,
    ).toEqual([expect.objectContaining({ instanceId: second.id, state: 'ready' })]);
    expect(shares()[0]!.vpc_ids).toEqual([vpc.id]);

    await w.api.providerVolumes.detach(w.acme, { tenantId, volumeId: volume.id, instanceId: second.id });
    await converge(4);
    expect(dropletOf(w, second.id)!.tags).not.toContain(tag);
    await w.api.providerVolumes.delete(w.acme, { tenantId, volumeId: volume.id });
    await converge(4);
    expect(
      await w.api.providerVolumes.get(w.acme, { tenantId, volumeId: volume.id }),
    ).toMatchObject({ state: 'deleted' });
    expect(shares()).toEqual([]);
    expect(requests(w, 'DELETE', /^\/v2\/nfs\//)).toHaveLength(1);
  });
});
