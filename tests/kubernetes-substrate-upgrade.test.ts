import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@better-compute/core';
import { parsePoolSubstrate, substrateUpgradeReason } from '@better-compute/kubernetes';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// Pool substrates, upgrades: a version change of a created cluster reaches the provider at once by default (its
// surge upgrade replaces Nodes; bookings on a replaced Node end as node-removed). With `upgrades: 'drain'` the pool's
// nodes first take no new bookings (NoSchedule substrate-upgrade), and the version is pushed once they hold none, or
// after `drainTimeout`; the reason goes once the cluster is ready on the new version.

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const spec = (extra: Record<string, unknown> = {}, version?: string) => ({
  kind: 'kubernetes',
  cluster: { create: { location: 'us-central1', ...(version ? { version } : {}) } },
  flavors: [gpu],
  ...extra,
});
const HOUR = 3_600_000;

async function book(nodeId: string, poolId: string, hours: number): Promise<string> {
  const id = newId('alloc');
  await world!.fixture.database.query(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
     VALUES ($1, $2, $3, $4, 'reservation', $5, tstzrange(compute_now(), compute_now() + make_interval(hours => $6)), 1)`,
    [id, world!.rootTenant, poolId, nodeId, newId('res'), hours],
  );
  return id;
}

async function reasons(poolId: string): Promise<string[][]> {
  const { rows } = await world!.fixture.database.query<{ no_schedule_reasons: string[] }>(
    `SELECT no_schedule_reasons FROM nodes WHERE pool_id = $1 ORDER BY id`,
    [poolId],
  );
  return rows.map((row) => row.no_schedule_reasons);
}

async function cluster(poolId: string): Promise<any> {
  const row = await world!.substrate(poolId);
  return world!.api.kubernetesClusters.get(world!.root, { tenantId: world!.rootTenant, clusterId: row.cluster_id });
}

async function setVersion(pool: any, version: string, extra: Record<string, unknown> = {}): Promise<void> {
  await world!.api.pools.update(world!.root, {
    tenantId: world!.rootTenant,
    poolId: pool.id,
    policy: {
      ...pool.policy,
      substrate: {
        ...pool.policy.substrate,
        ...extra,
        cluster: { create: { ...pool.policy.substrate.cluster.create, version } },
      },
    },
  });
}

describe('substrate: upgrades policy', () => {
  const policy = (substrate: Record<string, unknown>) => ({ kubernetes: {}, substrate: { account: 'pacct_01jz00000000000000000000aa', ...substrate } });
  it('takes upgrades surge or drain and a drain timeout, for created clusters only', () => {
    expect(parsePoolSubstrate(policy(spec()))).toMatchObject({ upgrades: 'surge' });
    expect(parsePoolSubstrate(policy(spec({ upgrades: 'drain', drainTimeout: '12h' })))).toMatchObject({
      upgrades: 'drain',
      drainTimeoutMs: 12 * HOUR,
    });
    expect(() => parsePoolSubstrate(policy(spec({ upgrades: 'rolling' })))).toThrow(/upgrades must be surge or drain/);
    expect(() => parsePoolSubstrate(policy(spec({ drainTimeout: '1h' })))).toThrow(/drainTimeout needs upgrades: 'drain'/);
    expect(() => parsePoolSubstrate(policy(spec({ upgrades: 'drain', drainTimeout: 'soon' })))).toThrow(/drainTimeout/);
    expect(() =>
      parsePoolSubstrate(policy({ kind: 'kubernetes', cluster: { adopt: 'projects/p/locations/l/clusters/c' }, upgrades: 'drain' })),
    ).toThrow(/an adopted cluster is never upgraded/);
  });
});

describe('substrate: drain before upgrade', () => {
  it('holds the version until the bookings end, with no new bookings meanwhile, then upgrades and lifts the reason', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec({ upgrades: 'drain' }, '1.33'));
    await world.converge(pool.id, 6);
    const nodes = await world.joinNodes(pool.id, 2);
    await world.converge(pool.id, 2);
    await book(nodes[0]!, pool.id, 1);

    await setVersion(pool, '1.34');
    await world.converge(pool.id, 4);
    // Not pushed: the cluster still asks for 1.33, the nodes take no new bookings, and the substrate says why.
    expect(await cluster(pool.id)).toMatchObject({ requestedVersion: '1.33' });
    expect((await reasons(pool.id)).every((list) => list.includes(substrateUpgradeReason))).toBe(true);
    const draining = await world.substrate(pool.id);
    expect(draining).toMatchObject({ state: 'updating' });
    expect(draining.message).toMatch(/upgrade to 1\.34: waiting for 1 booking\(s\)/);
    const events = await world.events('kubernetes.substrate.draining');
    expect(events.map((event) => event.data)).toEqual([expect.objectContaining({ version: '1.34', bookings: 1 })]);

    // The booking ends: the version goes to the provider; once the cluster is ready on it, the reason goes.
    await world.fixture.advance(HOUR);
    await world.converge(pool.id, 8);
    const upgraded = await cluster(pool.id);
    expect(upgraded).toMatchObject({ requestedVersion: '1.34', state: 'ready' });
    expect(upgraded.kubernetesVersion).toMatch(/^1\.34/);
    expect((await reasons(pool.id)).some((list) => list.includes(substrateUpgradeReason))).toBe(false);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready', message: null });
    expect((await world.events('kubernetes.substrate.upgrading')).map((event) => event.data)).toEqual([
      expect.objectContaining({ version: '1.34', drained: true }),
    ]);
  });

  it('upgrades anyway after drainTimeout, and never holds a change that is not a version bump', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec({ upgrades: 'drain', drainTimeout: '30m' }, '1.33'));
    await world.converge(pool.id, 6);
    const nodes = await world.joinNodes(pool.id, 2);
    await world.converge(pool.id, 2);
    await book(nodes[1]!, pool.id, 4);

    // Authorized networks only: pushed at once.
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: {
        ...pool.policy,
        substrate: {
          ...pool.policy.substrate,
          cluster: { create: { ...pool.policy.substrate.cluster.create, authorizedNetworks: ['203.0.113.0/24'] } },
        },
      },
    });
    await world.converge(pool.id, 4);
    expect((await cluster(pool.id)).authorizedNetworks).toEqual(['203.0.113.0/24']);
    expect((await reasons(pool.id)).some((list) => list.includes(substrateUpgradeReason))).toBe(false);

    const latest = (await world.api.pools.get(world.root, { tenantId: world.rootTenant, poolId: pool.id })) as any;
    await setVersion(latest, '1.34');
    await world.converge(pool.id, 3);
    expect(await cluster(pool.id)).toMatchObject({ requestedVersion: '1.33' });
    await world.fixture.advance(31 * 60_000);
    await world.converge(pool.id, 8);
    expect(await cluster(pool.id)).toMatchObject({ requestedVersion: '1.34', state: 'ready' });
    expect((await world.events('kubernetes.substrate.upgrading')).map((event) => event.data)).toEqual([
      expect.objectContaining({ version: '1.34', drained: false }),
    ]);
    expect((await reasons(pool.id)).some((list) => list.includes(substrateUpgradeReason))).toBe(false);
  });

  it('refuses a direct kubernetesClusters.update version change that would skip the drain', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(spec({ upgrades: 'drain' }, '1.33'));
    await world.converge(pool.id, 6);
    const nodes = await world.joinNodes(pool.id, 2);
    await world.converge(pool.id, 2);
    await book(nodes[0]!, pool.id, 1);
    const row = await world.substrate(pool.id);
    const ref = { tenantId: world.rootTenant, clusterId: row.cluster_id };
    await expect(world.api.kubernetesClusters.update(world.root, { ...ref, version: '1.34' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringMatching(/policy\.substrate\.cluster\.create\.version/),
    });
    // Nothing reached the cluster row: no upgrade started around the drain.
    expect(await cluster(pool.id)).toMatchObject({ requestedVersion: '1.33' });
    // What does not change the version is still allowed.
    await world.api.kubernetesClusters.update(world.root, { ...ref, description: 'GPU substrate' });
    await world.api.kubernetesClusters.update(world.root, { ...ref, version: '1.33' });
    // Without upgrades: 'drain', an operator upgrade is still a direct update.
    const surge = await world.createPool(spec({}, '1.33'), 'surge-pool');
    await world.converge(surge.id, 6);
    const surgeRow = await world.substrate(surge.id);
    await world.api.kubernetesClusters.update(world.root, {
      tenantId: world.rootTenant,
      clusterId: surgeRow.cluster_id,
      version: '1.34',
    });
    expect(await cluster(surge.id)).toMatchObject({ requestedVersion: '1.34' });
  });
});
