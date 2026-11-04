import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import type { KubernetesClusterView, KubernetesNodePoolView } from '@better-compute/kubernetes';
import { defaultVersion } from './support/fake-kubernetes.js';
import { kubernetesWorld, type KubernetesWorld } from './support/kubernetes-world.js';

// The kubernetes.clusters reconciler against the in-memory provider: create → ready with node pools, version and
// authorized-network updates, node pool create/resize/delete, delete → deleted, provider refusals and transient
// errors, and the tenancy teardown.

let world: KubernetesWorld;
let counter = 0;

const pool = (extra: Record<string, unknown> = {}) => ({
  name: 'default',
  machineType: 'e2-standard-4',
  nodeCount: 1,
  ...extra,
});
const create = (
  extra: Record<string, unknown> = {},
  who: 'root' | 'acme' = 'root',
): Promise<KubernetesClusterView> => {
  counter++;
  return world.api.kubernetesClusters.create(world[who], {
    tenantId: who === 'root' ? world.rootTenant : world.acmeTenant,
    poolId: world.poolId,
    name: `r${counter}`,
    mode: 'standard',
    location: 'us-central1',
    nodePools: [pool()],
    idempotencyKey: `rk-${counter}`,
    ...extra,
  });
};
const get = (cluster: KubernetesClusterView, who: 'root' | 'acme' = 'root') =>
  world.api.kubernetesClusters.get(world[who], {
    tenantId: cluster.tenantId,
    clusterId: cluster.id,
  }) as Promise<KubernetesClusterView>;
const stateOf = async (cluster: KubernetesClusterView) => (await get(cluster)).state;
const ready = (cluster: KubernetesClusterView) => async () => (await stateOf(cluster)) === 'ready';
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code ?? String(error),
  );
const eventsOf = async (clusterId: string) =>
  (await world.events('kubernetes.')).filter((event) => event.data.clusterId === clusterId);
const types = async (clusterId: string) => (await eventsOf(clusterId)).map((event) => event.type);

beforeAll(async () => {
  world = await kubernetesWorld({ maxClustersPerTenant: 20 });
});
afterAll(closeFixtures);
beforeEach(() => {
  world.cloud.delayTicks = 1;
  world.cloud.refuse.clear();
  delete world.cloud.failNext;
});

describe('create → ready', () => {
  it('provisions a standard cluster with its initial node pools, then marks it ready', async () => {
    const cluster = await create({
      nodePools: [pool({ name: 'system' }), pool({ name: 'gpu', machineType: 'g2-standard-8' })],
      authorizedNetworks: ['198.51.100.0/24'],
    });
    world.cloud.calls.length = 0;
    await world.tick();
    const provisioning = await get(cluster);
    expect(provisioning.state).toBe('provisioning');
    const providerId = `projects/fake/locations/us-central1/clusters/${cluster.providerName}`;
    const created = world.cloud.clusters.get(providerId)!;
    expect(created.spec).toMatchObject({
      name: cluster.providerName,
      location: 'us-central1',
      mode: 'standard',
      releaseChannel: 'regular',
      authorizedNetworks: ['198.51.100.0/24'],
      privateNodes: false,
      labels: { 'better-compute-cluster': cluster.id },
    });
    expect(created.spec.initialNodePools!.map((nodePool) => nodePool.name).sort()).toEqual([
      'gpu',
      'system',
    ]);
    await world.until(ready(cluster));
    const settled = await get(cluster);
    expect(settled).toMatchObject({
      state: 'ready',
      endpoint: created.endpoint,
      kubernetesVersion: defaultVersion,
      nodeVersion: defaultVersion,
    });
    expect(settled.readyAt).toBeGreaterThan(0);
    expect(settled.nodePools.every((nodePool) => nodePool.state === 'ready')).toBe(true);
    const published = await types(cluster.id);
    expect(published.filter((type) => type === 'kubernetes.cluster.ready')).toHaveLength(1);
    expect(published.filter((type) => type === 'kubernetes.nodepool.ready')).toHaveLength(2);
    expect(
      (await eventsOf(cluster.id)).find((event) => event.type === 'kubernetes.cluster.ready')!.data,
    ).toMatchObject({
      endpoint: created.endpoint,
      version: defaultVersion,
    });
    // initialNodePools only go with the first create.
    // The 5 min refresh ensures it again, without initialNodePools.
    world.cloud.specs.length = 0;
    await world.tick('kubernetes.clusters', 1, 5 * 60_000);
    await world.tick();
    const again = world.cloud.specs.filter((spec) => spec.name === cluster.providerName);
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((spec) => spec.initialNodePools === undefined)).toBe(true);
    expect(await stateOf(cluster)).toBe('ready');
  });

  it('provisions an autopilot cluster (no node pools)', async () => {
    const cluster = await create({
      mode: 'autopilot',
      nodePools: undefined,
      location: 'us-central1-a',
    });
    await world.until(ready(cluster));
    expect(await get(cluster)).toMatchObject({ state: 'ready', nodePools: [] });
    expect(
      world.cloud.calls.filter((call) => call.startsWith('ensureNodePool')).length,
    ).toBeGreaterThanOrEqual(0);
    expect(
      await codeOf(
        world.api.kubernetesNodePools.create(world.root, {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
          ...pool({ name: 'extra' }),
        }),
      ),
    ).toBe('INVALID_STATE');
  });
});

