import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kubernetes, substratePoolLabel } from '@better-compute/kubernetes';
import { kubernetesSubstrateAgent } from '@better-compute/provider-kubernetes';
import { cdiSpecPath, createDevStack, type DevStack } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { FakeKubeApi } from '../support/fake-kube-api.js';
import { fakeKubernetes, fakeKubernetesProvider } from '../support/fake-kubernetes.js';
import { substrateBcd } from '../support/substrate-world.js';

// The pool substrate end to end (DO program P5 task 6, provider-neutral): a pool with policy.substrate on a managed
// Kubernetes provider. The kubernetes module creates the cluster and its GPU node pool, applies bcd's DaemonSet and
// a hosted join token Secret through the cluster API; a simulated kubelet per selected Node runs bcd's join
// container (a FakeDaemon joining through the real gateway with the token read from the Secret, as `bcd join
// --token-file` does); the nodes are adopted into the pool, and compute books their GPUs for a `binding:
// 'kubernetes'` reservation, handing them to bcd's device plugin. Once every node joined the token is revoked and
// the Secret deleted.

const cloud = fakeKubernetes();
cloud.delayTicks = 0;
const providers = [fakeKubernetesProvider(cloud)];
const kube = new FakeKubeApi({
  nodes(server) {
    const nodes: { name: string; labels: Record<string, string> }[] = [];
    for (const cluster of cloud.clusters.values()) {
      if (new URL(cluster.endpoint).origin !== server) continue;
      for (const [name, pool] of cluster.pools)
        for (let i = 0; i < pool.spec.nodeCount; i++)
          nodes.push({ name: `${cluster.spec.name}-${name}-${i}`, labels: { ...(pool.spec.labels ?? {}) } });
    }
    return nodes;
  },
  accepts: (token) => cloud.tokens.includes(token),
});

let dev: DevStack;
let api: any;
let poolId: string;
let server: string;
const kubelets = new Map<string, string>(); // Kubernetes Node name → better-compute node id

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Wakes the substrate now (the periodic sweep runs every 30 s of wall time). */
const kick = () =>
  dev.compute.context.sql.transaction((tx) => dev.compute.context.work.enqueue(tx, 'kubernetes.substrates', poolId));

const substrate = async () =>
  (await dev.database.query<any>(`SELECT * FROM kubernetes_pool_substrates WHERE pool_id = $1`, [poolId])).rows[0];

/**
 * The kubelets: every Node the DaemonSet selects that runs no bcd yet starts one, whose join container reads the
 * token from the Secret (no Secret: the pod's join waits).
 */
