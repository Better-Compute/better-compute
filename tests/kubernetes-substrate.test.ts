import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@better-compute/core';
import {
  substrateCapacityLabel,
  substrateFirstConnectGraceSeconds,
  substratePoolLabel,
  substrateSubject,
} from '@better-compute/kubernetes';
import { substrateWorld, type SubstrateWorld } from './support/substrate-world.js';

// Pool substrates, create mode: a pool whose machines are the nodes of a managed cluster the kubernetes module
// creates on the owner's provider account (here the fake managed-Kubernetes provider; the GKE emulator run is in
// kubernetes-substrate-gke.test.ts). The substrate reconciler records the cluster and one node pool per flavor, and
// once the cluster is ready mints a short-lived credential, server-side applies bcd and keeps a hosted join token
// exactly as long as nodes are still to join.

let world: SubstrateWorld | undefined;
afterEach(async () => {
  await world?.fixture.close();
  world = undefined;
});

const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const cpu = { name: 'general', machineType: 'e2-standard-4', nodes: 1 };
const spot = { ...gpu, name: 'gpu-spot', nodes: 1, spot: true };
const createSpec = (flavors: unknown[] = [cpu, gpu], extra: Record<string, unknown> = {}) => ({
  kind: 'kubernetes',
  cluster: { create: { location: 'us-central1' } },
  flavors,
  ...extra,
});