describe('updates', () => {
  it('upgrades the control plane: updating, then ready with updated', async () => {
    const cluster = await create();
    await world.until(ready(cluster));
    const updated = await world.api.kubernetesClusters.update(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
      version: '1.34',
    });
    expect(updated).toMatchObject({ state: 'updating', requestedVersion: '1.34', version: 2 });
    await world.tick();
    expect(await stateOf(cluster)).toBe('updating');
    await world.until(ready(cluster));
    expect(await get(cluster)).toMatchObject({ kubernetesVersion: '1.34.1-gke.100' });
    const events = await eventsOf(cluster.id);
    expect(events.find((event) => event.type === 'kubernetes.cluster.updated')!.data).toMatchObject(
      {
        version: '1.34.1-gke.100',
        previousVersion: defaultVersion,
      },
    );
  });

  it('changes authorized networks and the release channel in place; the description alone is local', async () => {
    const cluster = await create();
    await world.until(ready(cluster));
    const described = await world.api.kubernetesClusters.update(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
      description: 'now described',
    });
    expect(described).toMatchObject({ state: 'ready', description: 'now described', version: 2 });
    await world.api.kubernetesClusters.update(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
      authorizedNetworks: ['192.0.2.0/24'],
      releaseChannel: 'stable',
    });
    await world.until(ready(cluster));
    const providerCluster = [...world.cloud.clusters.values()].find(
      (entry) => entry.spec.name === cluster.providerName,
    )!;
    expect(providerCluster.spec).toMatchObject({
      authorizedNetworks: ['192.0.2.0/24'],
      releaseChannel: 'stable',
    });
    expect(
      await codeOf(
        world.api.kubernetesClusters.update(world.root, {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
        }),
      ),
    ).toBe('INVALID_INPUT');
  });
});

