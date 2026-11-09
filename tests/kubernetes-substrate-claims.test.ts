import { afterEach, describe, expect, it } from 'vitest';
import {
  kubernetesMigrations,
  substrateClaim,
  substrateNodePoolName,
  substratePoolLabel,
  substrateSubject,
} from '@better-compute/kubernetes';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// One cluster backs one pool. Adoption used to be checked per provider account with an unlocked SELECT, so two
// accounts on one project (or two pools racing) both adopted a cluster: the second added node pools to it, fought
// over bcd's objects, and its teardown revoked the shared `bc-substrate` identity under the first. Three things stop
// it now: the unique `claim_key` at insert (two pools, one account), the cluster's provider-global id written to it
// before any node pool is ensured (two accounts, one cluster), and a claim object in the cluster itself (two
// deployments, each with its own database).

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const adoptId = 'projects/fake/locations/us-central1/clusters/prod';
const server = 'https://34.118.9.1';
const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 1, gpus: { type: 'nvidia-l4', count: 1 } };
const adopt = (flavors: unknown[] = [gpu]) => ({ kind: 'kubernetes', cluster: { adopt: adoptId }, flavors });
const claimPath = `/api/v1/namespaces/${substrateClaim.metadata.namespace}/configmaps/${substrateClaim.metadata.name}`;

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
    endpoint: server,
    ready: true,
    pools: new Map([['default', { spec: { name: 'default', machineType: 'e2-standard-4', nodeCount: 2 }, ready: true }]]),
  });
}

/** A second provider account of the same tenant that reaches the same project (the fake cloud is one project). */
const secondAccount = async () =>
  (
    await world!.api.providerAccounts.create(world!.root, {
      tenantId: world!.rootTenant,
      provider: 'fake-gke',
      name: 'gke-second',
      config: { zones: ['us-central1-a'] },
    })
  ).id as string;

const clusterOf = async (poolId: string) =>
  (
    await world!.fixture.database.query<any>(`SELECT * FROM kubernetes_clusters WHERE substrate_pool_id = $1`, [poolId])
  ).rows[0];

