import { afterEach, describe, expect, it } from 'vitest';
import { substrateFirstConnectGraceSeconds } from '@better-compute/kubernetes';
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

  it('still matches a reporting node while more than a run of 500 connected nodes report no Node name', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec(1));
    await world.converge(pool.id, 6);
    const db = world.fixture.database;
    const { rows: owner } = await db.query<{ site_id: string; owner_tenant_id: string }>(
      `SELECT site_id, owner_tenant_id FROM pools WHERE id = $1`,
      [pool.id],
    );
    // 501 connected nodes of the substrate's whose inventory is not in (a join burst, an inventory outage); their ids
    // sort before any other node's.
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT 'node_00' || lpad(g::text, 24, '0'), $2, $1, $3, 'host', 'adopted', false, false, 'connected', 'platform',
              1, 1, 1, 1, 0, 1
         FROM generate_series(1, 501) g`,
      [pool.id, owner[0]!.site_id, owner[0]!.owner_tenant_id],
    );
    await db.query(
      `INSERT INTO kubernetes_substrate_nodes (node_id, pool_id, owned)
       SELECT 'node_00' || lpad(g::text, 24, '0'), $1, true FROM generate_series(1, 501) g`,
      [pool.id],
    );
    const [name] = await world.nodeNames(pool.id);
    const [reporting] = await world.joinNodes(pool.id, 1, [name]);
    await world.converge(pool.id, 6);
    const { rows } = await db.query<{ kubernetes_node: string | null }>(
      `SELECT kubernetes_node FROM kubernetes_substrate_nodes WHERE node_id = $1`,
      [reporting],
    );
    expect(rows[0]!.kubernetes_node).toBe(name);
  }, 60_000);

  it('retires a node that connected and went away before it ever reported its Node name, after the grace window', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec(2));
    await world.converge(pool.id, 6);
    const names = (await world.nodeNames(pool.id)).sort();
    // One reports its Node name; one connected and was Spot-reclaimed before its first inventory; one reports a
    // hostname that is no Node's (EKS): never matched, so a long disconnect must still end nothing.
    const [kept] = await world.joinNodes(pool.id, 1, [names[0]]);
    const [reclaimed] = await world.joinNodes(pool.id, 1);
    const [unmatched] = await world.joinNodes(pool.id, 1, ['ip-10-0-1-9']);
    await world.converge(pool.id, 3);
    const gone = [reclaimed, unmatched];
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = ANY($1)`, [gone]);
    await world.fixture.database.query(
      `UPDATE node_sessions SET disconnected_at = compute_now() WHERE node_id = ANY($1)`,
      [gone],
    );
    const states = async () =>
      new Map(
        (
          await world!.fixture.database.query<{ id: string; provision_state: string }>(
            `SELECT id, provision_state FROM nodes WHERE id = ANY($1)`,
            [[kept, reclaimed, unmatched]],
          )
        ).rows.map((row) => [row.id, row.provision_state]),
      );
    // A bcd pod restart is not a reclaim: nothing within the grace window.
    await world.converge(pool.id, 3);
    expect([...(await states()).values()]).toEqual(['adopted', 'adopted', 'adopted']);
    await world.fixture.advance(substrateFirstConnectGraceSeconds * 1000);
    await world.converge(pool.id, 3);
    const after = await states();
    expect(after.get(reclaimed!)).toBe('retired');
    expect(after.get(kept!)).toBe('adopted');
    expect(after.get(unmatched!)).toBe('adopted');
    const removed = (await world.events('kubernetes.substrate.node-removed')).map((event) => event.data);
    expect(removed).toEqual([expect.objectContaining({ nodeId: reclaimed, reason: 'never-reported', retired: true })]);
  });
});
