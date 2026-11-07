import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kubernetes } from '@better-compute/kubernetes';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { DoksEmulator } from './support/doks-emulator.js';

// The kubernetes module over the real provider-digitalocean DOKS driver and the DOKS emulator (the
// module's own tests use an in-memory fake): a root DO account, its token in the fixture's sealed
// secret store, backs a provider pool; a cluster is created, gets a node pool, issues a
// kubeconfig, is upgraded and is deleted, all through the module's API and reconciler.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Api = any;

interface World {
  doks: DoksEmulator;
  fixture: ComputeFixture;
  api: Api;
  root: { token: string };
  rootTenant: string;
  poolId: string;
  logs: string[];
  until(done: () => Promise<boolean>, limit?: number): Promise<void>;
}

async function world(): Promise<World> {
  const doks = new DoksEmulator(new DoEmulator());
  doks.do.validTokens = new Set(['root-do-token']);
  const providers = [
    digitaloceanProvider({ fetch: doks.fetch, kubeTransport: doks.kube.transport }),
  ];
  const logs: string[] = [];
  const record = (message: string, fields?: unknown) =>
    void logs.push(JSON.stringify({ message, fields }));
  const fixture = await computeFixture({
    clock: 'sim',
    log: { debug: record, info: record, warn: record, error: record },
    modules: [vps({ providers }), kubernetes({ providers })],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
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
  return {
    doks,
    fixture,
    api,
    root,
    rootTenant: tenants.root.id,
    poolId: pool.id,
    logs,
    async until(done, limit = 12) {
      for (let round = 0; round < limit; round++) {
        await fixture.advance(10_000);
        await compute.jobs['kubernetes.clusters']!.tick();
        if (await done()) return;
      }
      throw new Error(`not settled after ${limit} rounds`);
    },
  };
}

describe('kubernetes on DOKS, end to end', () => {
  it('creates, grows, connects, upgrades and deletes a cluster', async () => {
    const w = await world();
    const cluster = await w.api.kubernetesClusters.create(w.root, {
      tenantId: w.rootTenant,
      poolId: w.poolId,
      name: 'web',
      mode: 'standard',
      location: 'nyc3',
      version: '1.33',
      nodePools: [{ name: 'general', machineType: 's-2vcpu-4gb', nodeCount: 2 }],
      idempotencyKey: 'web-1',
    });
    const get = () =>
      w.api.kubernetesClusters.get(w.root, { tenantId: w.rootTenant, clusterId: cluster.id });
    await w.until(async () => (await get()).state === 'ready');
    const ready = await get();
    const [doCluster] = [...w.doks.clusters.values()] as Json[];
    expect(doCluster!.name).toBe(cluster.providerName);
    expect(ready).toMatchObject({
      endpoint: doCluster!.endpoint,
      kubernetesVersion: '1.33.5-do.1',
    });
    expect(doCluster!.node_pools.map((p: Json) => [p.name, p.count])).toEqual([['general', 2]]);

    // A GPU node pool, added later (DOKS's own device plugins stay off: DO-D18).
    // (The fixture offers H100s in tor1 and atl1 only; this region gets them too.)
    w.doks.do.state.sizes.find((size) => size.slug === 'gpu-h100x1-80gb')!.regions.push('nyc3');
    await w.api.kubernetesNodePools.create(w.root, {
      tenantId: w.rootTenant,
      clusterId: cluster.id,
      name: 'gpu',
      machineType: 'gpu-h100x1-80gb',
      nodeCount: 1,
      accelerators: { type: 'nvidia-h100', count: 1 },
      idempotencyKey: 'gpu-1',
    });
    await w.until(async () => (await get()).state === 'ready');
    expect(doCluster!.node_pools.map((p: Json) => [p.name, p.size])).toEqual([
      ['general', 's-2vcpu-4gb'],
      ['gpu', 'gpu-h100x1-80gb'],
    ]);
    expect(doCluster!.nvidia_gpu_device_plugin).toEqual({ enabled: false });

    // A kubeconfig for the caller: a bound token of a service account, trusting the cluster CA.
    const issued = await w.api.kubernetesClusters.credentials(w.root, {
      tenantId: w.rootTenant,
      clusterId: cluster.id,
      role: 'view',
    });
    expect(issued.kubeconfig).toContain(doCluster!.endpoint);
    const minted = w.doks.kube.issued.at(-1)!;
    expect(issued.kubeconfig).toContain(minted);

    // An upgrade, in place.
    await w.api.kubernetesClusters.update(w.root, {
      tenantId: w.rootTenant,
      clusterId: cluster.id,
      version: '1.34',
    });
    await w.until(
      async () => (await get()).state === 'ready' && doCluster!.version === '1.34.1-do.0',
    );

    // Deleted at DO, by id, with nothing of the tenant's workloads taken along.
    await w.api.kubernetesClusters.delete(w.root, {
      tenantId: w.rootTenant,
      clusterId: cluster.id,
    });
    await w.until(async () => w.doks.clusters.size === 0);
    const deletes = w.doks.do.requests
      .filter((r) => r.method === 'DELETE')
      .map((r) => r.url.pathname);
    expect(deletes).toEqual([`/v2/kubernetes/clusters/${doCluster!.id}`]);

    // No DO token and no Kubernetes token reached a log line.
    const logged = w.logs.join('\n');
    for (const secret of ['root-do-token', minted, ...w.doks.adminTokens.keys()])
      expect(logged).not.toContain(secret);
  });
});