describe('substrate: create', () => {
  it('creates the cluster with one node pool per flavor (GPU and Spot GPU), labelled for the DaemonSet', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([cpu, gpu, spot], { allowSpot: true }));
    await world.converge(pool.id, 2);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ mode: 'create', tenant_id: world.rootTenant, provider_account_id: world.accountId });
    expect(row.cluster_id).toMatch(/^kcl_/);
    const cluster = await world.api.kubernetesClusters.get(world.root, {
      tenantId: world.rootTenant,
      clusterId: row.cluster_id,
    });
    expect(cluster).toMatchObject({ poolId: pool.id, mode: 'standard', location: 'us-central1' });
    expect(
      cluster.nodePools.map((nodePool: any) => [nodePool.name, nodePool.machineType, nodePool.spot, nodePool.accelerators?.type]),
    ).toEqual([
      ['general', 'e2-standard-4', false, undefined],
      ['gpu', 'g2-standard-8', false, 'nvidia-l4'],
      ['gpu-spot', 'g2-standard-8', true, 'nvidia-l4'],
    ]);
    for (const nodePool of cluster.nodePools) expect(nodePool.labels[substratePoolLabel]).toBe(pool.id);
    expect(cluster.nodePools[2].labels[substrateCapacityLabel]).toBe('spot');
    // The provider was asked for a standard cluster with the three pools.
    const spec = world.cloud.specs.at(-1)!;
    expect(spec.initialNodePools!.map((nodePool) => [nodePool.name, nodePool.spot === true])).toEqual([
      ['general', false],
      ['gpu', false],
      ['gpu-spot', true],
    ]);
    expect((await world.events('kubernetes.substrate.')).map((event) => event.type)).toContain('kubernetes.substrate.created');
  });

  it('applies bcd once the cluster is ready, with a hosted token for exactly the nodes still to join', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ state: 'ready', nodes_listed: 3, nodes_joined: 0, token_applied: true });
    const server = await world.server(pool.id);
    expect(world.kube.kinds(server)).toEqual([
      'ConfigMap/bcd-config',
      'DaemonSet/bcd',
      'Namespace/bcd-system',
      'Secret/bcd-join-token',
    ]);
    // Server-side apply with the better-compute field manager, through a credential the provider minted.
    const patches = world.kube.calls.filter((call) => call.method === 'PATCH');
    expect(new Set(patches.map((call) => `${call.fieldManager} ${call.contentType}`))).toEqual(
      new Set(['better-compute application/apply-patch+yaml']),
    );
    expect(world.cloud.credentials.at(-1)).toMatchObject({
      request: { subject: substrateSubject, role: 'admin', ttlSeconds: 600 },
    });
    // The DaemonSet selects the substrate's nodes; bcd joins the pool's site, device plugin only.
    const daemonSet = world.kube.get(server, '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
    expect(daemonSet.spec.template.spec.nodeSelector).toEqual({ [substratePoolLabel]: pool.id });
    const config = world.kube.get(server, '/api/v1/namespaces/bcd-system/configmaps/bcd-config').data['config.toml'];
    expect(config).toContain(`site = "${world.siteId}"`);
    expect(config).toContain('gpu_api = "device-plugin"');
    // The Secret holds a hosted token for this pool with one use per node to join.
    const secret = world.kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token');
    const token = secret.stringData.token as string;
    expect(token).toMatch(/^bcjt_/);
    const { rows } = await world.fixture.database.query<any>(
      `SELECT id, pool_id, hosted, uses_left, role, revoked_at FROM join_tokens WHERE id = $1`,
      [row.join_token_id],
    );
    expect(rows[0]).toMatchObject({ pool_id: pool.id, hosted: 'kubernetes', uses_left: 3, role: 'node', revoked_at: null });
    expect((await world.events('kubernetes.substrate.')).map((event) => event.type)).toEqual(
      expect.arrayContaining(['kubernetes.substrate.token-issued', 'kubernetes.substrate.ready']),
    );
  });

  it('never stores, logs or publishes the credential or the join token', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const server = await world.server(pool.id);
    const joinToken = world.kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token').stringData.token;
    const secrets = [...world.cloud.tokens, joinToken, joinToken.split('.')[1]];
    expect(world.cloud.tokens.length).toBeGreaterThan(0);
    const dump = async (table: string) =>
      JSON.stringify((await world!.fixture.database.query(`SELECT * FROM ${table}`)).rows);
    const stored = [
      await dump('kubernetes_pool_substrates'),
      await dump('kubernetes_clusters'),
      await dump('kubernetes_node_pools'),
      await dump('outbox'),
      await dump('work_items').catch(() => ''),
      world.logs.join('\n'),
    ].join('\n');
    for (const secret of secrets) expect(stored).not.toContain(secret);
  });

  it('mints a fresh credential each run, and leaves a live token and its Secret alone', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const before = await world.substrate(pool.id);
    const credentials = world.cloud.credentials.length;
    const patches = world.kube.calls.filter((call) => call.method === 'PATCH').length;
    await world.converge(pool.id, 2);
    const after = await world.substrate(pool.id);
    expect(world.cloud.credentials.length).toBeGreaterThan(credentials);
    expect(after.join_token_id).toBe(before.join_token_id);
    // Nothing changed and the last apply is recent: nothing re-applied.
    expect(world.kube.calls.filter((call) => call.method === 'PATCH').length).toBe(patches);
  });

  it('revokes the token and deletes its Secret once every node joined, and mints one again for new nodes', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const first = await world.substrate(pool.id);
    const server = await world.server(pool.id);
    await world.joinNodes(pool.id, 3);
    await world.converge(pool.id, 3);
    const joined = await world.substrate(pool.id);
    expect(joined).toMatchObject({ state: 'ready', nodes_listed: 3, nodes_joined: 3, join_token_id: null });
    expect(world.kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token')).toBeUndefined();
    const revoked = await world.fixture.database.query<any>(`SELECT revoked_at FROM join_tokens WHERE id = $1`, [
      first.join_token_id,
    ]);
    expect(revoked.rows[0].revoked_at).not.toBeNull();
    // Scale the GPU flavor up: two more nodes, a new token for exactly two.
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors: [cpu, { ...gpu, nodes: 4 }] } },
    });
    await world.converge(pool.id, 6);
    const scaled = await world.substrate(pool.id);
    expect(scaled).toMatchObject({ state: 'ready', nodes_listed: 5, nodes_joined: 3 });
    expect(scaled.join_token_id).not.toBe(first.join_token_id);
    const { rows } = await world.fixture.database.query<any>(`SELECT uses_left FROM join_tokens WHERE id = $1`, [
      scaled.join_token_id,
    ]);
    expect(rows[0].uses_left).toBe(2);
    expect(world.kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token')).toBeDefined();
  });

  it('reads a substrate through kubernetesSubstrates.get, for the pool owner only', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    await world.converge(pool.id, 6);
    await world.joinNodes(pool.id, 1);
    await world.converge(pool.id, 2);
    const row = await world.substrate(pool.id);
    const view = await world.api.kubernetesSubstrates.get(world.root, { tenantId: world.rootTenant, poolId: pool.id });
    expect(view).toEqual({
      poolId: pool.id,
      tenantId: world.rootTenant,
      providerAccountId: world.accountId,
      mode: 'create',
      clusterId: row.cluster_id,
      state: 'ready',
      nodesListed: 2,
      nodesJoined: 1,
    });
    // Nothing secret in it: no token id, no credential.
    expect(JSON.stringify(view)).not.toMatch(/token|jtk_/i);
    await expect(
      world.api.kubernetesSubstrates.get(world.acme, { tenantId: world.acmeTenant, poolId: pool.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      world.api.kubernetesSubstrates.get(world.root, { tenantId: world.rootTenant, poolId: 'pool_01jz00000000000000000000zz' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      world.api.kubernetesSubstrates.get(world.root, { tenantId: world.rootTenant, poolId: 'nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('wakes the substrate when its cluster or a node pool changes state, not only on its own poll', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    const clusterStates = async () =>
      (
        await world!.fixture.database.query<{ state: string }>(
          `SELECT state FROM kubernetes_clusters WHERE substrate_pool_id = $1`,
          [pool.id],
        )
      ).rows.map((row) => row.state);
    for (let round = 0; round < 6 && (await clusterStates()).length === 0; round++) {
      await world.fixture.advance(10_000);
      await world.fixture.compute.jobs['kubernetes.substrates']!.tick();
    }
    const queued = async () =>
      (
        await world!.fixture.database.query(`SELECT key FROM work_queue WHERE kind = 'kubernetes.substrates' AND key = $1`, [
          pool.id,
        ])
      ).rows.length;
    await world.fixture.database.query(`DELETE FROM work_queue WHERE kind = 'kubernetes.substrates'`);
    expect(await queued()).toBe(0);
    expect(await clusterStates()).toEqual(['pending']);
    for (let round = 0; round < 6 && (await queued()) === 0; round++) {
      await world.fixture.advance(10_000);
      await world.fixture.compute.jobs['kubernetes.clusters']!.tick();
    }
    expect(await queued()).toBe(1);
  });

  it('pushes a version change to the cluster (an upgrade), and keeps the DaemonSet applied', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: {
        ...pool.policy,
        substrate: { ...pool.policy.substrate, cluster: { create: { location: 'us-central1', version: '1.34' } } },
      },
    });
    await world.converge(pool.id, 6);
    const row = await world.substrate(pool.id);
    const cluster = await world.api.kubernetesClusters.get(world.root, { tenantId: world.rootTenant, clusterId: row.cluster_id });
    expect(cluster).toMatchObject({ requestedVersion: '1.34', state: 'ready' });
    expect(cluster.kubernetesVersion).toMatch(/^1\.34/);
    expect(row.state).toBe('ready');
  });
});

describe('substrate: refusals', () => {
  it('stays in error without an agent, and asks the provider for nothing', async () => {
    world = await substrateWorld({ withoutAgent: true });
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 2);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'error', cluster_id: null });
    expect((await world.substrate(pool.id)).message).toMatch(/kubernetes\(\{ substrate \}\)/);
    expect(world.cloud.calls).toEqual([]);
    // Settled on the pool's version: the 30 s sweep leaves it to the 2 minute refresh until the pool changes.
    const { rows: versions } = await world.fixture.database.query<{ pool: string; substrate: string | null }>(
      `SELECT p.version::text AS pool, s.pool_version::text AS substrate
         FROM pools p JOIN kubernetes_pool_substrates s ON s.pool_id = p.id WHERE p.id = $1`,
      [pool.id],
    );
    expect(versions[0]!.substrate).toBe(versions[0]!.pool);
    // Doctor says why: pools declare substrates the module cannot run, and a substrate is in error.
    const findings = await world.module.selfCheck!({ sql: world.fixture.database } as never);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'kubernetes.substrate-agent-missing', severity: 'error', count: 1 }),
        expect.objectContaining({ check: 'kubernetes.substrate-error', severity: 'warning', count: 1 }),
      ]),
    );
    expect(findings.find((entry: any) => entry.check === 'kubernetes.substrate-error')!.message).toContain(pool.id);
  });

  it('reports no substrate findings when every substrate converges', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'ready' });
    const findings = await world.module.selfCheck!({ sql: world.fixture.database } as never);
    expect(findings.filter((entry: any) => entry.check.startsWith('kubernetes.substrate'))).toEqual([]);
  });

  it("refuses an account that is not the pool owner's, and a provider without managed Kubernetes", async () => {
    world = await substrateWorld();
    const acmeAccount = await world.api.providerAccounts.create(world.acme, {
      tenantId: world.acmeTenant,
      provider: 'fake-gke',
      name: 'acme-gke',
      config: { zones: ['us-central1-a'] },
    });
    const foreign = await world.createPool({ ...createSpec(), account: acmeAccount.id });
    const { rows } = await world.fixture.database.query<{ id: string }>(
      `SELECT id FROM provider_accounts WHERE provider = 'fake-plain'`,
    );
    const plain = await world.createPool({ ...createSpec(), account: rows[0]!.id });
    await world.converge(foreign.id, 2);
    expect(await world.substrate(foreign.id)).toMatchObject({ state: 'error', cluster_id: null });
    expect((await world.substrate(foreign.id)).message).toMatch(/not found/);
    expect(await world.substrate(plain.id)).toMatchObject({ state: 'error', cluster_id: null });
    expect((await world.substrate(plain.id)).message).toMatch(/managed Kubernetes/);
    expect(world.cloud.calls).toEqual([]);
  });

  it('never moves a substrate in place: an account or location change is an error, and nothing is deleted', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const before = await world.substrate(pool.id);
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: {
        ...pool.policy,
        substrate: { ...pool.policy.substrate, cluster: { create: { location: 'europe-west4' } } },
      },
    });
    await world.converge(pool.id, 3);
    const after = await world.substrate(pool.id);
    expect(after).toMatchObject({ state: 'error', cluster_id: before.cluster_id });
    expect(after.message).toMatch(/never moved in place/);
    expect(world.cloud.calls.some((call) => call.startsWith('delete'))).toBe(false);
  });

  it('reports a flavor whose shape changed instead of replacing its nodes', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: {
        ...pool.policy,
        substrate: { ...pool.policy.substrate, flavors: [cpu, { ...gpu, machineType: 'a2-highgpu-1g' }] },
      },
    });
    await world.converge(pool.id, 2);
    const row = await world.substrate(pool.id);
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/flavor gpu: machineType cannot change in place/);
    expect(world.cloud.calls.some((call) => call.startsWith('deleteNodePool'))).toBe(false);
  });
});

