import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalMachine, ProviderNetworkState } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { defineProvider, vps } from '@better-compute/vps';

// Zone-scoped subnets at the vps level (AWS A2): a provider whose subnets live in one zone
// (`subnetScope: 'zone'`) maps zones to regions itself (`zoneRegion`, Local Zones included) and
// names the CIDR prefixes it takes (`cidrPrefix`); vps checks all three at the API. A region-scoped
// provider (GCE-like, neither hook) behaves as before.

afterEach(closeFixtures);

type Api = any;

const standard = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};
const ready = (id: string): ProviderNetworkState => ({ id, state: 'ready' });
const machine = (name: string): ExternalMachine => ({
  id: name,
  name,
  state: 'running',
  addresses: [],
});
const networks = (extra: object) => ({
  ...extra,
  async ensureNetwork(spec: { name: string }) {
    return ready(spec.name);
  },
  async ensureSubnet(spec: { name: string }) {
    return ready(spec.name);
  },
  async ensureFirewall(spec: { name: string }) {
    return ready(spec.name);
  },
  async deleteNetwork(name: string) {
    return { id: name, state: 'deleted' as const };
  },
  async deleteSubnet(_region: string, name: string) {
    return { id: name, state: 'deleted' as const };
  },
  async deleteFirewall(name: string) {
    return { id: name, state: 'deleted' as const };
  },
  async setTags() {},
});

/** AWS-like: `us-west-2a` and the Local Zone `us-west-2-lax-1a` are both in `us-west-2`. */
const zonal = defineProvider({
  id: 'fake-zonal',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(request: { name: string }) {
      return machine(request.name);
    },
    async get(id: string) {
      return machine(id);
    },
    async delete() {},
    zoneRegion: (zone: string) => /^([a-z]{2}(?:-gov)?-[a-z]+-\d+)/.exec(zone)?.[1] ?? zone,
    networks: networks({
      subnetScope: 'zone',
      denyRules: 'network-wide',
      cidrPrefix: { network: [16, 28], subnet: [16, 28] },
    }),
  }),
});

/** GCE-like: region-wide subnets, no zone mapping, no prefix hint. */
const regional = defineProvider({
  id: 'fake-regional',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(request: { name: string }) {
      return machine(request.name);
    },
    async get(id: string) {
      return machine(id);
    },
    async delete() {},
    networks: networks({}),
  }),
});

async function world() {
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [zonal, regional] })],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const tenantId = tenants.acme.id;
  const poolOf = async (provider: string, region: string, zones: string[], offerId: string) => {
    const account = await api.providerAccounts.create(root, {
      tenantId: tenants.root.id,
      provider,
      name: `${provider}-acct`,
      config: { zones },
    });
    const site = await api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region,
      idempotencyKey: `${provider}-site`,
    });
    const pool = await api.pools.create(root, {
      tenantId: tenants.root.id,
      siteId: site.id,
      class: 'provider',
      providerAccountId: account.id,
      idempotencyKey: `${provider}-pool`,
    });
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      toTenantId: tenantId,
      quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
    });
    await api.flavors.create(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      name: 'small',
      vcpu: 2,
      memoryGiB: 8,
      diskGiB: 100,
      offerId,
    });
    return pool.id as string;
  };
  const zonalPool = await poolOf(
    'fake-zonal',
    'us-west-2',
    ['us-west-2a', 'us-west-2-lax-1a'],
    'us-west-2-lax-1a/m7i.large',
  );
  const regionalPool = await poolOf(
    'fake-regional',
    'us-central1',
    ['us-central1-a'],
    'us-central1-a/n2-standard-2',
  );
  let keys = 0;
  const network = (poolId: string, extra: object = {}) =>
    api.networks.create(acme, {
      tenantId,
      poolId,
      name: `net-${++keys}`,
      idempotencyKey: `net-${keys}`,
      ...extra,
    });
  const addSubnet = (networkId: string, fields: object) =>
    api.networks.addSubnet(acme, { tenantId, networkId, name: `sub-${++keys}`, ...fields });
  const converge = async (networkId: string) => {
    for (let round = 0; round < 6; round++) {
      await fixture.advance(5_000);
      await compute.jobs['vps.networks']!.tick();
    }
    return api.networks.get(acme, { tenantId, networkId });
  };
  return { api, acme, tenantId, zonalPool, regionalPool, network, addSubnet, converge };
}