async function runKubelets(): Promise<void> {
  const daemonSet = kube.get(server, '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
  const secret = kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token');
  if (!daemonSet || !secret) return;
  const selector: Record<string, string> = daemonSet.spec.template.spec.nodeSelector ?? {};
  const fresh = (await kube.transport({
    url: `${server}/api/v1/nodes`,
    method: 'GET',
    caPem: '-----BEGIN CERTIFICATE-----',
    token: cloud.tokens.at(-1)!,
    signal: new AbortController().signal,
  })) as { body: { items: { metadata: { name: string; labels: Record<string, string> } }[] } };
  const pending = fresh.body.items
    .map((item) => item.metadata)
    .filter((node) => Object.entries(selector).every(([key, value]) => node.labels[key] === value))
    .filter((node) => !kubelets.has(node.name));
  if (pending.length === 0) return;
  const ids = await dev.join({
    poolId,
    count: pending.length,
    token: secret.stringData.token,
    hostnames: pending.map((node) => node.name),
    seed: `k8s-${kubelets.size}`,
  });
  pending.forEach((node, index) => kubelets.set(node.name, ids[index]!));
}

beforeAll(async () => {
  dev = await createDevStack({
    modules: [
      vps({ providers }),
      kubernetes({
        providers,
        substrate: { agent: kubernetesSubstrateAgent({ ...substrateBcd, transport: kube.transport }) },
      }),
    ],
  });
  api = dev.compute.api;
  const account = await api.providerAccounts.create(dev.root, {
    tenantId: dev.rootTenantId,
    provider: 'fake-gke',
    name: 'managed-k8s',
    config: { zones: ['dev-1-a'] },
  });
  const site = await api.sites.create(dev.root, {
    tenantId: dev.rootTenantId,
    kind: 'shared',
    region: 'dev-1',
    idempotencyKey: 'substrate-site',
  });
  ({ id: poolId } = await api.pools.create(dev.root, {
    tenantId: dev.rootTenantId,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    policy: {
      acceptance: [{ kind: 'diag.nvml' }],
      kubernetes: { platformOperated: true },
      substrate: {
        kind: 'kubernetes',
        account: account.id,
        cluster: { create: { location: 'dev-1' } },
        flavors: [{ name: 'gpu', machineType: 'a3-highgpu-8g', nodes: 2, gpus: { type: 'nvidia-h100-80gb', count: 8 } }],
      },
    },
    idempotencyKey: 'substrate-pool',
  }));
  await api.pools.offer(dev.root, {
    tenantId: dev.rootTenantId,
    poolId,
    toTenantId: dev.rootTenantId,
    quota: { gpu: 16 },
  });
}, 180_000);

afterAll(async () => {
  await dev?.close();
});

describe('Kubernetes pool substrate, join and book (end to end)', () => {
  it('creates the cluster, applies bcd with a hosted token, and the nodes join the pool', async () => {
    const ready = await until('the substrate to apply bcd', async () => {
      await kick();
      const row = await substrate();
      return row?.state === 'ready' && row.token_applied ? row : undefined;
    });
    const { rows } = await dev.database.query<{ endpoint: string }>(`SELECT endpoint FROM kubernetes_clusters WHERE id = $1`, [
      ready.cluster_id,
    ]);
    server = new URL(rows[0]!.endpoint).origin;
    expect(kube.kinds(server)).toContain('DaemonSet/bcd');
    expect(kube.get(server, '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd').spec.template.spec.nodeSelector).toEqual({
      [substratePoolLabel]: poolId,
    });
    await runKubelets();
    expect(kubelets.size).toBe(2);
    await dev.waitFor([...kubelets.values()], { timeoutMs: 60_000 });
    const nodes = await dev.database.query<{ id: string; pool_id: string; trust: string }>(
      `SELECT id, pool_id, trust FROM nodes WHERE id = ANY($1) ORDER BY id`,
      [[...kubelets.values()]],
    );
    expect(nodes.rows.every((node) => node.pool_id === poolId)).toBe(true);
    // The pool is platform-operated: hosted nodes land at the pool's trust.
    expect(new Set(nodes.rows.map((node) => node.trust))).toEqual(new Set(['platform']));
  }, 120_000);

  it('revokes the token and deletes the Secret once every node joined', async () => {
    const before = await substrate();
    const done = await until('the token to be revoked', async () => {
      await kick();
      const row = await substrate();
      return row?.join_token_id === null && row.nodes_joined === 2 ? row : undefined;
    });
    expect(done).toMatchObject({ state: 'ready', nodes_listed: 2 });
    expect(kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token')).toBeUndefined();
    const { rows } = await dev.database.query<any>(`SELECT hosted, revoked_at, uses_left FROM join_tokens WHERE id = $1`, [
      before.join_token_id,
    ]);
    expect(rows[0]).toMatchObject({ hosted: 'kubernetes', uses_left: 0 });
    expect(rows[0].revoked_at).not.toBeNull();
  }, 60_000);

  it("books the nodes' GPUs for a kubernetes-bound reservation, through bcd's device plugin", async () => {
    const reservation = await api.reservations.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 4 }],
      duration: 3_600_000,
      binding: 'kubernetes',
      idempotencyKey: 'substrate-booking',
    });
    await until('the reservation to bind', async () => {
      const current = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: reservation.id });
      return current.state === 'active' ? current : undefined;
    });
    const { rows } = await dev.database.query<{ id: string; node_id: string; atoms: string[] }>(
      `SELECT id, node_id, atoms FROM allocations WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL`,
      [reservation.id],
    );
    expect(rows).toHaveLength(1);
    expect([...kubelets.values()]).toContain(rows[0]!.node_id);
    const daemon = dev.daemons.get(rows[0]!.node_id)!;
    const spec = JSON.parse(daemon.files.get(cdiSpecPath(rows[0]!.id))!);
    expect(spec.annotations['bcd.dev/binding']).toBe('kubernetes');
    expect(spec.devices).toHaveLength(4);
  }, 60_000);
});