describe('substrate: isolated worker nodes', () => {
  async function network(target: SubstrateWorld, region = 'us-central1'): Promise<{ networkId: string; subnetId: string }> {
    const networkId = newId('net');
    const subnetId = newId('snet');
    await target.fixture.database.query(
      `INSERT INTO networks (id, tenant_id, pool_id, provider_account_id, name, state, desired_state, created_by,
                             idempotency_key, request_hash, version, provisioned_at)
       VALUES ($1, $2, $3, $4, $5, 'ready', 'present', 'usr', $5, decode('00', 'hex'), 1, compute_now())`,
      [networkId, target.rootTenant, target.poolId, target.accountId, `k8s-${networkId.slice(-6)}`],
    );
    await target.fixture.database.query(
      `INSERT INTO network_subnets (id, network_id, name, region, cidr, state, desired_state)
       VALUES ($1, $2, 'nodes', $3, '10.20.0.0/20', 'ready', 'present')`,
      [subnetId, networkId, region],
    );
    return { networkId, subnetId };
  }

  it('creates the cluster with private nodes on a tenant network and its subnet in the region', async () => {
    world = await substrateWorld();
    const { networkId, subnetId } = await network(world);
    const pool = await world.createPool(
      createSpec([gpu], { cluster: { create: { location: 'us-central1', privateNodes: true, networkId } } }),
    );
    await world.converge(pool.id, 6);
    const row = await world.substrate(pool.id);
    expect(row.state).toBe('ready');
    const cluster = await world.api.kubernetesClusters.get(world.root, { tenantId: world.rootTenant, clusterId: row.cluster_id });
    expect(cluster).toMatchObject({ networkId, subnetId, privateNodes: true });
    expect(world.cloud.specs.at(-1)).toMatchObject({ privateNodes: true });
  });

  it('refuses private nodes without a network, and a network with no subnet in the region', async () => {
    world = await substrateWorld();
    await expect(
      world.createPool(createSpec([gpu], { cluster: { create: { location: 'us-central1', privateNodes: true } } })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/privateNodes needs a networkId/) });
    await expect(
      world.createPool(createSpec([gpu], { cluster: { create: { location: 'us-central1', networkId: 'net_nope' } } })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const { networkId } = await network(world, 'europe-west4');
    const pool = await world.createPool(
      createSpec([gpu], { cluster: { create: { location: 'us-central1', privateNodes: true, networkId } } }),
    );
    await world.converge(pool.id, 2);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ state: 'error', cluster_id: null });
    expect(row.message).toMatch(/no ready subnet in us-central1/);
    expect(world.cloud.calls).toEqual([]);
  });
});

