import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftId, newId } from '@better-compute/core';
import { liveKubernetesClusters } from '@better-compute/vps';
import { closeFixtures } from '@better-compute/testing';
import { kubernetes, type KubernetesClusterView } from '@better-compute/kubernetes';
import { kubernetesWorld, type KubernetesWorld } from './support/kubernetes-world.js';

// kubernetesClusters.create/list/get and their refusals, through the real envelope (fake IAM, PGlite): the
// platform's own pool (root), the same pool offered to tenants (the hosted model), and a provider without
// managed Kubernetes.

let world: KubernetesWorld;
let counter = 0;

type Who = 'root' | 'acme' | 'other';
const tenantOf = (who: Who) =>
  who === 'root' ? world.rootTenant : who === 'acme' ? world.acmeTenant : world.otherTenant;
const pool = (extra: Record<string, unknown> = {}) => ({
  name: 'default',
  machineType: 'e2-standard-4',
  nodeCount: 1,
  ...extra,
});
const body = (extra: Record<string, unknown> = {}, who: Who = 'root') => {
  counter++;
  return {
    tenantId: tenantOf(who),
    poolId: world.poolId,
    name: `c${counter}`,
    mode: 'standard',
    location: 'us-central1',
    nodePools: [pool()],
    idempotencyKey: `key-${counter}`,
    ...extra,
  };
};
const create = (
  extra: Record<string, unknown> = {},
  who: Who = 'root',
): Promise<KubernetesClusterView> =>
  world.api.kubernetesClusters.create(world[who], body(extra, who));
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved', message: '' }),
    (error: { code?: string; message?: string }) => ({
      code: error.code ?? String(error),
      message: error.message ?? '',
    }),
  );
const codeOf = async (promise: Promise<unknown>) => (await failure(promise)).code;
const projected = (clusterId: string, tenantId: string) =>
  world.fixture.compute.authz.get('kubernetes-cluster', clusterId, tenantId);

beforeAll(async () => {
  world = await kubernetesWorld({ maxClustersPerTenant: 4 });
});
afterAll(closeFixtures);

