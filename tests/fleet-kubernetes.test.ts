import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import { fleetModule, type FleetConfig } from '@better-compute/fleet';
import type { KubernetesClusterView } from '@better-compute/kubernetes';
import { kubernetesWorld, type KubernetesWorld } from './support/kubernetes-world.js';

// FleetConfig for Kubernetes (D25) through the real envelope: vps, kubernetes and fleet on PGlite over
// the fake managed-Kubernetes provider. Clusters and node pools are exported, planned, applied and
// checked for drift like every other FleetConfig object; a pool substrate's cluster stays its pool's.

let world: KubernetesWorld;

const exported = async (): Promise<FleetConfig> =>
  (await world.api.fleet.export(world.root, { tenantId: world.rootTenant })).config;

const clusterBody = (extra: Record<string, unknown> = {}) => ({
  tenantId: world.rootTenant,
  poolId: world.poolId,
  mode: 'standard',
  location: 'us-central1',
  nodePools: [{ name: 'system', machineType: 'e2-standard-4', nodeCount: 1 }],
  ...extra,
});

/** Removes every cluster and node pool row (the fake cloud too): each test starts from none. */
async function clean(): Promise<void> {
  const db = world.fixture.database;
  for (const table of [
    'kubernetes_node_pools',
    'kubernetes_pool_substrates',
    'kubernetes_clusters',
  ])
    await db.query(`DELETE FROM ${table}`);
  await db.query(`DELETE FROM fleet_applied`);
  world.cloud.reset();
}

beforeAll(async () => {
  world = await kubernetesWorld({}, { modules: [fleetModule()] });
});
afterAll(closeFixtures);
beforeEach(clean);

describe('fleet.export with Kubernetes clusters', () => {
  it('writes the tenant clusters and node pools in document form, defaults spelled out', async () => {
    const training: KubernetesClusterView = await world.api.kubernetesClusters.create(
      world.root,
      clusterBody({
        name: 'training',
        releaseChannel: 'stable',
        version: '1.33',
        description: 'GPU training',
        authorizedNetworks: ['203.0.113.0/24'],
        nodePools: [
          { name: 'system', machineType: 'e2-standard-4', nodeCount: 1 },
          {
            name: 'gpu',
            machineType: 'g2-standard-8',
            nodeCount: 0,
            autoscaling: { minNodes: 0, maxNodes: 4 },
            diskGiB: 200,
            accelerators: { type: 'nvidia-l4', count: 1 },
            spot: true,
            zones: ['us-central1-a'],
            labels: { 'example.com/gpu': 'l4' },
            taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
          },
        ],
        idempotencyKey: 'export-training',
      }),
    );
    await world.api.kubernetesClusters.create(
      world.root,
      clusterBody({
        name: 'serve',
        mode: 'autopilot',
        location: 'us-central1-b',
        nodePools: undefined,
        idempotencyKey: 'export-serve',
      }),
    );
    const config = await exported();
    // The pool is not one fleet named: it is named by its id.
    expect(config.kubernetesClusters).toEqual([
      {
        name: 'serve',
        pool: world.poolId,
        mode: 'autopilot',
        location: 'us-central1-b',
        releaseChannel: 'regular',
      },
      {
        name: 'training',
        pool: world.poolId,
        mode: 'standard',
        location: 'us-central1',
        releaseChannel: 'stable',
        version: '1.33',
        authorizedNetworks: ['203.0.113.0/24'],
        description: 'GPU training',
        nodePools: [
          {
            name: 'gpu',
            machineType: 'g2-standard-8',
            nodeCount: 0,
            autoscaling: { minNodes: 0, maxNodes: 4 },
            diskGiB: 200,
            spot: true,
            accelerators: { type: 'nvidia-l4', count: 1 },
            zones: ['us-central1-a'],
            labels: { 'example.com/gpu': 'l4' },
            taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
          },
          { name: 'system', machineType: 'e2-standard-4', nodeCount: 1 },
        ],
      },
    ]);

    // A cluster being deleted is no longer part of the fleet; a substrate's cluster is its pool's.
    await world.api.kubernetesClusters.delete(world.root, {
      tenantId: world.rootTenant,
      clusterId: training.id,
    });
    expect((await exported()).kubernetesClusters?.map((cluster) => cluster.name)).toEqual([
      'serve',
    ]);
    await world.fixture.database.query(
      `UPDATE kubernetes_clusters SET substrate_pool_id = pool_id WHERE name = 'serve'`,
    );
    expect((await exported()).kubernetesClusters).toBeUndefined();
  });

  it('names a substrate pool account by its document name', async () => {
    const pool = await world.api.pools.create(world.root, {
      tenantId: world.rootTenant,
      siteId: world.siteId,
      class: 'vps-host',
      policy: {
        kubernetes: {},
        substrate: {
          kind: 'kubernetes',
          account: world.accountId,
          cluster: { create: { location: 'us-central1' } },
          flavors: [{ name: 'gpu', machineType: 'g2-standard-8', nodes: 1 }],
        },
      },
      idempotencyKey: 'export-substrate',
    });
    const config = await exported();
    const substrate = config.pools?.find((entry) => entry.name === pool.id)?.policy?.substrate;
    expect(substrate).toMatchObject({ account: 'gke-main', kind: 'kubernetes' });
    await world.api.pools.archive(world.root, { tenantId: world.rootTenant, poolId: pool.id });
  });
});