describe('substrate: replaced nodes', () => {
  it('a node replaced in an upgrade (its bcd disconnected) gets a token for its replacement', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec());
    await world.converge(pool.id, 6);
    const joined = await world.joinNodes(pool.id, 3);
    await world.converge(pool.id, 3);
    expect(await world.substrate(pool.id)).toMatchObject({ join_token_id: null, nodes_joined: 3 });
    // A surge upgrade replaced one Node: its old bcd node is disconnected, a new Node is listed in its place.
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [joined[0]]);
    await world.converge(pool.id, 8);
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ nodes_listed: 3, nodes_joined: 2, token_applied: true });
    const { rows } = await world.fixture.database.query<any>(`SELECT uses_left FROM join_tokens WHERE id = $1`, [
      row.join_token_id,
    ]);
    expect(rows[0].uses_left).toBe(1);
  });

  it('a node whose Kubernetes Node is gone (scale-down) is set NoSchedule and stops counting; one that only disconnected is not', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([{ ...gpu, nodes: 3 }]));
    await world.converge(pool.id, 6);
    const names = (await world.nodeNames(pool.id)).sort();
    expect(names).toHaveLength(3);
    // Node 0 and 1 report their Node names; node 2 reports none (it is never touched).
    const joined = await world.joinNodes(pool.id, 3, [names[0]!, names[2]!]);
    await world.converge(pool.id, 3);
    expect(await world.substrate(pool.id)).toMatchObject({ join_token_id: null, nodes_joined: 3 });

    // Scale down to one Node: the provider drops the last two Nodes; their bcds go away.
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors: [{ ...gpu, nodes: 1 }] } },
    });
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = ANY($1)`, [joined]);
    await world.converge(pool.id, 6);
    const left = await world.nodeNames(pool.id);
    expect(left).toEqual([names[0]]);
    const reasons = async () =>
      new Map(
        (
          await world!.fixture.database.query<{ id: string; no_schedule_reasons: string[] }>(
            `SELECT id, no_schedule_reasons FROM nodes WHERE pool_id = $1`,
            [pool.id],
          )
        ).rows.map((row) => [row.id, row.no_schedule_reasons]),
      );
    const now = await reasons();
    // Node 1's Node (names[2]) is gone: removed. Node 0's Node is still listed: only disconnected. Node 2: no hostname.
    expect(now.get(joined[1]!)).toContain('substrate-node-removed');
    expect(now.get(joined[0]!)).not.toContain('substrate-node-removed');
    expect(now.get(joined[2]!)).not.toContain('substrate-node-removed');
    const events = (await world.events('kubernetes.substrate.node-removed')).map((event) => event.data);
    expect(events).toEqual([
      expect.objectContaining({
        poolId: pool.id,
        nodeId: joined[1],
        kubernetesNode: names[2],
        released: 0,
        requeued: 0,
        retired: true,
      }),
    ]);
    // The removed node is retired (its machine is gone): certificates revoked, out of every later look.
    const states = async () =>
      new Map(
        (
          await world!.fixture.database.query<{ id: string; provision_state: string }>(
            `SELECT id, provision_state FROM nodes WHERE pool_id = $1`,
            [pool.id],
          )
        ).rows.map((row) => [row.id, row.provision_state]),
      );
    expect(await states()).toEqual(
      new Map([
        [joined[0]!, 'adopted'],
        [joined[1]!, 'retired'],
        [joined[2]!, 'adopted'],
      ]),
    );
    // Running again changes nothing (idempotent).
    await world.converge(pool.id, 2);
    expect(await world.events('kubernetes.substrate.node-removed')).toHaveLength(1);

    // Scale up again: new Nodes (one under the old name) need a token; the retired node stays retired.
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors: [{ ...gpu, nodes: 3 }] } },
    });
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = ANY($1)`, [
      [joined[0], joined[2]],
    ]);
    await world.converge(pool.id, 6);
    expect((await states()).get(joined[1]!)).toBe('retired');
    const row = await world.substrate(pool.id);
    expect(row).toMatchObject({ nodes_listed: 3, nodes_joined: 2, token_applied: true });
  });
});