describe('substrate: one cluster backs one pool', () => {
  it('ships the claims migration after the others, with a unique index over live claims', async () => {
    expect(kubernetesMigrations.map((migration) => migration.name).sort()).toEqual(
      kubernetesMigrations.map((migration) => migration.name),
    );
    expect(kubernetesMigrations.at(-1)!.name).toBe('kubernetes/0005_cluster_claims');
    world = await substrateWorld();
    const { rows } = await world.fixture.database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'kubernetes_clusters_claim'`,
    );
    expect(rows[0]!.indexdef).toMatch(/UNIQUE INDEX .*\(claim_key\) WHERE .*claim_key IS NOT NULL.*state <> 'deleted'/);
  });

  it('refuses the same cluster through a second provider account before any node pool is made', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const first = await world.createPool(adopt(), 'first');
    await world.converge(first.id, 8);
    expect(await world.substrate(first.id)).toMatchObject({ state: 'ready' });
    const winner = await clusterOf(first.id);
    expect(winner.claim_key).toBe(`fake://${adoptId}`);
    expect(winner.claimed_at).not.toBeNull();
    const identities = () => [...(world!.cloud.subjects.get(adoptId) ?? [])];
    expect(identities()).toEqual([substrateSubject]);

    const calls = world.cloud.calls.length;
    const second = await world.createPool({ ...adopt(), account: await secondAccount() }, 'second');
    await world.converge(second.id, 6);
    const row = await world.substrate(second.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/^cluster: Cluster .* is already pool .*'s substrate/);
    expect(row.message).toContain(first.id);
    const loser = await clusterOf(second.id);
    expect(loser).toMatchObject({ state: 'error', claimed_at: null });
    // The second pool made nothing: no node pool at the provider, no credential, nothing applied.
    const since = world.cloud.calls.slice(calls);
    expect(since).not.toContain(`ensureNodePool ${substrateNodePoolName(second.id, 'gpu')}`);
    expect(since.filter((call) => call.startsWith('credentials'))).toHaveLength(
      since.filter((call) => call === `credentials ${substrateSubject}`).length,
    );
    const ours = () => [...world!.cloud.clusters.get(adoptId)!.pools.keys()].filter((name) => name.startsWith('bc-'));
    expect(ours()).toEqual([substrateNodePoolName(first.id, 'gpu')]);
    expect(world.kube.claim(server).metadata.labels[substratePoolLabel]).toBe(first.id);

    // Tearing the refused pool down takes nothing from the first: its identity, its claim and bcd stay.
    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: second.id });
    await world.converge(second.id, 10);
    expect(await world.substrate(second.id)).toMatchObject({ state: 'deleted' });
    expect(world.cloud.calls.filter((call) => call.startsWith('revokeCredentials'))).toEqual([]);
    expect(identities()).toEqual([substrateSubject]);
    expect(world.kube.kinds(server)).toContain('DaemonSet/bcd');
    expect(world.kube.claim(server).metadata.labels[substratePoolLabel]).toBe(first.id);
    expect(ours()).toEqual([substrateNodePoolName(first.id, 'gpu')]);
    expect(await world.substrate(first.id)).toMatchObject({ state: 'ready' });
  });

  it('lets one of two pools racing for a cluster insert its row; the other is refused, not crashed', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const first = await world.createPool(adopt(), 'first');
    // Only the substrate reconciler runs: the first pool's cluster row is recorded, the provider not read yet.
    const substrates = async () => {
      for (let round = 0; round < 2; round++) {
        await world!.fixture.advance(30_000);
        await world!.fixture.compute.jobs['kubernetes.substrates']!.tick();
      }
    };
    await substrates();
    const held = await clusterOf(first.id);
    expect(held.claim_key).toBe(`account:${world.accountId}/${adoptId}`);
    // The race: the second pool's unlocked SELECT does not see the first row (not committed yet), and its INSERT
    // meets the first row's claim once that commits. Here the row is hidden from the SELECT for a moment.
    await world.fixture.database.query(`UPDATE kubernetes_clusters SET provider_id = 'hidden' WHERE id = $1`, [held.id]);
    const second = await world.createPool(adopt(), 'second');
    await substrates();
    await world.fixture.database.query(`UPDATE kubernetes_clusters SET provider_id = $2 WHERE id = $1`, [held.id, adoptId]);
    const row = await world.substrate(second.id);
    expect(row).toMatchObject({ state: 'error', cluster_id: null });
    expect(row.message).toMatch(/already another pool's substrate/);
    const { rows } = await world.fixture.database.query(
      `SELECT id FROM kubernetes_clusters WHERE provider_id = $1 AND state <> 'deleted'`,
      [adoptId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a cluster another deployment claimed in the cluster itself, and leaves that deployment its identity', async () => {
    world = await substrateWorld();
    existingCluster(world);
    // Another control plane (its own database) adopted this cluster: its claim and its bcd are there.
    world.kube.put(server, claimPath, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { ...substrateClaim.metadata, labels: { [substratePoolLabel]: 'pool_theirs' } },
      data: { poolId: 'pool_theirs' },
    });
    world.cloud.subjects.set(adoptId, new Set([substrateSubject]));
    const pool = await world.createPool(adopt(), 'ours');
    await world.converge(pool.id, 8);
    const row = await world.substrate(pool.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/already the substrate of pool pool_theirs/);
    // No node pool was made in it, nothing applied, their claim untouched.
    expect(world.cloud.calls.filter((call) => call.startsWith('ensureNodePool'))).toEqual([]);
    expect([...world.cloud.clusters.get(adoptId)!.pools.keys()]).toEqual(['default']);
    expect(world.kube.calls.filter((call) => call.method === 'PATCH' || call.method === 'POST')).toEqual([]);
    expect(world.kube.claim(server).metadata.labels[substratePoolLabel]).toBe('pool_theirs');
    // Teardown removes nothing and does not revoke the identity the other deployment uses.
    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: pool.id });
    await world.converge(pool.id, 10);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    expect(world.kube.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(world.cloud.calls.filter((call) => call.startsWith('revokeCredentials'))).toEqual([]);
    expect([...world.cloud.subjects.get(adoptId)!]).toEqual([substrateSubject]);
  });

  it('claims a cluster it adopts and a cluster it creates, and frees an adopted one on teardown', async () => {
    world = await substrateWorld();
    existingCluster(world);
    const adopted = await world.createPool(adopt(), 'adopted');
    const created = await world.createPool(
      { kind: 'kubernetes', cluster: { create: { location: 'us-central1' } }, flavors: [gpu] },
      'created',
    );
    await world.converge(adopted.id, 8);
    expect(await world.substrate(adopted.id)).toMatchObject({ state: 'ready' });
    expect(await world.substrate(created.id)).toMatchObject({ state: 'ready' });
    const claim = world.kube.claim(server);
    expect(claim.metadata.labels[substratePoolLabel]).toBe(adopted.id);
    expect(claim.data).toMatchObject({ poolId: adopted.id, clusterId: (await clusterOf(adopted.id)).id });
    // Made with a create (POST), never a forced apply: of two claimants one is answered 409.
    expect(world.kube.calls.filter((call) => call.path.endsWith('/namespaces/kube-system/configmaps')).map((call) => call.method)).toEqual([
      'POST',
      'POST',
    ]);
    const own = await clusterOf(created.id);
    expect(own.claim_key).toMatch(/^fake:\/\/projects\/fake\/locations\/us-central1\/clusters\/bc-k-/);
    expect(world.kube.claim(await world.server(created.id)).metadata.labels[substratePoolLabel]).toBe(created.id);
    // A cluster made here cannot be adopted through another account either.
    const thief = await world.createPool(
      { kind: 'kubernetes', cluster: { adopt: own.provider_id }, flavors: [], account: await secondAccount() },
      'thief',
    );
    await world.converge(thief.id, 6);
    expect((await world.substrate(thief.id)).message).toMatch(/is already pool .*'s substrate/);

    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: adopted.id });
    await world.converge(adopted.id, 12);
    expect(await world.substrate(adopted.id)).toMatchObject({ state: 'deleted' });
    expect(world.kube.claim(server)).toBeUndefined();
    // Free again: another pool adopts it.
    const next = await world.createPool(adopt(), 'next');
    await world.converge(next.id, 10);
    expect(await world.substrate(next.id)).toMatchObject({ state: 'ready' });
    expect(world.kube.claim(server).metadata.labels[substratePoolLabel]).toBe(next.id);
  });

  it('keeps the per-account claim when the driver reports no provider-global id', async () => {
    world = await substrateWorld();
    world.cloud.noGlobalId = true;
    existingCluster(world);
    const pool = await world.createPool(adopt(), 'plain');
    await world.converge(pool.id, 8);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready' });
    expect((await clusterOf(pool.id)).claim_key).toBe(`account:${world.accountId}/${adoptId}`);
  });
});