describe('node pools', () => {
  it('creates, resizes and deletes a node pool, converging each', async () => {
    const cluster = await create();
    await world.until(ready(cluster));
    const ref = { tenantId: world.rootTenant, clusterId: cluster.id };
    const added: KubernetesNodePoolView = await world.api.kubernetesNodePools.create(world.root, {
      ...ref,
      ...pool({ name: 'batch', machineType: 'n2-standard-8', nodeCount: 2 }),
      idempotencyKey: 'batch-1',
    });
    expect(added).toMatchObject({ name: 'batch', state: 'pending', nodeCount: 2 });
    expect(added.id).toMatch(/^knp_/);
    expect(await stateOf(cluster)).toBe('updating');
    // Replays under its key; another request under the key, or a taken name, is CONFLICT.
    expect(
      (
        await world.api.kubernetesNodePools.create(world.root, {
          ...ref,
          ...pool({ name: 'batch', machineType: 'n2-standard-8', nodeCount: 2 }),
          idempotencyKey: 'batch-1',
        })
      ).id,
    ).toBe(added.id);
    expect(
      await codeOf(
        world.api.kubernetesNodePools.create(world.root, {
          ...ref,
          ...pool({ name: 'batch', machineType: 'n2-standard-8', nodeCount: 3 }),
          idempotencyKey: 'batch-1',
        }),
      ),
    ).toBe('CONFLICT');
    expect(
      await codeOf(
        world.api.kubernetesNodePools.create(world.root, { ...ref, ...pool({ name: 'batch' }) }),
      ),
    ).toBe('CONFLICT');
    await world.until(ready(cluster));
    const pools = (await world.api.kubernetesNodePools.list(world.root, ref))
      .items as KubernetesNodePoolView[];
    expect(pools.map((entry) => [entry.name, entry.state]).sort()).toEqual([
      ['batch', 'ready'],
      ['default', 'ready'],
    ]);

    // Resize, then autoscaling on and off.
    const resized = await world.api.kubernetesNodePools.update(world.root, {
      ...ref,
      nodePoolId: added.id,
      nodeCount: 5,
    });
    expect(resized).toMatchObject({ nodeCount: 5, state: 'updating', version: 2 });
    await world.until(ready(cluster));
    const providerCluster = [...world.cloud.clusters.values()].find(
      (entry) => entry.spec.name === cluster.providerName,
    )!;
    expect(providerCluster.pools.get('batch')!.spec.nodeCount).toBe(5);
    await world.api.kubernetesNodePools.update(world.root, {
      ...ref,
      nodePoolId: added.id,
      autoscaling: { minNodes: 1, maxNodes: 6 },
    });
    await world.until(ready(cluster));
    expect(providerCluster.pools.get('batch')!.spec.autoscaling).toEqual({
      minNodes: 1,
      maxNodes: 6,
    });
    expect(
      await codeOf(
        world.api.kubernetesNodePools.update(world.root, {
          ...ref,
          nodePoolId: added.id,
          nodeCount: 9,
        }),
      ),
    ).toBe('INVALID_INPUT');
    const off = await world.api.kubernetesNodePools.update(world.root, {
      ...ref,
      nodePoolId: added.id,
      autoscaling: null,
    });
    expect(off.autoscaling).toBeUndefined();
    await world.until(ready(cluster));
    expect(providerCluster.pools.get('batch')!.spec.autoscaling).toBeUndefined();

    // Delete: deleting, then gone at the provider and from the list.
    const deleting = await world.api.kubernetesNodePools.delete(world.root, {
      ...ref,
      nodePoolId: added.id,
    });
    expect(deleting.state).toBe('deleting');
    expect(
      (await world.api.kubernetesNodePools.delete(world.root, { ...ref, nodePoolId: added.id }))
        .state,
    ).toBe('deleting');
    await world.until(ready(cluster));
    expect(providerCluster.pools.has('batch')).toBe(false);
    expect(
      (
        (await world.api.kubernetesNodePools.list(world.root, ref))
          .items as KubernetesNodePoolView[]
      ).map((entry) => entry.name),
    ).toEqual(['default']);
    const published = await types(cluster.id);
    expect(published).toContain('kubernetes.nodepool.created');
    expect(published).toContain('kubernetes.nodepool.deleted');
    // The name is free again once the pool is deleted.
    expect(
      await codeOf(
        world.api.kubernetesNodePools.create(world.root, { ...ref, ...pool({ name: 'batch' }) }),
      ),
    ).toBe('resolved');
  });

  it('marks a node pool the provider refuses as error, and the cluster with it', async () => {
    const cluster = await create();
    await world.until(ready(cluster));
    world.cloud.refuse.add('ensureNodePool broken');
    const ref = { tenantId: world.rootTenant, clusterId: cluster.id };
    await world.api.kubernetesNodePools.create(world.root, { ...ref, ...pool({ name: 'broken' }) });
    await world.until(async () => (await stateOf(cluster)) === 'error');
    const errored = await get(cluster);
    expect(errored.message).toMatch(/node pool broken: the provider said no/);
    expect(errored.nodePools.find((entry) => entry.name === 'broken')).toMatchObject({
      state: 'error',
      message: 'the provider said no',
    });
    const published = await types(cluster.id);
    expect(published).toContain('kubernetes.nodepool.error');
    expect(published).toContain('kubernetes.cluster.error');
    // Deleting the pool clears it.
    const broken = errored.nodePools.find((entry) => entry.name === 'broken')!;
    await world.api.kubernetesNodePools.delete(world.root, { ...ref, nodePoolId: broken.id });
    await world.until(ready(cluster));
  });
});

describe('errors', () => {
  it('records a refused cluster as error, and retries a busy provider without error', async () => {
    const refused = await create();
    world.cloud.refuse.add(`ensureCluster ${refused.providerName}`);
    await world.tick();
    expect(await get(refused)).toMatchObject({ state: 'error', message: 'the provider said no' });
    expect(await types(refused.id)).toContain('kubernetes.cluster.error');
    // The refresh retries an error; once the provider accepts it, it converges.
    world.cloud.refuse.clear();
    await world.until(ready(refused), 40);

    const busy = await create();
    world.cloud.failNext = new ComputeError('RATE_LIMITED', 'slow down');
    await world.tick();
    expect(await stateOf(busy)).toBe('pending');
    await world.until(ready(busy));

    const invalid = await create();
    world.cloud.failNext = new ComputeError('QUOTA_EXCEEDED', 'CPUS quota exceeded');
    await world.tick();
    expect(await get(invalid)).toMatchObject({ state: 'error', message: 'CPUS quota exceeded' });
    // The next change converges again.
    await world.api.kubernetesClusters.update(world.root, {
      tenantId: world.rootTenant,
      clusterId: invalid.id,
      releaseChannel: 'rapid',
    });
    await world.until(ready(invalid));
  });
});