describe('substrate: which Kubernetes Node a pool node is', () => {
  const nodeRows = async (poolId: string) =>
    new Map(
      (
        await world!.fixture.database.query<{ id: string; provision_state: string; no_schedule_reasons: string[] }>(
          `SELECT id, provision_state, no_schedule_reasons FROM nodes WHERE pool_id = $1`,
          [poolId],
        )
      ).rows.map((row) => [row.id, row]),
    );

  it('never takes a node whose hostname is not its Node name (EKS) for gone: a disconnect ends nothing', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    await world.converge(pool.id, 6);
    // Short kernel hostnames, as some EKS AMIs report: no listed Node has that name.
    const joined = await world.joinNodes(pool.id, 2, ['ip-10-0-1-2', 'ip-10-0-1-3']);
    await world.converge(pool.id, 3);
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [joined[0]]);
    await world.converge(pool.id, 6);
    const rows = await nodeRows(pool.id);
    expect(rows.get(joined[0]!)).toMatchObject({ provision_state: 'adopted', no_schedule_reasons: [] });
    expect(await world.events('kubernetes.substrate.node-removed')).toEqual([]);
  });

  it("matches by the Node name bcd reports (kubernetes.nodeName) when the hostname differs", async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    await world.converge(pool.id, 6);
    const names = (await world.nodeNames(pool.id)).sort();
    const joined = await world.joinNodes(pool.id, 2, ['ip-10-0-1-2', 'ip-10-0-1-3'], [
      { kubernetes: { nodeName: names[0] } },
      { kubernetes: { nodeName: names[1] } },
    ]);
    await world.converge(pool.id, 3);
    // Scale down: the last Node goes; both bcds disconnect (only one machine is really gone).
    await world.api.pools.update(world.root, {
      tenantId: world.rootTenant,
      poolId: pool.id,
      policy: { ...pool.policy, substrate: { ...pool.policy.substrate, flavors: [{ ...gpu, nodes: 1 }] } },
    });
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = ANY($1)`, [joined]);
    await world.converge(pool.id, 6);
    const rows = await nodeRows(pool.id);
    expect(rows.get(joined[1]!)).toMatchObject({ provision_state: 'retired' });
    expect(rows.get(joined[1]!)!.no_schedule_reasons).toContain('substrate-node-removed');
    expect(rows.get(joined[0]!)).toMatchObject({ provision_state: 'adopted', no_schedule_reasons: [] });
  });

  it('still reaches a newly gone node after more than 500 removed and 500 merely disconnected nodes', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([{ ...gpu, nodes: 1 }]));
    await world.converge(pool.id, 6);
    const server = await world.server(pool.id);
    const db = world.fixture.database;
    const { rows: owner } = await db.query<{ site_id: string; owner_tenant_id: string }>(
      `SELECT site_id, owner_tenant_id FROM pools WHERE id = $1`,
      [pool.id],
    );
    const insert = (prefix: string, state: string, reasons: string[]) =>
      db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                            connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard,
                            version, no_schedule_reasons)
         SELECT $1 || lpad(g::text, 24, '0'), $2, $3, $4, 'host', $5, false, false, 'disconnected', 'platform', 1, 1, 1,
                1, 0, 1, $6::text[]
           FROM generate_series(1, 501) g`,
        [prefix, owner[0]!.site_id, pool.id, owner[0]!.owner_tenant_id, state, reasons],
      );
    // Long gone and retired, and merely disconnected (their Nodes are still listed).
    await insert('node_01', 'retired', ['substrate-node-removed']);
    await insert('node_00', 'adopted', []);
    await db.query(
      `INSERT INTO kubernetes_substrate_nodes (node_id, pool_id, kubernetes_node, kubernetes_uid)
       SELECT 'node_00' || lpad(g::text, 24, '0'), $1, 'stuck-' || g, 'uid-stuck-' || g FROM generate_series(1, 501) g`,
      [pool.id],
    );
    const extra = Array.from({ length: 501 }, (_, i) => ({ name: `stuck-${i + 1}`, labels: {} }));
    world.extraNodes.set(server, [...extra, { name: 'ghost-0', labels: { [substratePoolLabel]: pool.id } }]);
    const [ghost] = await world.joinNodes(pool.id, 1, ['ghost-0']);
    await world.converge(pool.id, 4);
    // The ghost's Node is deleted and its bcd goes away.
    world.extraNodes.set(server, extra);
    await world.fixture.database.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [ghost]);
    await world.converge(pool.id, 20);
    const { rows } = await db.query<{ provision_state: string }>(`SELECT provision_state FROM nodes WHERE id = $1`, [
      ghost,
    ]);
    expect(rows[0]!.provision_state).toBe('retired');
    const { rows: stuck } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nodes WHERE pool_id = $1 AND id LIKE 'node_00%' AND provision_state = 'adopted'`,
      [pool.id],
    );
    expect(Number(stuck[0]!.count)).toBe(501);
  }, 60_000);
});

describe('substrate: owned nodes', () => {
  it('a node that joined with the hosted token but never connects counts only for the grace window, then is retired', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    await world.converge(pool.id, 6);
    const [alive] = await world.joinNodes(pool.id, 1);
    // bcd spends a use and creates its node row, then dies before it ever connects (its Node is replaced).
    const [dead] = await world.joinNodes(pool.id, 1, undefined, undefined, { connected: false });
    await world.converge(pool.id, 3);
    // Still starting: it counts, so no token is kept for it.
    expect(await world.substrate(pool.id)).toMatchObject({ nodes_listed: 2, nodes_joined: 2, join_token_id: null });

    await world.fixture.advance(substrateFirstConnectGraceSeconds * 1000);
    await world.converge(pool.id, 3);
    const row = await world.substrate(pool.id);
    // It no longer counts: the replacement Node gets a token with one use.
    expect(row).toMatchObject({ nodes_listed: 2, nodes_joined: 1, token_applied: true });
    const { rows: token } = await world.fixture.database.query<any>(`SELECT uses_left FROM join_tokens WHERE id = $1`, [
      row.join_token_id,
    ]);
    expect(token[0].uses_left).toBe(1);
    // And it is retired with its certificates revoked, not left provisioned for good.
    const { rows } = await world.fixture.database.query<any>(
      `SELECT id, provision_state, no_schedule_reasons FROM nodes WHERE id = ANY($1)`,
      [[alive, dead]],
    );
    const byId = new Map(rows.map((node: any) => [node.id, node]));
    expect(byId.get(dead)).toMatchObject({ provision_state: 'retired', no_schedule_reasons: ['substrate-node-removed'] });
    expect(byId.get(alive)).toMatchObject({ provision_state: 'adopted', no_schedule_reasons: [] });
    const removed = (await world.events('kubernetes.substrate.node-removed')).map((event) => event.data);
    expect(removed).toEqual([expect.objectContaining({ nodeId: dead, reason: 'never-connected', retired: true })]);
  });

  it('machines joined into the pool some other way never count as joined, and teardown leaves them alone', async () => {
    world = await substrateWorld();
    const pool = await world.createPool(createSpec([gpu]));
    // Two metal machines joined the pool with a token of their own.
    const metal = await world.joinNodes(pool.id, 2, undefined, undefined, { foreign: true });
    await world.converge(pool.id, 6);
    // The cluster's two Nodes still get a token with two uses.
    const first = await world.substrate(pool.id);
    expect(first).toMatchObject({ state: 'ready', nodes_listed: 2, nodes_joined: 0, token_applied: true });
    const { rows: token } = await world.fixture.database.query<any>(`SELECT uses_left FROM join_tokens WHERE id = $1`, [
      first.join_token_id,
    ]);
    expect(token[0].uses_left).toBe(2);
    const owned = await world.joinNodes(pool.id, 2);
    await world.converge(pool.id, 3);
    expect(await world.substrate(pool.id)).toMatchObject({ nodes_joined: 2, join_token_id: null });
    // A booking on a metal machine does not hold the teardown.
    await world.fixture.database.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ($1, $2, $3, $4, 'reservation', $5, tstzrange(compute_now(), compute_now() + interval '1 day'), 1)`,
      [newId('alloc'), world.rootTenant, pool.id, metal[0], newId('res')],
    );

    // The pool stays live without its substrate: only the substrate's own nodes are cordoned and retired.
    const { substrate: _substrate, ...without } = pool.policy;
    await world.api.pools.update(world.root, { tenantId: world.rootTenant, poolId: pool.id, policy: without });
    await world.converge(pool.id, 12);
    expect(await world.substrate(pool.id)).toMatchObject({ state: 'deleted' });
    const { rows } = await world.fixture.database.query<any>(
      `SELECT id, provision_state, cordoned, no_schedule_reasons FROM nodes WHERE pool_id = $1`,
      [pool.id],
    );
    const byId = new Map(rows.map((node: any) => [node.id, node]));
    for (const id of owned) expect(byId.get(id)).toMatchObject({ provision_state: 'retired', cordoned: true });
    for (const id of metal)
      expect(byId.get(id)).toMatchObject({ provision_state: 'adopted', cordoned: false, no_schedule_reasons: [] });
    const { rows: certs } = await world.fixture.database.query<any>(
      `SELECT count(*)::int AS n FROM node_certs WHERE node_id = ANY($1) AND revoked_at IS NOT NULL`,
      [metal],
    );
    expect(certs[0].n).toBe(0);
  });
});
