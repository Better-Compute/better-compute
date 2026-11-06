import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftId } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  fleetCreateKey,
  fleetModule,
  type ApplyResult,
  type FleetChange,
  type FleetConfig,
  type FleetKubernetesCluster,
  type FleetPool,
  type PlanResult,
} from '@better-compute/fleet';
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

const plan = (config: FleetConfig, prune = false): Promise<PlanResult> =>
  world.api.fleet.plan(world.root, { tenantId: world.rootTenant, config, prune });
const apply = (config: FleetConfig, extra: Record<string, unknown> = {}): Promise<ApplyResult> =>
  world.api.fleet.apply(world.root, { tenantId: world.rootTenant, config, ...extra });
/** The current fleet as a document, with these clusters instead of the ones it has. */
const withClusters = async (clusters: FleetKubernetesCluster[]): Promise<FleetConfig> => ({
  ...(await exported()),
  kubernetesClusters: clusters,
});
const system = { name: 'system', machineType: 'e2-standard-4', nodeCount: 1 };
const gpu = {
  name: 'gpu',
  machineType: 'g2-standard-8',
  nodeCount: 0,
  autoscaling: { minNodes: 0, maxNodes: 4 },
  accelerators: { type: 'nvidia-l4', count: 1 },
};
const created = (
  name: string,
  extra: Record<string, unknown> = {},
): Promise<KubernetesClusterView> =>
  world.api.kubernetesClusters.create(
    world.root,
    clusterBody({ name, nodePools: [system, gpu], idempotencyKey: `api-${name}`, ...extra }),
  );
const changeOf = (result: PlanResult, kind: FleetChange['kind'], name: string) =>
  result.changes.find((change) => change.kind === kind && change.name === name);

