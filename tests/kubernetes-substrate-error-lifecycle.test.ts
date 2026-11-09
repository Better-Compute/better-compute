import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// A cluster or substrate error must not halt node lifecycle. When one flavor's node pool is refused (quota, a
// stockout) the cluster row goes to `error`; when a policy edit cannot be converged (a flavor's shape changed, the
// account or cluster changed) the substrate does. The nodes that already joined still live on a control plane that
// works: a Node that goes (a scale-down, a Spot reclaim) must still be retired with its bookings ended, and a
// replacement Node must still get a join token. Only an unusable control plane (never ready, no provider id) stops
// the substrate.

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const extra = { name: 'extra', machineType: 'e2-standard-4', nodes: 1 };
const spec = (flavors: unknown[]) => ({ kind: 'kubernetes', cluster: { create: { location: 'us-central1' } }, flavors });

const provisionStates = async (ids: readonly string[]) =>
  new Map(
    (
      await world!.fixture.database.query<{ id: string; provision_state: string }>(
        `SELECT id, provision_state FROM nodes WHERE id = ANY($1)`,
        [ids],
      )
    ).rows.map((row) => [row.id, row.provision_state]),
  );

/** A ready substrate with two joined, matched nodes. */
async function readyWithTwoNodes() {
  world = await substrateWorld();
  const pool = await world.createPool(spec([gpu]));
  await world.converge(pool.id, 6);
  const names = (await world.nodeNames(pool.id)).sort();
  const joined = await world.joinNodes(pool.id, 2, names);
  await world.converge(pool.id, 3);
  expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready', nodes_joined: 2, join_token_id: null });
  return { pool, names, joined };
}

const update = (pool: any, flavors: unknown[]) =>
  world!.api.pools.update(world!.root, {
    tenantId: world!.rootTenant,
    poolId: pool.id,
    policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors } },
  });

/** A Node goes (a Spot reclaim, a repair) with the node pool's count unchanged, and its bcd goes away. */
async function reclaim(name: string, nodeId: string) {
  world!.reclaimed.add(name);
  await world!.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [nodeId]);
}

describe('substrate: an error does not halt node lifecycle', () => {
  it('retires a gone node and mints a token for a new Node while a refused node pool keeps the cluster in error', async () => {
    const { pool, names, joined } = await readyWithTwoNodes();
    // A second flavor the provider refuses (quota): its node pool, and the cluster with it, go to error.
    world!.cloud.refuse.add('ensureNodePool extra');
    await update(pool, [gpu, extra]);
    await world!.converge(pool.id, 4);
    const cluster = await world!.api.kubernetesClusters.get(world!.root, {
      tenantId: world!.rootTenant,
      clusterId: (await world!.substrate(pool.id)).cluster_id,
    });
    expect(cluster).toMatchObject({ state: 'error' });
    expect(cluster.message).toMatch(/node pool extra/);
    expect(await world!.substrate(pool.id)).toMatchObject({ state: 'error', nodes_listed: 2, nodes_joined: 2 });

    // The gpu flavor scales down to one Node: the provider drops the second, and its bcd goes away.
    await update(pool, [{ ...gpu, nodes: 1 }, extra]);
    await world!.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [joined[1]]);
    await world!.converge(pool.id, 6);
    expect(await world!.nodeNames(pool.id)).toEqual([names[0]]);
    expect(await provisionStates(joined)).toEqual(
      new Map([
        [joined[0], 'adopted'],
        [joined[1], 'retired'],
      ]),
    );
    expect((await world!.events('kubernetes.substrate.node-removed')).map((event) => event.data)).toEqual([
      expect.objectContaining({ nodeId: joined[1], kubernetesNode: names[1], retired: true }),
    ]);

    // It scales up again: the new Node gets a join token although the cluster is still in error.
    await update(pool, [gpu, extra]);
    await world!.converge(pool.id, 6);
    const row = await world!.substrate(pool.id);
    expect(row).toMatchObject({ state: 'error', nodes_listed: 2, nodes_joined: 1, token_applied: true });
    expect(row.message).toMatch(/^cluster: node pool extra/);
    const { rows: tokens } = await world!.fixture.database.query<{ uses_left: number; revoked_at: unknown }>(
      `SELECT uses_left, revoked_at FROM join_tokens WHERE id = $1`,
      [row.join_token_id],
    );
    expect(tokens[0]).toMatchObject({ uses_left: 1, revoked_at: null });

    // The provider takes the flavor after all: the substrate is ready again.
    world!.cloud.refuse.clear();
    await world!.joinNodes(pool.id, 1, [names[1]]);
    await world!.fixture.advance(5 * 60_000);
    await world!.converge(pool.id, 8);
    expect(await world!.substrate(pool.id)).toMatchObject({ state: 'ready', message: null, nodes_listed: 3 });
  });

  it('keeps retiring gone nodes while the policy asks for a flavor change it cannot make in place', async () => {
    const { pool, names, joined } = await readyWithTwoNodes();
    await update(pool, [{ ...gpu, machineType: 'a2-highgpu-1g' }]);
    await world!.converge(pool.id, 4);
    expect((await world!.substrate(pool.id)).message).toMatch(/flavor gpu: machineType cannot change in place/);
    await reclaim(names[1]!, joined[1]!);
    await world!.fixture.advance(2 * 60_000);
    await world!.converge(pool.id, 3);
    expect(await world!.nodeNames(pool.id)).toEqual([names[0]]);
    expect((await provisionStates(joined)).get(joined[1]!)).toBe('retired');
    const row = await world!.substrate(pool.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/flavor gpu: machineType cannot change in place/);
  });

  it('keeps retiring gone nodes while the substrate policy asks for another cluster (never moved in place)', async () => {
    const { pool, names, joined } = await readyWithTwoNodes();
    await world!.api.pools.update(world!.root, {
      tenantId: world!.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, cluster: { create: { location: 'europe-west4' } } } },
    });
    await world!.converge(pool.id, 4);
    expect((await world!.substrate(pool.id)).message).toMatch(/never moved in place/);
    await reclaim(names[1]!, joined[1]!);
    await world!.fixture.advance(2 * 60_000);
    await world!.converge(pool.id, 3);
    expect(await world!.nodeNames(pool.id)).toEqual([names[0]]);
    expect((await provisionStates(joined)).get(joined[1]!)).toBe('retired');
    expect(world!.cloud.calls.some((call) => call.startsWith('delete'))).toBe(false);
    expect((await world!.substrate(pool.id)).message).toMatch(/never moved in place/);
  });

  it('still stops at a cluster that was never ready: nothing is applied to an unusable control plane', async () => {
    world = await substrateWorld();
    // The provider refuses the cluster itself (its first call throws): it never had a control plane.
    world.cloud.failNext = new ComputeError('QUOTA_EXCEEDED', 'quota exceeded for clusters');
    const pool = await world.createPool(spec([gpu]));
    await world.converge(pool.id, 4);
    const row = await world.substrate(pool.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/^cluster: /);
    expect(world.cloud.calls.some((call) => call.startsWith('credentials'))).toBe(false);
    expect(world.kube.calls).toEqual([]);
  });
});
