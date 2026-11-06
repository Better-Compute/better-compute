import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, newId } from '@better-compute/core';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// Pool substrates, teardown: archiving the pool (or removing policy.substrate) tears down what the substrate made,
// with drain semantics: the token goes, the pool's nodes are cordoned, live bookings are waited for (never
// force-released), bcd leaves the cluster, then a created cluster is deleted; an adopted one never is (only the
// node pools the substrate added go).

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const create = { kind: 'kubernetes', cluster: { create: { location: 'us-central1' } }, flavors: [gpu] };
const adoptId = 'projects/fake/locations/us-central1/clusters/prod';

function existingCluster(target: SubstrateWorld) {
  target.cloud.clusters.set(adoptId, {
    id: adoptId,
    spec: {
      name: 'prod',
      location: 'us-central1',
      mode: 'standard',
      releaseChannel: 'regular',
      authorizedNetworks: [],
      privateNodes: false,
    },
    version: '1.33.5-gke.1000',
    endpoint: 'https://34.118.9.1',
    ready: true,
    pools: new Map([
      ['default', { spec: { name: 'default', machineType: 'e2-standard-4', nodeCount: 2 }, ready: true }],
    ]),
  });
}

const archive = (poolId: string) =>
  world!.api.pools.archive(world!.root, { tenantId: world!.rootTenant, poolId });