describe('kubernetesClusters.create', () => {
  it('records a standard cluster pending with its node pools, publishes created and projects it', async () => {
    const created = await create({
      name: 'training',
      description: 'GPU training',
      authorizedNetworks: ['203.0.113.0/24', '203.0.113.0/24'],
      nodePools: [
        pool({ name: 'system' }),
        pool({
          name: 'gpu',
          machineType: 'g2-standard-8',
          nodeCount: 0,
          autoscaling: { minNodes: 0, maxNodes: 4 },
          diskGiB: 200,
          diskType: 'pd-ssd',
          accelerators: { type: 'nvidia-l4', count: 1 },
          spot: true,
          zones: ['us-central1-a'],
          labels: { 'example.com/gpu': 'l4' },
          taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
        }),
      ],
      idempotencyKey: 'train-1',
    });
    expect(created).toMatchObject({
      tenantId: world.rootTenant,
      poolId: world.poolId,
      providerAccountId: world.accountId,
      name: 'training',
      description: 'GPU training',
      mode: 'standard',
      location: 'us-central1',
      region: 'us-central1',
      releaseChannel: 'regular',
      authorizedNetworks: ['203.0.113.0/24'],
      privateNodes: false,
      state: 'pending',
      version: 1,
    });
    expect(created.id).toMatch(/^kcl_/);
    expect(created.providerName).toMatch(/^bc-k-[a-z0-9]{24}$/);
    expect(created.providerName.length).toBeLessThanOrEqual(40);
    expect(created.nodePools.map((nodePool) => nodePool.name).sort()).toEqual(['gpu', 'system']);
    expect(created.nodePools.find((nodePool) => nodePool.name === 'gpu')).toMatchObject({
      clusterId: created.id,
      machineType: 'g2-standard-8',
      nodeCount: 0,
      autoscaling: { minNodes: 0, maxNodes: 4 },
      diskGiB: 200,
      diskType: 'pd-ssd',
      accelerators: { type: 'nvidia-l4', count: 1 },
      spot: true,
      zones: ['us-central1-a'],
      labels: { 'example.com/gpu': 'l4' },
      taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
      state: 'pending',
    });
    const events = await world.events('kubernetes.');
    expect(events.at(-1)).toMatchObject({
      type: 'kubernetes.cluster.created',
      subject: `kubernetes-cluster/${created.id}`,
      tenantId: world.rootTenant,
      data: { clusterId: created.id, mode: 'standard', name: 'training', location: 'us-central1' },
    });
    expect(await projected(created.id, world.rootTenant)).toMatchObject({
      parentType: 'tenant',
      parentId: world.rootTenant,
      ownerId: world.fixture.tenants.root.caller.identityId,
      attributes: {
        providerAccountId: world.accountId,
        poolId: world.poolId,
        mode: 'standard',
        location: 'us-central1',
      },
    });
    const listed = await world.api.kubernetesClusters.list(world.root, {
      tenantId: world.rootTenant,
    });
    expect(listed.items.map((item: KubernetesClusterView) => item.id)).toContain(created.id);
    expect(
      await world.api.kubernetesClusters.get(world.root, {
        tenantId: world.rootTenant,
        clusterId: created.id,
      }),
    ).toMatchObject({ id: created.id, name: 'training' });

    // A retry under the key replays; another request under it is CONFLICT; a taken name is CONFLICT.
    const again = await world.api.kubernetesClusters.create(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      name: 'training',
      description: 'GPU training',
      mode: 'standard',
      location: 'us-central1',
      authorizedNetworks: ['203.0.113.0/24', '203.0.113.0/24'],
      nodePools: created.nodePools
        .map((nodePool) => ({
          name: nodePool.name,
          machineType: nodePool.machineType,
          nodeCount: nodePool.nodeCount,
          ...(nodePool.autoscaling ? { autoscaling: nodePool.autoscaling } : {}),
          ...(nodePool.diskGiB ? { diskGiB: nodePool.diskGiB } : {}),
          ...(nodePool.diskType ? { diskType: nodePool.diskType } : {}),
          ...(nodePool.accelerators ? { accelerators: nodePool.accelerators } : {}),
          ...(nodePool.spot ? { spot: true } : {}),
          ...(nodePool.zones.length ? { zones: nodePool.zones } : {}),
          ...(Object.keys(nodePool.labels).length ? { labels: nodePool.labels } : {}),
          ...(nodePool.taints.length ? { taints: nodePool.taints } : {}),
        }))
        .sort((a, b) => (a.name === 'system' ? -1 : b.name === 'system' ? 1 : 0)),
      idempotencyKey: 'train-1',
    });
    expect(again.id).toBe(created.id);
    expect(
      (await world.events('kubernetes.cluster.created')).filter(
        (event) => event.data.clusterId === created.id,
      ),
    ).toHaveLength(1);
    expect(
      await codeOf(create({ name: 'training', description: 'other', idempotencyKey: 'train-1' })),
    ).toBe('CONFLICT');
    const taken = await failure(create({ name: 'training', idempotencyKey: 'train-2' }));
    expect(taken.code).toBe('CONFLICT');
    expect(taken.message).toMatch(/Cluster training already exists/);
    // A refused create leaves no projection row behind.
    const staged = await draftId(
      'kcl',
      world.rootTenant,
      world.fixture.tenants.root.caller.identityId,
      'train-2',
    );
    expect(await projected(staged, world.rootTenant)).toBeUndefined();
  });

  it('records an autopilot cluster without node pools, zonal in a configured zone', async () => {
    const created = await create({
      mode: 'autopilot',
      location: 'us-central1-b',
      nodePools: undefined,
      releaseChannel: 'stable',
      version: '1.33',
      privateNodes: true,
    });
    expect(created).toMatchObject({
      mode: 'autopilot',
      location: 'us-central1-b',
      region: 'us-central1',
      releaseChannel: 'stable',
      requestedVersion: '1.33',
      privateNodes: true,
      nodePools: [],
      state: 'pending',
    });
  });

  it('refuses invalid input with INVALID_INPUT naming the field', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ nodePools: [] }, /at least one node pool/],
      [{ nodePools: undefined }, /at least one node pool/],
      [{ mode: 'autopilot' }, /autopilot cluster takes no nodePools/],
      [{ mode: 'serverless' }, /mode: Must be one of/],
      [{ name: 'Bad_Name' }, /name must be 1-40/],
      [{ name: 'x'.repeat(41) }, /name must be 1-40/],
      [{ location: 'US' }, /location must be a region/],
      [{ releaseChannel: 'nightly' }, /releaseChannel: Must be one of/],
      [{ version: 'latest' }, /version must be a Kubernetes version/],
      [{ authorizedNetworks: ['10.0.0.1/8'] }, /host bits set/],
      [{ authorizedNetworks: ['nope'] }, /authorizedNetworks\[0\] must be an IPv4 CIDR/],
      [
        { authorizedNetworks: Array.from({ length: 51 }, (_, index) => `10.0.${index}.0/24`) },
        /at most 50/,
      ],
      [{ nodePools: [pool(), pool()] }, /names default twice/],
      [{ nodePools: Array.from({ length: 11 }, (_, index) => pool({ name: `p${index}` })) }, /./],
      [{ nodePools: [pool({ nodeCount: -1 })] }, /nodeCount/],
      [
        { nodePools: [pool({ autoscaling: { minNodes: 3, maxNodes: 1 } })] },
        /minNodes must not exceed/,
      ],
      [{ nodePools: [pool({ taints: [{ key: 'a', effect: 'Sometimes' }] })] }, /effect/i],
      [{ nodePools: [pool({ labels: { 'bad key!': 'x' } })] }, /not a Kubernetes label key/],
      [{ networkId: 'net_nope' }, /networkId must be a net_ id/],
      [{ unknown: true }, /Unknown field/],
    ];
    for (const [extra, message] of cases) {
      const result = await failure(create(extra));
      expect(result.code, JSON.stringify(extra).slice(0, 80)).toBe('INVALID_INPUT');
      expect(result.message, JSON.stringify(extra).slice(0, 80)).toMatch(message);
    }
  });

  it('refuses a pool without managed Kubernetes (UNSUPPORTED), unknown locations and zones of another region', async () => {
    const unsupported = await failure(create({ poolId: world.plainPoolId }));
    expect(unsupported.code).toBe('UNSUPPORTED');
    expect(unsupported.message).toMatch(/fake-plain does not provide managed Kubernetes/);
    expect(await codeOf(create({ poolId: `pool_${'0'.repeat(26)}` }))).toBe('NOT_FOUND');
    const location = await failure(create({ location: 'asia-east1' }));
    expect(location.code).toBe('INVALID_INPUT');
    expect(location.message).toMatch(/asia-east1 is not a zone or region/);
    // A zone of a configured region that the account does not list.
    expect(await codeOf(create({ location: 'us-central1-f' }))).toBe('INVALID_INPUT');
    // A node pool zone outside the cluster's region, or not one of the account's zones.
    expect(await codeOf(create({ nodePools: [pool({ zones: ['europe-west4-a'] })] }))).toBe(
      'INVALID_INPUT',
    );
    expect(await codeOf(create({ nodePools: [pool({ zones: ['us-central1-f'] })] }))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await codeOf(
        create({ location: 'europe-west4', nodePools: [pool({ zones: ['europe-west4-a'] })] }),
      ),
    ).toBe('resolved');
  });

  it('uses a tenant network on the same account, with a ready subnet in the cluster region', async () => {
    const networkId = newId('net');
    const subnetId = newId('snet');
    await world.fixture.database.query(
      `INSERT INTO networks (id, tenant_id, pool_id, provider_account_id, name, state, desired_state, created_by,
                             idempotency_key, request_hash, version, provisioned_at)
       VALUES ($1, $2, $3, $4, 'k8s-net', 'ready', 'present', 'usr', 'net-1', decode('00', 'hex'), 1, compute_now())`,
      [networkId, world.rootTenant, world.poolId, world.accountId],
    );
    await world.fixture.database.query(
      `INSERT INTO network_subnets (id, network_id, name, region, cidr, state, desired_state)
       VALUES ($1, $2, 'central', 'us-central1', '10.10.0.0/20', 'ready', 'present')`,
      [subnetId, networkId],
    );
    // No subnet in europe-west4: refused, naming the region.
    const refused = await failure(
      create({ networkId, location: 'europe-west4', nodePools: [pool()] }),
    );
    expect(refused.code).toBe('INVALID_INPUT');
    expect(refused.message).toMatch(/no ready subnet in europe-west4/);
    // Another tenant's network is not found.
    expect(await codeOf(create({ networkId }, 'acme'))).toBe('INVALID_INPUT');
    const created = await create({ networkId });
    expect(created).toMatchObject({ networkId, subnetId });
    // A network or account a live cluster uses cannot be deleted from under it.
    const database = world.fixture.database as unknown as Parameters<
      typeof liveKubernetesClusters
    >[0];
    expect(await liveKubernetesClusters(database, 'network_id', networkId)).toEqual([created.id]);
    expect(
      await liveKubernetesClusters(database, 'provider_account_id', world.accountId),
    ).toContain(created.id);
    const blocked = await failure(
      world.api.networks.delete(world.root, { tenantId: world.rootTenant, networkId }),
    );
    expect(blocked.code).toBe('INVALID_STATE');
    expect(blocked.message).toMatch(/Kubernetes cluster/);
    // An unprovisioned network is not usable yet.
    await world.fixture.database.query(`UPDATE networks SET provisioned_at = NULL WHERE id = $1`, [
      networkId,
    ]);
    expect(await codeOf(create({ networkId }))).toBe('INVALID_STATE');
  });

  it('works on a platform pool offered to a tenant (the hosted model), and keeps tenants apart', async () => {
    const hosted = await create({ name: 'hosted' }, 'acme');
    expect(hosted).toMatchObject({
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      providerAccountId: world.accountId,
      state: 'pending',
    });
    expect(await projected(hosted.id, world.acmeTenant)).toMatchObject({
      attributes: { providerAccountId: world.accountId, poolId: world.poolId },
    });
    // Another tenant neither lists nor reads it, in its own tenant or by naming acme's.
    const otherList = await world.api.kubernetesClusters.list(world.other, {
      tenantId: world.otherTenant,
    });
    expect(otherList.items.map((item: KubernetesClusterView) => item.id)).not.toContain(hosted.id);
    expect(
      await codeOf(
        world.api.kubernetesClusters.get(world.other, {
          tenantId: world.otherTenant,
          clusterId: hosted.id,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(
        world.api.kubernetesClusters.get(world.other, {
          tenantId: world.acmeTenant,
          clusterId: hosted.id,
        }),
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      await codeOf(
        world.api.kubernetesClusters.delete(world.other, {
          tenantId: world.otherTenant,
          clusterId: hosted.id,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(
        world.api.kubernetesNodePools.list(world.other, {
          tenantId: world.otherTenant,
          clusterId: hosted.id,
        }),
      ),
    ).toBe('NOT_FOUND');
    // The same name is free in another tenant.
    expect(await codeOf(create({ name: 'hosted' }, 'other'))).toBe('resolved');
  });

  it('caps the clusters a tenant has that are not deleted (QUOTA_EXCEEDED)', async () => {
    const live = Number(
      (
        await world.fixture.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM kubernetes_clusters WHERE tenant_id = $1 AND state <> 'deleted'`,
          [world.otherTenant],
        )
      ).rows[0]!.count,
    );
    for (let index = live; index < 4; index++) await create({}, 'other');
    const capped = await failure(create({}, 'other'));
    expect(capped.code).toBe('QUOTA_EXCEEDED');
    expect(capped.message).toMatch(/at most 4 Kubernetes clusters/);
  });

  it('scopes idempotency keys to the caller identity', async () => {
    world.fixture.iam.addCaller('token-acme-2', {
      tenantId: world.acmeTenant,
      identityId: 'usr_acme_two',
    });
    world.fixture.iam.allow({ token: 'token-acme-2' });
    const first = await create({ name: 'scoped-a', idempotencyKey: 'same-key' }, 'acme');
    const second = await world.api.kubernetesClusters.create(
      { token: 'token-acme-2' },
      body({ name: 'scoped-b', idempotencyKey: 'same-key' }, 'acme'),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe('scoped-b');
  });
});

describe('kubernetes()', () => {
  it('refuses bad options', () => {
    expect(() => kubernetes({ credentialTtlSeconds: 10 })).toThrow(/credentialTtlSeconds/);
    expect(() => kubernetes({ maxClustersPerTenant: 0 })).toThrow(/maxClustersPerTenant/);
    expect(() => kubernetes({ providers: [{} as never] })).toThrow(/defineProvider/);
  });

  it('declares its groups, reconcilers and migration', () => {
    const module = kubernetes();
    expect(module.name).toBe('kubernetes');
    expect(module.requires).toEqual(['vps']);
    expect(module.migrations!.map((migration) => migration.name)).toEqual([
      'kubernetes/0001_clusters',
      'kubernetes/0002_substrates',
      'kubernetes/0003_substrate_nodes',
      'kubernetes/0004_substrate_ownership',
      'kubernetes/0005_cluster_claims',
      'kubernetes/0006_delete_backoff',
      'kubernetes/0007_substrate_join_wait',
    ]);
    expect(module.reconcilers!.map((reconciler) => reconciler.name)).toEqual([
      'kubernetes.clusters',
      'kubernetes.substrates',
      'kubernetes.usage',
    ]);
    const api = module.api!({} as never);
    expect(Object.keys(api.kubernetesClusters)).toEqual([
      'create',
      'list',
      'get',
      'update',
      'delete',
      'credentials',
      'versions',
    ]);
    expect(Object.keys(api.kubernetesNodePools)).toEqual(['create', 'list', 'update', 'delete']);
  });
});