describe('vps networks on a zone-scoped provider', () => {
  it('addSubnet requires a zone for zone-scoped providers', async () => {
    const w = await world();
    const net = await w.network(w.zonalPool);
    await expect(
      w.addSubnet(net.id, { region: 'us-west-2', cidr: '10.1.0.0/24' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/zone/) });
    await expect(
      w.addSubnet(net.id, { region: 'us-west-2', zone: 'us-west-2c', cidr: '10.1.0.0/24' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const view = await w.addSubnet(net.id, {
      region: 'us-west-2',
      zone: 'us-west-2a',
      cidr: '10.1.0.0/24',
    });
    expect(view.subnets[0]).toMatchObject({ region: 'us-west-2', zone: 'us-west-2a' });
  });

  it("zoneRegion uses the provider's mapping", async () => {
    const w = await world();
    const net = await w.network(w.zonalPool);
    // A Local Zone: the GCE rule would call its region `us-west-2-lax-1a`.
    const view = await w.addSubnet(net.id, {
      region: 'us-west-2',
      zone: 'us-west-2-lax-1a',
      cidr: '10.2.0.0/24',
    });
    expect(view.subnets[0]).toMatchObject({ region: 'us-west-2', zone: 'us-west-2-lax-1a' });
    await expect(
      w.addSubnet(net.id, { region: 'us-west-2-lax-1a', zone: 'us-west-2-lax-1a', cidr: '10.3.0.0/24' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses ranges the provider does not take at the API', async () => {
    const w = await world();
    await expect(w.network(w.zonalPool, { cidr: '10.0.0.0/8' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { minPrefix: 16, maxPrefix: 28 },
    });
    const net = await w.network(w.zonalPool, { cidr: '10.20.0.0/16' });
    expect(net).toMatchObject({ cidr: '10.20.0.0/16' });
    await expect(
      w.addSubnet(net.id, { region: 'us-west-2', zone: 'us-west-2a', cidr: '10.20.0.0/29' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { maxPrefix: 28 } });
  });

  it('a placement error names the offer zone, not a guessed region', async () => {
    const w = await world();
    const net = await w.network(w.zonalPool);
    await w.addSubnet(net.id, { region: 'us-west-2', zone: 'us-west-2a', cidr: '10.4.0.0/24' });
    expect(await w.converge(net.id)).toMatchObject({ state: 'ready' });
    const failure = await w.api.instances
      .create(w.acme, {
        tenantId: w.tenantId,
        poolId: w.zonalPool,
        flavor: 'small',
        imageId: 'ubuntu-24.04',
        sshKeys: [],
        networkId: net.id,
        idempotencyKey: 'vm-1',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/no subnet in us-west-2-lax-1a/),
      details: { zone: 'us-west-2-lax-1a' },
    });
    expect((failure as { details: object }).details).not.toHaveProperty('region');
  });
});

describe('vps networks on a region-scoped provider (GCP behavior is unchanged)', () => {
  it('subnets are regional, take no zone, and any range vps allows', async () => {
    const w = await world();
    const net = await w.network(w.regionalPool, { cidr: '10.0.0.0/8' });
    expect(net).toMatchObject({ cidr: '10.0.0.0/8' });
    await expect(
      w.addSubnet(net.id, { region: 'us-central1', zone: 'us-central1-a', cidr: '10.5.0.0/24' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const view = await w.addSubnet(net.id, { region: 'us-central1', cidr: '10.5.0.0/29' });
    expect(view.subnets[0]).toMatchObject({ region: 'us-central1', cidr: '10.5.0.0/29' });
    expect(view.subnets[0].zone ?? null).toBeNull();
  });

  it('a placement error names the region from the GCE zone rule', async () => {
    const w = await world();
    const net = await w.network(w.regionalPool);
    expect(await w.converge(net.id)).toMatchObject({ state: 'ready' });
    await expect(
      w.api.instances.create(w.acme, {
        tenantId: w.tenantId,
        poolId: w.regionalPool,
        flavor: 'small',
        imageId: 'ubuntu-24.04',
        sshKeys: [],
        networkId: net.id,
        idempotencyKey: 'vm-2',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/no subnet in us-central1;/),
      details: { region: 'us-central1' },
    });
  });
});
