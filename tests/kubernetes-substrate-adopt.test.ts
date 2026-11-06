import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import { meterClusters, substrateNodePoolName, substratePoolLabel } from '@better-compute/kubernetes';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// Pool substrates, adopt mode: an existing cluster (not made by better-compute) backs a pool. Its row is `adopted`:
// the cluster reconciler reads it (getCluster) and never creates, changes or deletes it; only the node pools the
// substrate's flavors add are created in it. Adopted clusters bill no cluster hours (not ours).

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const adoptId = 'projects/fake/locations/us-central1/clusters/prod';
const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 1, gpus: { type: 'nvidia-l4', count: 1 } };

/** A cluster that exists at the fake provider with a 2-node `default` pool better-compute knows nothing about. */
function existingCluster(target: SubstrateWorld, id = adoptId, endpoint = 'https://34.118.9.1') {
  target.cloud.clusters.set(id, {
    id,
    spec: {
      name: id.split('/').pop()!,
      location: 'us-central1',
      mode: 'standard',
      releaseChannel: 'regular',
      authorizedNetworks: [],
      privateNodes: false,
    },
    version: '1.33.5-gke.1000',
    endpoint,
    ready: true,
    pools: new Map([
      [
        'default',
        { spec: { name: 'default', machineType: 'e2-standard-4', nodeCount: 2, labels: { team: 'ml' } }, ready: true },
      ],
    ]),
  });
}

const adopt = (flavors: unknown[] = []) => ({ kind: 'kubernetes', cluster: { adopt: adoptId }, flavors });

describe('substrate: adopt', () => {
  it('reads the cluster, never creates or changes it, and runs bcd on every node', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool(adopt());
    await world.converge(pool.id, 6);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ mode: 'adopt', adopt_id: adoptId, state: 'ready', nodes_listed: 2 });
    const cluster = await world.api.kubernetesClusters.get(world.root, { tenantId: world.rootTenant, clusterId: row.cluster_id });
    expect(cluster).toMatchObject({ adopted: true, substratePoolId: pool.id, location: 'us-central1', state: 'ready' });
    expect(world.cloud.calls.filter((call) => call.startsWith('ensureCluster'))).toEqual([]);
    expect(world.cloud.calls).toContain(`getCluster ${adoptId}`);
    // No flavors: the DaemonSet runs on every node of the cluster; a token for both.
    const daemonSet = world.kube.get('https://34.118.9.1', '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
    expect(daemonSet.spec.template.spec.nodeSelector).toBeUndefined();
    const { rows } = await world.fixture.database.query<any>(`SELECT uses_left FROM join_tokens WHERE id = $1`, [row.join_token_id]);
    expect(rows[0].uses_left).toBe(2);
  });

  it("adds the flavors' node pools to it, and selects only their nodes", async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool(adopt([gpu]));
    await world.converge(pool.id, 8);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ state: 'ready', nodes_listed: 1 });
    // Named so it cannot be one of the cluster's own pools: bc-<pool>-<flavor>.
    const name = substrateNodePoolName(pool.id, 'gpu');
    expect(name).toMatch(/^bc-[a-z0-9]{6}-gpu$/);
    expect([...world.cloud.clusters.get(adoptId)!.pools.keys()].sort()).toEqual([name, 'default'].sort());
    expect(world.cloud.clusters.get(adoptId)!.pools.get(name)!.spec.labels).toMatchObject({ [substratePoolLabel]: pool.id });
    const daemonSet = world.kube.get('https://34.118.9.1', '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
    expect(daemonSet.spec.template.spec.nodeSelector).toEqual({ [substratePoolLabel]: pool.id });
  });

  it("never takes over or deletes the cluster's own pool, even with a flavor of the same name", async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool(adopt([{ ...gpu, name: 'default', machineType: 'e2-standard-4', gpus: undefined, nodes: 5 }]));
    await world.converge(pool.id, 8);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready', nodes_listed: 5 });
    const pools = world.cloud.clusters.get(adoptId)!.pools;
    // The tenant's 'default' pool was never resized; the substrate's lives beside it.
    expect(pools.get('default')!.spec).toMatchObject({ name: 'default', nodeCount: 2 });
    expect(pools.get(substrateNodePoolName(pool.id, 'default'))!.spec.nodeCount).toBe(5);
    expect(world.cloud.calls).not.toContain('ensureNodePool default');
    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: pool.id });
    await world.converge(pool.id, 10);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect([...pools.keys()]).toEqual(['default']);
    expect(pools.get('default')!.spec.nodeCount).toBe(2);
    expect(world.cloud.calls).not.toContain('deleteNodePool default');
  });

  it('is an error when the cluster does not exist, and one cluster backs one pool only', async () => {
    world = await substrateWorld();
    const missing = await world.createPool(adopt());
    await world.converge(missing.id, 4);
    const row = await world.substrate(missing.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/does not exist at the provider/);
    existingCluster(world);
    // Errors are retried by the periodic refreshes (clusters every 5 minutes).
    await world.converge(missing.id, 20);
    expect(await world.substrate(missing.id)).toMatchObject({ state: 'ready' });
    const second = await world.createPool(adopt(), 'second');
    await world.converge(second.id, 2);
    expect(await world.substrate(second.id)).toMatchObject({ state: 'error', cluster_id: null });
    expect((await world.substrate(second.id)).message).toMatch(/already pool .*'s substrate/);
  });

  it('refuses direct changes to a substrate cluster, and bills no hours for an adopted one', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool(adopt([gpu]));
    await world.converge(pool.id, 8);
    const { cluster_id: clusterId } = await world.substrate(pool.id);
    const ref = { tenantId: world.rootTenant, clusterId };
    for (const attempt of [
      world.api.kubernetesClusters.update(world.root, { ...ref, version: '1.34' }),
      world.api.kubernetesClusters.delete(world.root, ref),
      world.api.kubernetesNodePools.create(world.root, { ...ref, name: 'extra', machineType: 'e2-standard-4', nodeCount: 1 }),
    ]) {
      const error = await attempt.catch((thrown: unknown) => thrown);
      expect(isComputeError(error, 'INVALID_STATE')).toBe(true);
    }
    await world.fixture.advance(3 * 3_600_000);
    const metered = await world.fixture.compute.context.sql.transaction((tx) =>
      meterClusters(tx, world!.fixture.compute.context.clock.now()),
    );
    expect(metered.windows).toBe(0);
  });
});