describe('fleet.plan for Kubernetes clusters', () => {
  it('plans a new cluster as one kubernetesClusters.create with its node pools, keyed per incarnation', async () => {
    const document = await withClusters([
      { name: 'training', pool: world.poolId, location: 'us-central1', nodePools: [system, gpu] },
    ]);
    const planned = await plan(document);
    expect(changeOf(planned, 'kubernetesCluster', 'training')).toEqual({
      kind: 'kubernetesCluster',
      name: 'training',
      action: 'create',
    });
    expect(changeOf(planned, 'kubernetesNodePool', 'training/gpu')?.action).toBe('create');
    expect(planned.calls).toEqual([
      {
        path: 'kubernetesClusters/create',
        input: {
          tenantId: world.rootTenant,
          poolId: world.poolId,
          name: 'training',
          mode: 'standard',
          location: 'us-central1',
          nodePools: [system, gpu],
          idempotencyKey: fleetCreateKey(world.rootTenant, 'kubernetesCluster', 'training', 0),
        },
      },
    ]);
    expect(planned.blocked).toBe(false);

    // Once a cluster of that name existed and was deleted, a new one gets a fresh key.
    await created('training');
    await world.fixture.database.query(
      `UPDATE kubernetes_clusters SET state = 'deleted', desired_state = 'deleted' WHERE name = 'training'`,
    );
    expect((await plan(document)).calls[0]?.input.idempotencyKey).toBe(
      fleetCreateKey(world.rootTenant, 'kubernetesCluster', 'training', 1),
    );
    // A long tenant id or name still makes a key the module takes (at most 128 characters).
    expect(fleetCreateKey('t'.repeat(128), 'kubernetesNodePool', 'gpu', 3)).toMatch(
      /^fleet:[0-9a-f]{64}:3$/,
    );
  });

  it('plans nothing for its own export, and updates in place what can change', async () => {
    const cluster = await created('training', { authorizedNetworks: ['203.0.113.0/24'] });
    const document = await exported();
    expect((await plan(document)).calls).toEqual([]);
    expect(changeOf(await plan(document), 'kubernetesCluster', 'training')?.action).toBe(
      'unchanged',
    );

    const next = structuredClone(document);
    const wanted = next.kubernetesClusters![0]!;
    wanted.releaseChannel = 'stable';
    wanted.authorizedNetworks = ['198.51.100.0/24'];
    wanted.description = 'GPU training';
    const pools = wanted.nodePools!;
    pools.find((pool) => pool.name === 'system')!.nodeCount = 3;
    delete pools.find((pool) => pool.name === 'gpu')!.autoscaling;
    pools.push({ name: 'batch', machineType: 'e2-standard-8', nodeCount: 2, spot: false });
    const planned = await plan(next);
    expect(changeOf(planned, 'kubernetesCluster', 'training')).toEqual({
      kind: 'kubernetesCluster',
      name: 'training',
      action: 'update',
      fields: ['releaseChannel', 'authorizedNetworks', 'description'],
    });
    expect(changeOf(planned, 'kubernetesNodePool', 'training/system')).toMatchObject({
      action: 'update',
      fields: ['nodeCount'],
    });
    expect(changeOf(planned, 'kubernetesNodePool', 'training/gpu')).toMatchObject({
      action: 'update',
      fields: ['autoscaling'],
    });
    const nodePoolId = (name: string) => cluster.nodePools.find((pool) => pool.name === name)!.id;
    expect(planned.calls).toEqual(
      expect.arrayContaining([
        {
          path: 'kubernetesClusters/update',
          input: {
            tenantId: world.rootTenant,
            clusterId: cluster.id,
            releaseChannel: 'stable',
            authorizedNetworks: ['198.51.100.0/24'],
            description: 'GPU training',
          },
        },
        {
          path: 'kubernetesNodePools/update',
          input: {
            tenantId: world.rootTenant,
            clusterId: cluster.id,
            nodePoolId: nodePoolId('system'),
            nodeCount: 3,
          },
        },
        {
          path: 'kubernetesNodePools/update',
          input: {
            tenantId: world.rootTenant,
            clusterId: cluster.id,
            nodePoolId: nodePoolId('gpu'),
            autoscaling: null,
          },
        },
        {
          path: 'kubernetesNodePools/create',
          input: {
            tenantId: world.rootTenant,
            clusterId: cluster.id,
            name: 'batch',
            machineType: 'e2-standard-8',
            nodeCount: 2,
            idempotencyKey: fleetCreateKey(world.rootTenant, 'kubernetesNodePool', 'batch', 0),
          },
        },
      ]),
    );
    expect(planned.calls).toHaveLength(4);

    // Applied through the composite envelope: every call checked for the caller, then run at once.
    const applied = await apply(next, { planHash: planned.planHash });
    expect(applied.applied).toBe(4);
    expect((await plan(next)).calls).toEqual([]);
    const after = await world.api.kubernetesClusters.get(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
    });
    expect(after).toMatchObject({ releaseChannel: 'stable', description: 'GPU training' });
    expect(after.nodePools.map((pool: { name: string }) => pool.name).sort()).toEqual([
      'batch',
      'gpu',
      'system',
    ]);
  });

  it('blocks what cannot change, a cluster being deleted, an unknown pool and a taken name', async () => {
    const cluster = await created('training');
    const document = await exported();
    const variant = (change: (cluster: FleetKubernetesCluster) => void) => {
      const next = structuredClone(document);
      change(next.kubernetesClusters![0]!);
      return plan(next);
    };
    const moved = await variant((wanted) => (wanted.location = 'europe-west4'));
    expect(moved.blocked).toBe(true);
    expect(changeOf(moved, 'kubernetesCluster', 'training')).toMatchObject({
      action: 'update',
      fields: ['location'],
      blocked: 'location cannot change; create a cluster under another name',
    });
    const autopilot = await variant((wanted) => {
      wanted.mode = 'autopilot';
      delete wanted.nodePools;
    });
    expect(changeOf(autopilot, 'kubernetesCluster', 'training')?.fields).toEqual(['mode']);
    const resized = await variant((wanted) => {
      wanted.nodePools!.find((pool) => pool.name === 'system')!.machineType = 'e2-standard-8';
    });
    expect(changeOf(resized, 'kubernetesNodePool', 'training/system')).toMatchObject({
      fields: ['machineType'],
      blocked: 'machineType cannot change; add a node pool under another name',
    });
    const ghost = await variant((wanted) => (wanted.pool = 'ghost'));
    expect(changeOf(ghost, 'kubernetesCluster', 'training')?.blocked).toBe('unknown pool ghost');
    // Fail closed: a blocked plan is refused whole.
    await expect(
      apply(
        structuredClone({
          ...document,
          kubernetesClusters: [{ ...document.kubernetesClusters![0]!, location: 'europe-west4' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await world.api.kubernetesClusters.delete(world.root, {
      tenantId: world.rootTenant,
      clusterId: cluster.id,
    });
    expect(changeOf(await plan(document), 'kubernetesCluster', 'training')?.blocked).toMatch(
      /being deleted/,
    );

    // A substrate's cluster is its pool's: its name is taken.
    const other = await created('substrate');
    await world.fixture.database.query(
      `UPDATE kubernetes_clusters SET substrate_pool_id = pool_id WHERE id = $1`,
      [other.id],
    );
    const taken = await plan(
      await withClusters([
        { name: 'substrate', pool: world.poolId, location: 'us-central1', nodePools: [system] },
      ]),
    );
    expect(changeOf(taken, 'kubernetesCluster', 'substrate')?.blocked).toBe(
      `the name is taken by the substrate cluster of pool ${world.poolId}`,
    );
  });

  it('prunes node pools, then clusters, before pools are archived; an account a cluster uses is kept', async () => {
    const cluster = await created('training');
    const document = await exported();
    const withoutGpu = structuredClone(document);
    withoutGpu.kubernetesClusters![0]!.nodePools = [system];
    expect((await plan(withoutGpu)).calls).toEqual([]);
    const pruned = await plan(withoutGpu, true);
    expect(changeOf(pruned, 'kubernetesNodePool', 'training/gpu')?.action).toBe('delete');
    expect(pruned.calls).toEqual([
      {
        path: 'kubernetesNodePools/delete',
        input: {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
          nodePoolId: cluster.nodePools.find((pool) => pool.name === 'gpu')!.id,
        },
      },
    ]);

    // Everything gone from the document: the cluster is deleted before its pool is archived, and
    // the account stays until the provider deleted the cluster.
    const empty = await plan({ version: 1 }, true);
    const paths = empty.calls.map((call) => call.path);
    expect(paths.indexOf('kubernetesClusters/delete')).toBeLessThan(paths.indexOf('pools/archive'));
    expect(changeOf(empty, 'providerAccount', 'gke-main')).toMatchObject({
      action: 'unchanged',
      note: 'kept: cluster training uses it until it is deleted; apply again then',
    });

    const noCluster = { ...document, kubernetesClusters: [] };
    await apply(noCluster, { prune: true });
    expect(
      (
        await world.api.kubernetesClusters.get(world.root, {
          tenantId: world.rootTenant,
          clusterId: cluster.id,
        })
      ).state,
    ).toBe('deleting');
    // A cluster on its way out is not deleted again.
    expect((await plan(noCluster, true)).calls).toEqual([]);
  });

  it('defers a cluster on a pool the same plan creates, and reports it as drift until then', async () => {
    const document = await exported();
    const next: FleetConfig = {
      ...document,
      pools: [
        ...(document.pools ?? []),
        { name: 'gke-two', site: world.siteId, class: 'provider', providerAccount: 'gke-main' },
      ],
      kubernetesClusters: [
        { name: 'later', pool: 'gke-two', location: 'us-central1', nodePools: [system] },
      ],
    };
    const planned = await plan(next);
    expect(planned.blocked).toBe(false);
    expect(changeOf(planned, 'kubernetesCluster', 'later')).toMatchObject({
      action: 'create',
      deferred: true,
    });
    expect(planned.calls.map((call) => call.path)).toEqual(['pools/create']);
    await apply(next);
    const status = await world.api.fleet.status(world.root, { tenantId: world.rootTenant });
    expect(status.applied).toBeDefined();
    // The pool exists now: the next plan creates the cluster on it.
    const again = await plan(next);
    expect(again.calls.map((call) => call.path)).toEqual(['kubernetesClusters/create']);
    const poolId = (await exported()).pools!.find((pool) => pool.name === 'gke-two');
    expect(poolId).toBeDefined();
    await apply({ ...next, pools: document.pools, kubernetesClusters: [] }, { prune: true });
  });
});

describe('pool substrates in the document', () => {
  const substratePool = (extra: Record<string, unknown> = {}): FleetPool => ({
    name: 'gpu-substrate',
    site: world.siteId,
    class: 'vps-host',
    policy: {
      kubernetes: {},
      substrate: {
        kind: 'kubernetes',
        account: 'gke-main',
        cluster: { create: { location: 'us-central1' } },
        flavors: [{ name: 'gpu', machineType: 'g2-standard-8', nodes: 1 }],
        ...extra,
      },
    },
  });
  const withPool = async (pool: FleetPool): Promise<FleetConfig> => {
    const document = await exported();
    return {
      ...document,
      pools: [...(document.pools ?? []).filter((item) => item.name !== pool.name), pool],
    };
  };

  it('resolves the account by name, round-trips, and blocks moving the substrate', async () => {
    const document = await withPool(substratePool());
    const planned = await plan(document);
    const create = planned.calls.find((call) => call.path === 'pools/create')!;
    expect((create.input.policy as { substrate: { account: string } }).substrate.account).toBe(
      world.accountId,
    );
    await apply(document);
    expect((await plan(document)).calls).toEqual([]);
    const exportedPool = (await exported()).pools!.find((pool) => pool.name === 'gpu-substrate')!;
    expect((exportedPool.policy!.substrate as { account: string }).account).toBe('gke-main');
    expect((await plan(await exported())).calls).toEqual([]);

    // Sizing changes in place; the account or the cluster's place never does (K-D8).
    const resized = await plan(
      await withPool(
        substratePool({ flavors: [{ name: 'gpu', machineType: 'g2-standard-8', nodes: 3 }] }),
      ),
    );
    expect(changeOf(resized, 'pool', 'gpu-substrate')).toMatchObject({
      action: 'update',
      fields: ['policy'],
    });
    const moved = await plan(
      await withPool(substratePool({ cluster: { create: { location: 'europe-west4' } } })),
    );
    expect(changeOf(moved, 'pool', 'gpu-substrate')).toMatchObject({
      blocked: 'policy.substrate (account, cluster) cannot change; create a new pool',
    });
    const unknown = await plan(await withPool(substratePool({ account: 'nobody' })));
    expect(changeOf(unknown, 'pool', 'gpu-substrate')?.blocked).toBe(
      'unknown provider account nobody (policy.substrate.account)',
    );

    // Archiving tears the substrate down; the account it runs on is kept while the document keeps it.
    const archived = await plan(
      {
        ...(await exported()),
        pools: (await exported()).pools!.filter((pool) => pool.name !== 'gpu-substrate'),
      },
      true,
    );
    expect(changeOf(archived, 'pool', 'gpu-substrate')?.note).toMatch(/substrate is torn down/);
    const keepAccount = await plan({ version: 1, pools: [substratePool()] }, true);
    expect(changeOf(keepAccount, 'providerAccount', 'gke-main')).toMatchObject({
      action: 'unchanged',
      note: 'kept: the substrate of pool gpu-substrate uses it',
    });
    await apply(
      {
        ...(await exported()),
        pools: (await exported()).pools!.filter((pool) => pool.name !== 'gpu-substrate'),
      },
      { prune: true },
    );
  });
});

describe('fleet.apply of new clusters (composable admission)', () => {
  const projected = (clusterId: string) =>
    world.fixture.compute.authz.get('kubernetes-cluster', clusterId, world.rootTenant);
  const draft = (identityId: string, name: string, incarnation = 0) =>
    draftId(
      'kcl',
      world.rootTenant,
      identityId,
      fleetCreateKey(world.rootTenant, 'kubernetesCluster', name, incarnation),
    );

  it('creates a cluster through the envelope; the reconciler converges it; drift is reported and cleared', async () => {
    const document = await withClusters([
      { name: 'training', pool: world.poolId, location: 'us-central1', nodePools: [system, gpu] },
    ]);
    const planned = await plan(document);
    const applied = await apply(document, { planHash: planned.planHash });
    expect(applied.applied).toBe(1);
    const rootIdentity = world.fixture.tenants.root.caller.identityId;
    const clusterId = await draft(rootIdentity, 'training');
    const cluster = await world.api.kubernetesClusters.get(world.root, {
      tenantId: world.rootTenant,
      clusterId,
    });
    expect(cluster).toMatchObject({ name: 'training', state: 'pending' });
    expect(cluster.nodePools.map((pool: { name: string }) => pool.name).sort()).toEqual([
      'gpu',
      'system',
    ]);
    expect(await projected(clusterId)).toBeDefined();
    // Again: nothing to do (the cluster exists under the plan's key).
    expect((await apply(document)).applied).toBe(0);

    await world.until(async () => {
      const view = await world.api.kubernetesClusters.get(world.root, {
        tenantId: world.rootTenant,
        clusterId,
      });
      return view.state === 'ready';
    });
    expect((await plan(document)).calls).toEqual([]);

    // Someone resizes a node pool outside fleet: drift, then convergence once fleet applies again.
    const systemPool = cluster.nodePools.find((pool: { name: string }) => pool.name === 'system')!;
    await world.api.kubernetesNodePools.update(world.root, {
      tenantId: world.rootTenant,
      clusterId,
      nodePoolId: systemPool.id,
      nodeCount: 5,
    });
    await world.tick('fleet.drift', 3, 16 * 60_000);
    const status = await world.api.fleet.status(world.root, { tenantId: world.rootTenant });
    expect(status.drift?.changes).toEqual([
      {
        kind: 'kubernetesNodePool',
        name: 'training/system',
        action: 'update',
        fields: ['nodeCount'],
      },
    ]);
    expect((await world.events('fleet.')).map((event) => event.type)).toContain('fleet.drifted');
    await apply(document);
    expect(
      (await world.api.fleet.status(world.root, { tenantId: world.rootTenant })).drift,
    ).toBeUndefined();
  });

  it('a refused create leaves no projection row; neither does a plan that fails in its transaction', async () => {
    // A root administrator who may administer the fleet but not create clusters.
    const token = 'token-fleet-no-k8s-0123456789';
    const caller = world.fixture.iam.addCaller(token, {
      tenantId: world.rootTenant,
      identityId: 'usr_fleet_no_k8s',
    });
    world.fixture.iam.allow({ token });
    world.fixture.iam.deny({ token, action: 'compute:kubernetes:create' });
    const document = await withClusters([
      { name: 'refused', pool: world.poolId, location: 'us-central1', nodePools: [system] },
    ]);
    await expect(
      world.api.fleet.apply({ token }, { tenantId: world.rootTenant, config: document }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await projected(await draft(caller.identityId, 'refused'))).toBeUndefined();

    // Phase 2 fails after the create was checked (a node pool resized outside its autoscaling
    // bounds is refused by its handler): nothing is applied, and the staged projection row goes.
    const existing = await created('existing');
    const next = await withClusters([
      ...(await exported()).kubernetesClusters!,
      { name: 'fresh', pool: world.poolId, location: 'us-central1', nodePools: [system] },
    ]);
    const wanted = next.kubernetesClusters!.find((cluster) => cluster.name === 'existing')!;
    wanted.nodePools!.find((pool) => pool.name === 'gpu')!.nodeCount = 9;
    await expect(apply(next)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const rootIdentity = world.fixture.tenants.root.caller.identityId;
    expect(await projected(await draft(rootIdentity, 'fresh'))).toBeUndefined();
    const { rows } = await world.fixture.database.query(
      `SELECT 1 FROM kubernetes_clusters WHERE name = 'fresh'`,
    );
    expect(rows).toEqual([]);
    expect(
      (
        await world.api.kubernetesClusters.get(world.root, {
          tenantId: world.rootTenant,
          clusterId: existing.id,
        })
      ).nodePools.find((pool: { name: string }) => pool.name === 'gpu').nodeCount,
    ).toBe(0);
  });
});
