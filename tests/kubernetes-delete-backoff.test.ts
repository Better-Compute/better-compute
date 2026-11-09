import { afterEach, describe, expect, it } from 'vitest';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// A delete the provider refuses for good (the cluster is in use, the account lost its permission) used to be tried
// every 30 s forever: the fast sweeps queued every row with `desired_state = 'deleted'` that was not `deleted`, the
// one in `error` included, and a substrate polled its cluster every 10 s on top. Such a row now leaves the fast
// sweeps and is retried by the refreshes with exponential backoff, counted from when it went to error.

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 1, gpus: { type: 'nvidia-l4', count: 1 } };

/** Runs both reconcilers every 30 s of simulated time for `minutes`. */
async function run(minutes: number) {
  for (let step = 0; step < minutes * 2; step++) {
    await world!.fixture.advance(30_000);
    await world!.fixture.compute.jobs['kubernetes.clusters']!.tick();
    await world!.fixture.compute.jobs['kubernetes.substrates']!.tick();
  }
}

const deletes = () => world!.cloud.calls.filter((call) => call.startsWith('deleteCluster')).length;

describe('a delete the provider refuses', () => {
  it('is retried with exponential backoff, not every 30 seconds, and at once when the delete is asked for again', async () => {
    world = await substrateWorld();
    const cluster = await world.api.kubernetesClusters.create(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      name: 'stuck',
      mode: 'standard',
      location: 'us-central1',
      nodePools: [{ name: 'system', machineType: 'e2-standard-4', nodeCount: 1 }],
      idempotencyKey: 'stuck',
    });
    const ref = { tenantId: world.rootTenant, clusterId: cluster.id };
    await run(2);
    expect((await world.api.kubernetesClusters.get(world.root, ref)).state).toBe('ready');
    world.cloud.refuse.add(`deleteCluster ${cluster.providerName}`);
    await world.api.kubernetesClusters.delete(world.root, ref);
    await run(1);
    expect(await world.api.kubernetesClusters.get(world.root, ref)).toMatchObject({
      state: 'error',
      message: 'the provider said no',
    });
    const first = deletes();
    // Four hours of sweeps: the retries come about 5, 10, 20, 40, 80 and 160 minutes after the last one.
    const seen: number[] = [];
    for (let quarter = 0; quarter < 16; quarter++) {
      await run(15);
      seen.push(deletes() - first);
    }
    const total = seen.at(-1)!;
    expect(total).toBeGreaterThanOrEqual(4);
    expect(total).toBeLessThanOrEqual(7);
    // The first hour holds most of them; the last two hours at most one.
    expect(seen[3]).toBeGreaterThanOrEqual(3);
    expect(total - seen[7]!).toBeLessThanOrEqual(1);
    expect((await world.api.kubernetesClusters.get(world.root, ref)).state).toBe('error');

    // Asking again tries now, whatever the backoff says; the row itself does not change.
    const before = deletes();
    const version = (await world.api.kubernetesClusters.get(world.root, ref)).version;
    expect((await world.api.kubernetesClusters.delete(world.root, ref)).version).toBe(version);
    await run(1);
    expect(deletes()).toBe(before + 1);

    // The provider lets go: the next try deletes it.
    world.cloud.refuse.clear();
    await world.api.kubernetesClusters.delete(world.root, ref);
    await run(2);
    expect((await world.api.kubernetesClusters.get(world.root, ref)).state).toBe('deleted');
  }, 120_000);

  it("stops a substrate's teardown in error without polling, and finishes it once the cluster is gone", async () => {
    world = await substrateWorld();
    const pool = await world.createPool({
      kind: 'kubernetes',
      cluster: { create: { location: 'us-central1' } },
      flavors: [gpu],
    });
    await world.converge(pool.id, 6);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready' });
    const { rows } = await world.fixture.database.query<{ provider_name: string }>(
      `SELECT provider_name FROM kubernetes_clusters WHERE substrate_pool_id = $1`,
      [pool.id],
    );
    world.cloud.refuse.add(`deleteCluster ${rows[0]!.provider_name}`);
    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: pool.id });
    await run(2);
    const stuck = await world.substrate(pool.id);
    expect(stuck).toMatchObject({ state: 'error', desired_state: 'deleted', message: 'cluster: the provider said no' });
    // Two hours: the substrate looks a handful of times (2, 4, 8, ... minutes apart), the provider is asked a
    // handful of times; before, it was 240 looks and 240 deletes.
    const first = deletes();
    const looks = new Set<string>();
    for (let step = 0; step < 240; step++) {
      await run(0.5);
      const row = await world.substrate(pool.id);
      if (row.retried_at !== null) looks.add(new Date(row.retried_at).toISOString());
    }
    expect(looks.size).toBeGreaterThanOrEqual(3);
    expect(looks.size).toBeLessThanOrEqual(8);
    expect(deletes() - first).toBeLessThanOrEqual(6);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'error', desired_state: 'deleted' });

    // The provider lets go. The cluster's next retry deletes it and wakes the substrate, which finishes.
    world.cloud.refuse.clear();
    await run(6 * 60);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect(world.cloud.clusters.size).toBe(0);
  }, 180_000);
});
