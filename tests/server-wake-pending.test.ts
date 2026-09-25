import { afterEach, describe, expect, it } from 'vitest';
import { shardOf } from '@better-compute/core';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';

// The node controller wakes a pool's pending reservations when one of its nodes becomes
// schedulable (uncordon here; adoption, a first converged spec and a cleared NoSchedule reason
// take the same edge), so they place at once instead of after their back-off. Once per edge.

afterEach(closeFixtures);

const SITE = 'site_wake';
const POOL = 'pool_wake';
const NODE = 'node_wake1';
const RESERVATION = 'rsv_wake1';

async function setup(): Promise<ComputeFixture> {
  const fixture = await computeFixture({ clock: 'sim' });
  const { database, tenants } = fixture;
  await database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, tenants.root.id],
  );
  await database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [POOL, tenants.root.id, SITE],
  );
  // Schedulable in every respect but the cordon.
  await database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, true, 'connected', 'platform', '{}', 1, 1, 1, 1, $5, 1)`,
    [NODE, SITE, POOL, tenants.root.id, shardOf(NODE)],
  );
  // Connected through a live gateway, so Liveness keeps it connected.
  await database.query(
    `INSERT INTO leases (name, owner, epoch, expires_at)
     VALUES ('gateway:gw_wake', 'gw_wake', 1, compute_now() + interval '1 hour')`,
  );
  await database.query(
    `INSERT INTO node_sessions (node_id, gateway_id, session_epoch, last_seen, connected_at)
     VALUES ($1, 'gw_wake', 1, compute_now(), compute_now())`,
    [NODE],
  );
  await database.query(
    `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, owner_identity_id,
       idempotency_key, version)
     VALUES ($1, $2, $3, 'pending', '{}', '\\x00', 'id-owner', 'key-1', 1)`,
    [RESERVATION, tenants.root.id, POOL],
  );
  return fixture;
}

async function wakeGen(fixture: ComputeFixture): Promise<number | undefined> {
  const { rows } = await fixture.database.query<{ gen: unknown }>(
    `SELECT gen FROM work_queue WHERE kind = 'capacity.reservations' AND key = $1`,
    [RESERVATION],
  );
  return rows[0] ? Number(rows[0].gen) : undefined;
}

const runNode = async (fixture: ComputeFixture) => {
  await fixture.compute.context.work.enqueue(fixture.database, 'node', NODE);
  await fixture.compute.jobs.node!.tick();
};

describe('pending reservations wake on a schedulable edge', () => {
  it('wakes once when the node becomes schedulable, not while it stays so', async () => {
    const fixture = await setup();
    await runNode(fixture);
    expect(await wakeGen(fixture)).toBeUndefined();

    await fixture.database.query('UPDATE nodes SET cordoned = false WHERE id = $1', [NODE]);
    await runNode(fixture);
    const first = await wakeGen(fixture);
    expect(first).toBeGreaterThan(0);

    await runNode(fixture);
    expect(await wakeGen(fixture)).toBe(first);

    // Cordon and uncordon again: a new edge, a new wake.
    await fixture.database.query('UPDATE nodes SET cordoned = true WHERE id = $1', [NODE]);
    await runNode(fixture);
    await fixture.database.query('UPDATE nodes SET cordoned = false WHERE id = $1', [NODE]);
    await runNode(fixture);
    expect(await wakeGen(fixture)).toBeGreaterThan(first!);
  });
});
