import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '@better-compute/core';
import { kubernetes, substratePoolLabel } from '@better-compute/kubernetes';
import { gcpProvider, type KubeTransport } from '@better-compute/provider-gcp';
import { kubernetesSubstrateAgent } from '@better-compute/provider-kubernetes';
import { computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { FakeKubeApi } from './support/fake-kube-api.js';
import { GkeEmulator } from './support/gke-emulator.js';
import { substrateBcd } from './support/substrate-world.js';

// The pool substrate on the reference GKE driver (provider-gcp over the GKE emulator), with nothing GKE-specific in
// the substrate: the same reconciler that runs on the fake provider creates a GKE Standard cluster with a GPU node
// pool labelled for bcd, mints its credential through GKE's own TokenRequest path, applies bcd, and on archive
// deletes the cluster.

const gke = new GkeEmulator();
gke.operationDelayTicks = 0;
const minted: string[] = [];

/** The cluster-side half of GKE credentials (namespace, service account, binding, TokenRequest). */
const credentialsKube: KubeTransport = async (request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/token')) {
    const token = `gke-sa-token-${minted.length + 1}`;
    minted.push(token);
    const ttl = (request.body as any).spec.expirationSeconds as number;
    return {
      status: 201,
      body: { status: { token, expirationTimestamp: new Date(Date.now() + ttl * 1000).toISOString() } },
    };
  }
  if (request.method === 'GET') return { status: 404, body: { kind: 'Status', reason: 'NotFound' } };
  return { status: 201, body: request.body };
};

const kube = new FakeKubeApi({
  nodes(server) {
    const nodes: { name: string; labels: Record<string, string> }[] = [];
    for (const cluster of gke.clusters.values() as Iterable<any>) {
      if (`https://${cluster.endpoint}` !== server) continue;
      for (const pool of cluster.nodePools ?? [])
        for (let i = 0; i < Number(pool.initialNodeCount ?? 0); i++)
          nodes.push({ name: `gke-${cluster.name}-${pool.name}-${i}`, labels: { ...(pool.config?.labels ?? {}) } });
    }
    return nodes;
  },
  accepts: (token) => minted.includes(token),
});

let fixture: ComputeFixture;
let api: any;
let root: { token: string };
let poolId: string;
const logs: string[] = [];

async function converge(rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++)
    for (const job of ['kubernetes.substrates', 'kubernetes.clusters']) {
      await fixture.advance(10_000);
      await fixture.compute.jobs[job]!.tick();
    }
}
const substrate = async () =>
  (await fixture.database.query<any>(`SELECT * FROM kubernetes_pool_substrates WHERE pool_id = $1`, [poolId])).rows[0];

beforeAll(async () => {
  const providers = [gcpProvider({ fetch: gke.fetch, kubeTransport: credentialsKube })];
  const log = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (message: string, fields?: unknown) => void logs.push(JSON.stringify({ message, fields })),
    ]),
  ) as unknown as Logger;
  fixture = await computeFixture({
    clock: 'sim',
    log,
    modules: [
      vps({ providers }),
      kubernetes({
        providers,
        substrate: { agent: kubernetesSubstrateAgent({ ...substrateBcd, transport: kube.transport }) },
      }),
    ],
  });
  (fixture.iam as { rootTenantId?: string }).rootTenantId = fixture.tenants.root.id;
  root = { token: fixture.tenants.root.token };
  fixture.iam.allow({ token: root.token });
  api = fixture.compute.api;
  const account = await api.providerAccounts.create(root, {
    tenantId: fixture.tenants.root.id,
    provider: 'gcp',
    name: 'gke',
    config: { projectId: 'p', zones: ['us-central1-a', 'us-central1-b'] },
  });
  const site = await api.sites.create(root, {
    tenantId: fixture.tenants.root.id,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'gke-site',
  });
  ({ id: poolId } = await api.pools.create(root, {
    tenantId: fixture.tenants.root.id,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'L4',
    policy: {
      kubernetes: { platformOperated: true },
      substrate: {
        kind: 'kubernetes',
        account: account.id,
        cluster: { create: { location: 'us-central1' } },
        flavors: [{ name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } }],
      },
    },
    idempotencyKey: 'gke-pool',
  }));
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

describe('substrate on GKE (emulator)', () => {
  it('creates a GKE cluster with the labelled GPU node pool and applies bcd with a GKE-minted credential', async () => {
    await converge(10);
    const row = await substrate();
    expect(row).toMatchObject({ state: 'ready', nodes_listed: 2, token_applied: true });
    const cluster = [...(gke.clusters.values() as Iterable<any>)][0];
    expect(cluster.nodePools.map((pool: any) => pool.name)).toEqual(['gpu']);
    expect(cluster.nodePools[0].config.labels).toMatchObject({ [substratePoolLabel]: poolId });
    expect(cluster.nodePools[0].config.accelerators[0]).toMatchObject({ acceleratorType: 'nvidia-l4', acceleratorCount: 1 });
    const server = `https://${cluster.endpoint}`;
    expect(kube.kinds(server)).toEqual([
      'ConfigMap/bcd-config',
      'DaemonSet/bcd',
      'Namespace/bcd-system',
      'Secret/bcd-join-token',
    ]);
    // Nothing secret in the rows or the logs.
    const stored = JSON.stringify(
      (await fixture.database.query(`SELECT * FROM kubernetes_pool_substrates`)).rows,
    ) + logs.join('\n');
    for (const token of minted) expect(stored).not.toContain(token);
  });

  it('deletes the GKE cluster when the pool is archived', async () => {
    await api.pools.archive(root, { tenantId: fixture.tenants.root.id, poolId });
    await converge(12);
    expect(await substrate()).toMatchObject({ state: 'deleted' });
    expect(gke.clusters.size).toBe(0);
  });
});
