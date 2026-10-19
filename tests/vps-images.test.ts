import { afterEach, describe, expect, it } from 'vitest';
import { apiMethod } from '@better-compute/core';
import { gcpProvider } from '@better-compute/provider-gcp';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { GceEmulator } from './support/gce-emulator.js';
import { plainProvider } from './support/vps-gce.js';

// U-03 through vps: `images.resolve` on a provider pool (the owner and the tenants it is offered to
// see its image families, resolved by the pool's account), and the account's image allowlist as the
// backstop of `instances.create` (a refused image fails the instance with ProvisionFailed, and no VM
// is created). The real provider-gcp against the Compute Engine emulator.

afterEach(closeFixtures);

const ZONE = 'us-central1-a';

type Api = any;

interface World {
  emu: GceEmulator;
  fixture: ComputeFixture;
  api: Api;
  root: { token: string };
  acme: { token: string };
  other: { token: string };
  rootTenant: string;
  acmeTenant: string;
  otherTenant: string;
  poolId: string;
  tick(job: string, advanceMs?: number): Promise<void>;
}

async function world(config: Record<string, unknown> = {}): Promise<World> {
  const emu = new GceEmulator();
  emu.validTokens.add('host-token');
  emu.addImage('ubuntu-os-cloud', {
    name: 'ubuntu-2404-noble-amd64-v20261001',
    family: 'ubuntu-2404-lts-amd64',
    diskSizeGb: '10',
  });
  emu.addImage('debian-cloud', { name: 'debian-12-v20261001', family: 'debian-12' });
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [gcp, plainProvider] })],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  for (const tenant of [tenants.root, tenants.acme, tenants.other])
    iam.allow({ token: tenant.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'gcp',
    name: 'gcp-main',
    config: { projectId: 'platform-prod', zones: [ZONE], ...config },
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
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 0 },
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
    acme: { token: tenants.acme.token },
    other: { token: tenants.other.token },
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    otherTenant: tenants.other.id,
    poolId: pool.id,
    async tick(job, advanceMs = 5_000) {
      await fixture.advance(advanceMs);
      for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
    },
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('resolved');
    },
    (error: { code: string; details?: Record<string, unknown> }) => error,
  );

const imageReads = (w: World) =>
  w.emu.requests.filter((request) => request.url.pathname.includes('/global/images/'));

describe('images.resolve on a provider pool (U-03)', () => {
  it('is a read on the pool, gated like flavors', () => {
    expect(apiMethod('images', 'resolve')).toMatchObject({
      action: 'compute:flavors:read',
      resource: 'pool',
      kind: 'read',
      module: 'vps',
    });
  });

  it('resolves families for the tenants the pool is offered to, cached by the account', async () => {
    const w = await world();
    const input = {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      families: ['ubuntu-2404-lts-amd64', 'debian-cloud/debian-12', 'nope'],
    };
    const result = await w.api.images.resolve(w.acme, input);
    expect(result).toEqual({
      poolId: w.poolId,
      provider: 'gcp',
      items: [
        expect.objectContaining({
          family: 'ubuntu-2404-lts-amd64',
          image: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261001',
          architecture: 'x86_64',
          minimumDiskGiB: 10,
          loginUser: 'ubuntu',
        }),
        expect.objectContaining({ family: 'debian-cloud/debian-12', loginUser: 'debian' }),
      ],
      missing: [{ family: 'nope', reason: 'notFound' }],
    });
    // The platform account's id is not shown to the tenant.
    expect(JSON.stringify(result)).not.toContain('pacct_');
    // The owner asks too; the account's client already holds the answers.
    await w.api.images.resolve(w.root, { ...input, tenantId: w.rootTenant });
    expect(imageReads(w)).toHaveLength(3);
  });

  it('a tenant the pool is not offered to does not see it', async () => {
    const w = await world();
    expect(
      await failure(
        w.api.images.resolve(w.other, {
          tenantId: w.otherTenant,
          poolId: w.poolId,
          families: ['debian-12'],
        }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(imageReads(w)).toEqual([]);
  });

  it("refuses families outside the account's allowlist and malformed input", async () => {
    const w = await world({ ownProjectImages: false });
    const ask = (families: unknown) =>
      failure(w.api.images.resolve(w.acme, { tenantId: w.acmeTenant, poolId: w.poolId, families }));
    expect(await ask(['platform-prod/golden'])).toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'imageProjectNotAllowed' },
    });
    expect(await ask(['global/images/family/golden'])).toMatchObject({ code: 'INVALID_INPUT' });
    for (const families of [[], Array.from({ length: 51 }, (_, i) => `f${i}`), ['Bad Family'], 'x'])
      expect(await ask(families), JSON.stringify(families)).toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(imageReads(w)).toEqual([]);
  });

  it('a provider that does not resolve images is UNSUPPORTED', async () => {
    const w = await world();
    const plain = await w.api.providerAccounts.create(w.root, {
      tenantId: w.rootTenant,
      provider: 'fake-plain',
      name: 'plain',
      config: {},
    });
    const site = await w.api.sites.create(w.root, {
      tenantId: w.rootTenant,
      kind: 'shared',
      region: 'eu',
      idempotencyKey: 'plain-site',
    });
    const pool = await w.api.pools.create(w.root, {
      tenantId: w.rootTenant,
      siteId: site.id,
      class: 'provider',
      providerAccountId: plain.id,
      idempotencyKey: 'plain-pool',
    });
    expect(
      await failure(
        w.api.images.resolve(w.root, {
          tenantId: w.rootTenant,
          poolId: pool.id,
          families: ['debian-12'],
        }),
      ),
    ).toMatchObject({ code: 'UNSUPPORTED', details: { provider: 'fake-plain' } });
  });
});

describe("the account's image allowlist backs instances.create (U-03)", () => {
  it('a refused image fails the instance with ProvisionFailed, and GCE is never asked', async () => {
    const w = await world({ ownProjectImages: false });
    const created = await w.api.instances.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      flavor: 'n2.standard.4',
      imageId: 'global/images/platform-golden',
      sshKeys: [],
      idempotencyKey: 'vm-golden',
    });
    for (let round = 0; round < 4; round++) await w.tick('vps.instances');
    const instance = await w.api.instances.get(w.acme, {
      tenantId: w.acmeTenant,
      instanceId: created.id,
    });
    expect(instance.state).toBe('error');
    expect(instance.conditions).toContainEqual(
      expect.objectContaining({ type: 'ProvisionFailed', reason: 'INVALID_INPUT' }),
    );
    const { rows } = await w.fixture.database.query<{ payload: { data: { reason: string } } }>(
      `SELECT payload FROM outbox WHERE topic = 'instance.failed'`,
    );
    expect(rows.map((row) => row.payload.data.reason)).toEqual(['INVALID_INPUT']);
    expect(w.emu.instances.size).toBe(0);
    expect(
      w.emu.requests.some(
        (request) => request.method === 'POST' && request.url.pathname.endsWith('/instances'),
      ),
    ).toBe(false);

    // An allowed public image is created as before.
    const ok = await w.api.instances.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      flavor: 'n2.standard.4',
      imageId: 'projects/debian-cloud/global/images/family/debian-12',
      sshKeys: [],
      idempotencyKey: 'vm-debian',
    });
    for (let round = 0; round < 2; round++) await w.tick('vps.instances');
    const vm = [...w.emu.instances.values()].find(
      (candidate) => candidate.labels?.['better-compute-instance'] === ok.id,
    );
    expect(vm?.disks[0].initializeParams.sourceImage).toBe(
      'projects/debian-cloud/global/images/family/debian-12',
    );
  });
});