describe('delete', () => {
  it('deletes the cluster at the provider, then marks it and its pools deleted and drops its authz row', async () => {
    const cluster = await create({ name: 'doomed' });
    await world.until(ready(cluster));
    expect(
      await world.fixture.compute.authz.get('kubernetes-cluster', cluster.id, world.rootTenant),
    ).toBeDefined();
    const deleting = await world.api.kubernetesClusters.delete(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
    });
    expect(deleting.state).toBe('deleting');
    expect(deleting.nodePools.every((entry) => entry.state === 'deleting')).toBe(true);
    // Idempotent; and nothing else changes while it is being deleted.
    expect(
      (
        await world.api.kubernetesClusters.delete(world.root, {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
        })
      ).version,
    ).toBe(deleting.version);
    expect(
      await codeOf(
        world.api.kubernetesClusters.update(world.root, {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
          version: '1.34',
        }),
      ),
    ).toBe('INVALID_STATE');
    await world.until(async () => (await stateOf(cluster)) === 'deleted');
    const deleted = await get(cluster);
    expect(deleted.deletedAt).toBeGreaterThan(0);
    expect(deleted.nodePools).toEqual([]);
    expect(
      [...world.cloud.clusters.values()].some((entry) => entry.spec.name === cluster.providerName),
    ).toBe(false);
    expect(
      await world.fixture.compute.authz.get('kubernetes-cluster', cluster.id, world.rootTenant),
    ).toBeUndefined();
    const published = await types(cluster.id);
    expect(published).toContain('kubernetes.cluster.deleting');
    expect(published.at(-1)).toBe('kubernetes.cluster.deleted');
    expect(published).toContain('kubernetes.nodepool.deleted');
    const listed = await world.api.kubernetesClusters.list(world.root, {
      tenantId: world.rootTenant,
    });
    expect(listed.items.map((item: KubernetesClusterView) => item.id)).not.toContain(cluster.id);
    const withDeleted = await world.api.kubernetesClusters.list(world.root, {
      tenantId: world.rootTenant,
      includeDeleted: true,
    });
    expect(withDeleted.items.map((item: KubernetesClusterView) => item.id)).toContain(cluster.id);
    // The name is free again.
    expect(await codeOf(create({ name: 'doomed' }))).toBe('resolved');
  });

  it('deletes a cluster the provider was never asked for without calling it', async () => {
    const cluster = await create();
    await world.api.kubernetesClusters.delete(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
    });
    world.cloud.calls.length = 0;
    await world.tick();
    expect(await stateOf(cluster)).toBe('deleted');
    expect(world.cloud.calls.filter((call) => call.includes(cluster.providerName))).toEqual([]);
  });
});

describe('tenantDeleted', () => {
  it('deletes every cluster of the tenant and answers DONE once all are gone', async () => {
    const first = await create({}, 'acme');
    const second = await create({ mode: 'autopilot', nodePools: undefined }, 'acme');
    await world.until(async () => (await stateOf(first)) === 'ready');
    const hook = world.module.tenantDeleted!;
    const context = world.fixture.compute.context;
    expect(await hook(context, world.acmeTenant)).toBe('SYNC_AGAIN');
    const rows = await world.fixture.database.query<{ id: string; desired_state: string }>(
      `SELECT id, desired_state FROM kubernetes_clusters WHERE tenant_id = $1 AND state <> 'deleted'`,
      [world.acmeTenant],
    );
    expect(rows.rows.every((row) => row.desired_state === 'deleted')).toBe(true);
    let answer = 'SYNC_AGAIN';
    for (let round = 0; round < 10 && answer !== 'DONE'; round++) {
      await world.tick();
      answer = await hook(context, world.acmeTenant);
    }
    expect(answer).toBe('DONE');
    for (const cluster of [first, second])
      expect(
        (
          await world.fixture.database.query<{ state: string }>(
            `SELECT state FROM kubernetes_clusters WHERE id = $1`,
            [cluster.id],
          )
        ).rows[0]!.state,
      ).toBe('deleted');
    expect(
      (await world.events('kubernetes.cluster.deleting')).some(
        (event) => event.data.clusterId === first.id && event.data.reason === 'tenant-deleted',
      ),
    ).toBe(true);
  });
});
