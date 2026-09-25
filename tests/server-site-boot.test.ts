import { afterEach, describe, expect, it } from 'vitest';
import { newId, shardOf } from '@better-compute/core';
import { siteBootLeaseName, siteBootSpec } from '@better-compute/server';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';

// SiteBoot hosted (PLAN.md §8.5 "Site routing"): the `site-boot` singleton ticks each site's boot
// lease, promotes the first connected site agent, keeps a connected holder, fails over to a standby
// only after the lease ran out (15 s), invalidates both agents' NodeSpec on a change and publishes
// `site.boot`. A site agent's NodeSpec says whether it is the active one, with the lease's epoch.

afterEach(closeFixtures);

const SITE = 'site_boot';

async function setup() {
  const fixture = await computeFixture({ clock: 'sim' });
  await fixture.database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, fixture.tenants.root.id],
  );
  return fixture;
}

async function siteAgent(fixture: ComputeFixture, id: string, connected = true) {
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, NULL, $3, 'site', 'ready', false, false, $4, 'platform', '{}', 0, 0, 1, 1, $5, 1)`,
    [id, SITE, fixture.tenants.root.id, connected ? 'connected' : 'disconnected', shardOf(id)],
  );
  return id;
}

const setConnectivity = (fixture: ComputeFixture, id: string, connectivity: string) =>
  fixture.database.query('UPDATE nodes SET connectivity = $2 WHERE id = $1', [id, connectivity]);

async function lease(fixture: ComputeFixture) {
  const { rows } = await fixture.database.query<{ owner: string | null; epoch: unknown }>(
    'SELECT owner, epoch FROM leases WHERE name = $1',
    [siteBootLeaseName(SITE)],
  );
  return rows[0] && { owner: rows[0].owner, epoch: Number(rows[0].epoch) };
}

async function bootEvents(fixture: ComputeFixture) {
  const { rows } = await fixture.database.query<{ payload: { data: Record<string, unknown> } }>(
    `SELECT payload FROM outbox WHERE payload->>'type' = 'site.boot' ORDER BY txid, seq`,
  );
  return rows.map((row) => row.payload.data);
}

async function specQueued(fixture: ComputeFixture, nodeId: string) {
  const { rows } = await fixture.database.query(
    `SELECT 1 FROM work_queue WHERE kind = 'nodespec' AND key = $1`,
    [nodeId],
  );
  return rows.length > 0;
}

const tick = (fixture: ComputeFixture) => fixture.compute.jobs['site-boot']!.tick();

describe('SiteBoot', () => {
  it('promotes the first connected agent, then keeps it while connected', async () => {
    const fixture = await setup();
    const a = await siteAgent(fixture, 'node_a1');
    const b = await siteAgent(fixture, 'node_b2');
    await tick(fixture);
    expect(await lease(fixture)).toEqual({ owner: a, epoch: 1 });
    expect(await bootEvents(fixture)).toEqual([
      { siteId: SITE, active: a, previous: null, epoch: 1 },
    ]);
    expect(await specQueued(fixture, a)).toBe(true);

    for (let i = 0; i < 5; i++) {
      await fixture.advance(5_000);
      await tick(fixture);
    }
    expect(await lease(fixture)).toEqual({ owner: a, epoch: 1 });
    expect(await bootEvents(fixture)).toHaveLength(1);

    const node = { id: a, siteId: SITE, role: 'site' as const };
    expect(await siteBootSpec(fixture.compute.context, node)).toEqual({
      site: { boot: { active: true, epoch: 1 } },
    });
    expect(await siteBootSpec(fixture.compute.context, { ...node, id: b })).toEqual({
      site: { boot: { active: false, epoch: 1 } },
    });
    expect(await siteBootSpec(fixture.compute.context, { ...node, role: 'host' as never })).toEqual(
      {},
    );
  });

  it('fails over to a standby only after the lease ran out, under a new epoch', async () => {
    const fixture = await setup();
    const a = await siteAgent(fixture, 'node_a1');
    const b = await siteAgent(fixture, 'node_b2');
    await tick(fixture);
    await setConnectivity(fixture, a, 'disconnected');

    // Within the TTL the disconnected holder keeps the lease: two agents never both act.
    await fixture.advance(10_000);
    await tick(fixture);
    expect(await lease(fixture)).toEqual({ owner: a, epoch: 1 });

    await fixture.advance(6_000);
    await tick(fixture);
    expect(await lease(fixture)).toEqual({ owner: b, epoch: 2 });
    expect((await bootEvents(fixture)).at(-1)).toEqual({
      siteId: SITE,
      active: b,
      previous: a,
      epoch: 2,
    });
    expect(await specQueued(fixture, b)).toBe(true);
    expect(await specQueued(fixture, a)).toBe(true);
  });

  it('releases the lease when no agent is left, and ignores sites without agents', async () => {
    const fixture = await setup();
    await fixture.database.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_empty', $1, 'shared', 'eu-1', 1)`,
      [fixture.tenants.root.id],
    );
    const a = await siteAgent(fixture, newId('node'));
    await tick(fixture);
    await setConnectivity(fixture, a, 'disconnected');
    await fixture.advance(16_000);
    await tick(fixture);
    expect(await lease(fixture)).toEqual({ owner: null, epoch: 2 });
    const { rows } = await fixture.database.query(
      `SELECT 1 FROM leases WHERE name = 'site:site_empty:boot'`,
    );
    expect(rows).toHaveLength(0);
  });
});
