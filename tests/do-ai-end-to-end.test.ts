import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudResources } from '@better-compute/cloud-resources';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';

// DigitalOcean's AI platform (P8) through betterCompute() on PGlite: a root DO account backs a provider pool offered
// to acme with a GPU quota, and acme runs a Dedicated Inference endpoint on it. Its GPUs are booked against that
// quota from the create (a second endpoint over it is refused), scaling books the difference, and deleting the
// endpoint returns them once DigitalOcean has let it go.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Api = any;

async function world(gpuQuota = 2) {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token']);
  const provider = digitaloceanProvider({ fetch: emu.fetch });
  const logs: string[] = [];
  const line = (message: string, fields?: unknown) =>
    void logs.push(JSON.stringify({ message, fields }));
  const fixture = await computeFixture({
    clock: 'sim',
    log: { debug: line, info: line, warn: line, error: line },
    modules: [vps({ providers: [provider] }), cloudResources({ providers: [provider] })],
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
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'digitalocean',
    name: 'do-main',
    config: { token: ref, regions: ['nyc3'] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'nyc3',
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
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: gpuQuota },
  });
  const acmeTenant = tenants.acme.id;
  const get = (resourceId: string) =>
    api.cloudResources.get(acme, { tenantId: acmeTenant, resourceId });
  const until = async (resourceId: string, state: string) => {
    for (let round = 0; round < 20; round++) {
      await fixture.advance(10_000);
      await compute.jobs['cloud.resources']!.tick();
      if ((await get(resourceId)).state === state) return;
    }
    throw new Error(
      `${resourceId} never reached ${state}: ${JSON.stringify(await get(resourceId))}`,
    );
  };
  const gpusUsed = async () => {
    const { rows } = await fixture.database.query<{ used: string | number }>(
      `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu'`,
      [acmeTenant, pool.id],
    );
    return Number(rows[0]?.used ?? 0);
  };
  return { emu, fixture, api, acme, acmeTenant, poolId: pool.id, logs, get, until, gpusUsed };
}

describe('DigitalOcean Dedicated Inference through cloudResources', () => {
  it('books the endpoint’s GPUs against the pool quota, scales in place, and returns them on delete', async () => {
    const w = await world(2);
    const kinds = await w.api.cloudResources.kinds(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
    });
    expect(
      kinds.items.find((kind: { kind: string }) => kind.kind === 'do.dedicated-inference'),
    ).toMatchObject({ family: 'ai', updatable: ['replicas', 'maxReplicas'], available: true });

    const endpoint = await w.api.cloudResources.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      kind: 'do.dedicated-inference',
      name: 'chat',
      spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', gpuSize: 'gpu-h100x1-80gb' },
      idempotencyKey: 'chat',
    });
    expect(await w.gpusUsed()).toBe(1);
    await w.until(endpoint.id, 'ready');
    const ready = await w.get(endpoint.id);
    const atDo = w.emu.state.dedicatedInferences.get(ready.providerId)!;
    expect(atDo.name).toBe(endpoint.providerName);
    expect(ready.outputs).toMatchObject({
      endpoint: `https://${ready.providerId}.inference.do-ai.run`,
      replicas: '1',
    });
    const rates = await w.fixture.database.query<{ meter_rates: Record<string, number> }>(
      `SELECT meter_rates FROM cloud_resources WHERE id = $1`,
      [endpoint.id],
    );
    expect(rates.rows[0]!.meter_rates).toEqual({ 'gpu.h100.hours': 1 });

    // A second endpoint over the quota is refused, with nothing recorded and nothing sent.
    const posts = w.emu.requests.filter((r) => r.method === 'POST').length;
    await expect(
      w.api.cloudResources.create(w.acme, {
        tenantId: w.acmeTenant,
        poolId: w.poolId,
        kind: 'do.dedicated-inference',
        name: 'big',
        spec: { region: 'nyc3', model: 'llama3.3-70b-instruct', gpuSize: 'gpu-h100x8-640gb' },
        idempotencyKey: 'big',
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(w.emu.requests.filter((r) => r.method === 'POST').length).toBe(posts);

    // Scaling to a maximum of two books one more GPU; three would be over the quota.
    await expect(
      w.api.cloudResources.update(w.acme, {
        tenantId: w.acmeTenant,
        resourceId: endpoint.id,
        spec: { maxReplicas: 3 },
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await w.api.cloudResources.update(w.acme, {
      tenantId: w.acmeTenant,
      resourceId: endpoint.id,
      spec: { maxReplicas: 2 },
    });
    expect(await w.gpusUsed()).toBe(2);
    await w.until(endpoint.id, 'ready');
    expect(atDo.scaling).toMatchObject({ min_replicas: 1, max_replicas: 2 });

    await w.api.cloudResources.delete(w.acme, { tenantId: w.acmeTenant, resourceId: endpoint.id });
    expect(await w.gpusUsed()).toBe(2);
    await w.until(endpoint.id, 'deleted');
    expect(w.emu.state.dedicatedInferences.has(ready.providerId)).toBe(false);
    expect(await w.gpusUsed()).toBe(0);
    expect(JSON.stringify(w.logs)).not.toContain('root-do-token');
  });
});