async function book(nodeId: string, poolId: string, hours = 1): Promise<string> {
  const id = newId('alloc');
  await world!.fixture.database.query(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
     VALUES ($1, $2, $3, $4, 'reservation', $5, tstzrange(compute_now(), compute_now() + make_interval(hours => $6)), 1)`,
    [id, world!.rootTenant, poolId, nodeId, newId('res'), hours],
  );
  return id;
}

describe('substrate: teardown', () => {
  it('archiving the pool deletes the created cluster, revokes the token and cordons the nodes', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(create);
    await world.converge(pool.id, 6);
    const ready = await world.substrate(pool.id);
    const [node] = await world.joinNodes(pool.id, 1);
    const provider = [...world.cloud.clusters.keys()][0]!;
    await archive(pool.id);
    await world.converge(pool.id, 10);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted', desired_state: 'deleted' });
    expect(world.cloud.clusters.has(provider)).toBe(false);
    expect(world.cloud.calls).toContain(`deleteCluster ${provider}`);
    const cluster = await world.api.kubernetesClusters.get(world.root, { tenantId: world.rootTenant, clusterId: ready.cluster_id });
    expect(cluster.state).toBe('deleted');
    const token = await world.fixture.database.query<any>(`SELECT revoked_at FROM join_tokens WHERE id = $1`, [
      ready.join_token_id,
    ]);
    expect(token.rows[0].revoked_at).not.toBeNull();
    const { rows } = await world.fixture.database.query<any>(
      `SELECT cordoned, no_schedule_reasons FROM nodes WHERE id = $1`,
      [node],
    );
    expect(rows[0]).toMatchObject({ cordoned: true, no_schedule_reasons: ['substrate-teardown'] });
    const types = (await world.events('kubernetes.substrate.')).map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(['kubernetes.substrate.deleting', 'kubernetes.substrate.deleted']));
  });

  it('waits for live bookings to end before anything is deleted (drain semantics)', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(create);
    await world.converge(pool.id, 6);
    const [node] = await world.joinNodes(pool.id, 1);
    const allocation = await book(node!, pool.id);
    await archive(pool.id);
    await world.converge(pool.id, 6);
    const waiting = await world.substrate(pool.id);
    expect(waiting).toMatchObject({ state: 'deleting' });
    expect(waiting.message).toMatch(/Waiting for 1 booking/);
    expect(world.cloud.calls.some((call) => call.startsWith('deleteCluster'))).toBe(false);
    // Nothing was released on the node's behalf.
    const open = await world.fixture.database.query<any>(`SELECT released_at FROM allocations WHERE id = $1`, [allocation]);
    expect(open.rows[0].released_at).toBeNull();
    await world.fixture.database.query(`UPDATE allocations SET released_at = compute_now() WHERE id = $1`, [allocation]);
    await world.converge(pool.id, 20);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect(world.cloud.calls.some((call) => call.startsWith('deleteCluster'))).toBe(true);
  });

  it('never deletes an adopted cluster: bcd and the added node pools go, the cluster stays', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool({ kind: 'kubernetes', cluster: { adopt: adoptId }, flavors: [{ ...gpu, nodes: 1 }] });
    await world.converge(pool.id, 8);
    expect(world.kube.kinds('https://34.118.9.1')).toContain('DaemonSet/bcd');
    await archive(pool.id);
    await world.converge(pool.id, 10);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect(world.cloud.clusters.has(adoptId)).toBe(true);
    expect([...world.cloud.clusters.get(adoptId)!.pools.keys()]).toEqual(['default']);
    expect(world.cloud.calls.some((call) => call.startsWith('deleteCluster'))).toBe(false);
    expect(world.kube.kinds('https://34.118.9.1')).toEqual([]);
  });

  it('keeps tearing down an adopted cluster until bcd is really gone (a refused delete is never "done")', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const server = 'https://34.118.9.1';
    const pool = await world.createPool({ kind: 'kubernetes', cluster: { adopt: adoptId }, flavors: [{ ...gpu, nodes: 1 }] });
    await world.converge(pool.id, 8);
    expect(world.kube.kinds(server)).toContain('DaemonSet/bcd');
    // RBAC on the tenant's cluster refuses the DaemonSet's delete.
    world.kube.failDelete = { path: /\/daemonsets\/bcd$/, status: 403 };
    await archive(pool.id);
    await world.converge(pool.id, 10);
    const stuck = await world.substrate(pool.id);
    expect(stuck).toMatchObject({ state: 'deleting', desired_state: 'deleted' });
    expect(stuck.message).toMatch(/bcd could not be removed from the adopted cluster/);
    expect(world.kube.kinds(server)).toContain('DaemonSet/bcd');
    const { rows } = await world.fixture.database.query<{ desired_state: string }>(
      `SELECT desired_state FROM kubernetes_clusters WHERE id = $1`,
      [stuck.cluster_id],
    );
    expect(rows[0]!.desired_state).toBe('present');
    // Fixed: the next tries remove bcd, then the substrate is deleted.
    delete world.kube.failDelete;
    await world.converge(pool.id, 30);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect(world.kube.kinds(server)).toEqual([]);
  });

  it('keeps tearing down an adopted cluster whose credential is refused, unless the cluster is gone', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const pool = await world.createPool({ kind: 'kubernetes', cluster: { adopt: adoptId }, flavors: [] });
    await world.converge(pool.id, 6);
    await archive(pool.id);
    world.cloud.failNext = new ComputeError('ACCESS_DENIED', 'the account may not mint credentials');
    await world.converge(pool.id, 1);
    const stuck = await world.substrate(pool.id);
    expect(stuck.state).toBe('deleting');
    expect(stuck.message).toMatch(/credentials: .*may not mint/);
    expect(world.kube.kinds('https://34.118.9.1')).toContain('DaemonSet/bcd');
    // The tenant deleted the cluster meanwhile: nothing is left to remove.
    world.cloud.clusters.delete(adoptId);
    await world.converge(pool.id, 20);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
  });

  it('removing policy.substrate tears down too, and a new substrate can follow', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(create);
    await world.converge(pool.id, 6);
    const first = await world.substrate(pool.id);
    const { substrate: _substrate, ...without } = pool.policy;
    const updated = await world.api.pools.update(world.root, { tenantId: world.rootTenant, poolId: pool.id, policy: without });
    await world.converge(pool.id, 10);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...updated.policy, substrate: pool.policy.substrate },
    });
    await world.converge(pool.id, 8);
    const second = await world.substrate(pool.id);
    expect(second).toMatchObject({ state: 'ready', desired_state: 'present' });
    expect(second.cluster_id).not.toBe(first.cluster_id);
  });
});
