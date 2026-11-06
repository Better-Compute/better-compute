import { afterEach, describe, expect, it } from 'vitest';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// Found by the multicloud fleet pool runs (tests/e2e/kubernetes-fleet-pool-*.test.ts): a node the substrate looks at
// before its first inventory arrived (it reports no Node name yet) must be looked at again on the next run, not an
// hour later. Otherwise a scale-down or a Spot reclaim right after a join leaves a node that is never matched, so its
// Node going is never noticed: never retired, its bookings never ended.

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const spec = (nodes: number) => ({
  kind: 'kubernetes',
  cluster: { create: { location: 'us-central1' } },
  flavors: [{ ...gpu, nodes }],
});

describe('substrate: a node that joined before it reported its Node name', () => {
  it('is matched once its inventory arrives, and retired when its Node goes', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec(2));
    await world.converge(pool.id, 6);
    // bcd connected, its inventory not in yet: no Node name to match.
    const joined = await world.joinNodes(pool.id, 2);
    await world.converge(pool.id, 2);
    // Now it reports its Node names.
    const names = (await world.nodeNames(pool.id)).sort();
    for (const [index, nodeId] of joined.entries())
      await world.fixture.database.query(
        `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
         VALUES ($1, $2, decode($3, 'hex'), '{}'::jsonb, $4::jsonb, compute_now())`,
        [`inv_${nodeId}`, nodeId, 'ab'.repeat(32), JSON.stringify({ kubernetes: { nodeName: names[index] } })],
      );
    // The next runs (a ready substrate runs again within 5 minutes), not the hour an unmatched node waits.
    await world.converge(pool.id, 18);
    const { rows: matched } = await world.fixture.database.query<{ node_id: string; kubernetes_node: string | null }>(
      `SELECT node_id, kubernetes_node FROM kubernetes_substrate_nodes WHERE pool_id = $1 ORDER BY kubernetes_node`,
      [pool.id],
    );
    expect(matched.map((row) => row.kubernetes_node)).toEqual(names);
    // A scale-down: the last Node goes, and its bcd with it.
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors: [{ ...gpu, nodes: 1 }] } },
    });
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [joined[1]]);
    await world.converge(pool.id, 6);
    const { rows } = await world.fixture.database.query<{ id: string; provision_state: string }>(
      `SELECT id, provision_state FROM nodes WHERE id = ANY($1) ORDER BY id`,
      [joined],
    );
    expect(new Map(rows.map((row) => [row.id, row.provision_state]))).toEqual(
      new Map([
        [joined[0], 'adopted'],
        [joined[1], 'retired'],
      ]),
    );
  });
});
