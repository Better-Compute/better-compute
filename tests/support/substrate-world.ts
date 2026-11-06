import { newId } from '@better-compute/core';
import type { KubernetesOptions } from '@better-compute/kubernetes';
import { kubernetesSubstrateAgent } from '@better-compute/provider-kubernetes';
import { FakeKubeApi, type FakeKubeNode } from './fake-kube-api.js';
import { kubernetesWorld, type KubernetesWorld } from './kubernetes-world.js';

// The kubernetes world plus pool substrates: provider-kubernetes' real substrate agent over the fake Kubernetes API,
// whose Nodes are the fake provider's node pools (nodeCount per zone, labelled as the pool asks), and helpers to
// create a substrate pool, run the substrate reconciler, and stand in for nodes whose bcd joined.

const pin = (n: number) => `sha256/${Buffer.alloc(32, n).toString('base64')}`;
export const substrateBcd = {
  image: `registry.example.com/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
  gatewayUrl: 'https://gw.example.com:8443',
  pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
  joinEncryptionJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }),
};

export interface SubstrateWorld extends KubernetesWorld {
  kube: FakeKubeApi;
  /** Extra Nodes per API server origin (an adopted cluster's own nodes). */
  extraNodes: Map<string, FakeKubeNode[]>;
  /** A metal-host pool on the world's site with `policy.substrate` (account defaults to the world's). */
  createPool(substrate: Record<string, unknown>, key?: string, policy?: Record<string, unknown>): Promise<any>;
  /** Runs the substrate reconciler `rounds` times, then the cluster reconciler, alternating. */
  converge(poolId: string, rounds?: number): Promise<void>;
  substrate(poolId: string): Promise<any>;
  /** Inserts `count` adopted nodes in the pool, as bcd joining would. */
  joinNodes(poolId: string, count: number): Promise<string[]>;
  /** The API server origin of the substrate's cluster. */
  server(poolId: string): Promise<string>;
}

export async function substrateWorld(
  options: Omit<KubernetesOptions, 'providers'> & { withoutAgent?: boolean } = {},
): Promise<SubstrateWorld> {
  const extraNodes = new Map<string, FakeKubeNode[]>();
  let cloudRef: KubernetesWorld['cloud'] | undefined;
  const kube = new FakeKubeApi({
    nodes(server) {
      const nodes: FakeKubeNode[] = [...(extraNodes.get(server) ?? [])];
      for (const cluster of cloudRef?.clusters.values() ?? []) {
        if (new URL(cluster.endpoint).origin !== server) continue;
        for (const [name, pool] of cluster.pools) {
          if (!pool.ready) continue;
          const zones = Math.max(1, pool.spec.zones?.length ?? 1);
          for (let i = 0; i < pool.spec.nodeCount * zones; i++)
            nodes.push({ name: `${cluster.spec.name}-${name}-${i}`, labels: { ...(pool.spec.labels ?? {}) } });
        }
      }
      return nodes;
    },
    accepts: (token) => cloudRef?.tokens.includes(token) ?? false,
  });
  const { withoutAgent, ...rest } = options;
  const world = await kubernetesWorld({
    ...(withoutAgent ? {} : { substrate: { agent: kubernetesSubstrateAgent({ ...substrateBcd, transport: kube.transport }) } }),
    ...rest,
  });
  cloudRef = world.cloud;
  let keys = 0;
  const tick = async (job: string) => {
    await world.fixture.advance(10_000);
    await world.fixture.compute.jobs[job]!.tick();
  };
  const substrate = async (poolId: string) => {
    const { rows } = await world.fixture.database.query(
      `SELECT * FROM kubernetes_pool_substrates WHERE pool_id = $1`,
      [poolId],
    );
    return rows[0];
  };
  return Object.assign(world, {
    kube,
    extraNodes,
    async createPool(spec: Record<string, unknown>, key = `substrate-${++keys}`, policy: Record<string, unknown> = {}) {
      return world.api.pools.create(world.root, {
        tenantId: world.rootTenant,
        siteId: world.siteId,
        class: 'metal-host',
        gpuModel: 'L4',
        policy: { kubernetes: { platformOperated: true }, ...policy, substrate: { account: world.accountId, ...spec } },
        idempotencyKey: key,
      });
    },
    async converge(poolId: string, rounds = 8) {
      for (let round = 0; round < rounds; round++) {
        // The periodic sweeps queue the keys; each tick runs what is due.
        await tick('kubernetes.substrates');
        await tick('kubernetes.clusters');
      }
      void poolId;
    },
    substrate,
    async joinNodes(poolId: string, count: number) {
      const ids: string[] = [];
      const { rows } = await world.fixture.database.query<{ site_id: string; owner_tenant_id: string }>(
        `SELECT site_id, owner_tenant_id FROM pools WHERE id = $1`,
        [poolId],
      );
      for (let i = 0; i < count; i++) {
        const id = newId('node');
        await world.fixture.database.query(
          `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                              connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard,
                              version)
           VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
          [id, rows[0]!.site_id, poolId, rows[0]!.owner_tenant_id],
        );
        await world.fixture.database.query(
          `INSERT INTO node_sessions (node_id, session_epoch, connected_at) VALUES ($1, 1, compute_now())`,
          [id],
        );
        ids.push(id);
      }
      return ids;
    },
    async server(poolId: string) {
      const row = await substrate(poolId);
      const { rows } = await world.fixture.database.query<{ endpoint: string }>(
        `SELECT endpoint FROM kubernetes_clusters WHERE id = $1`,
        [row.cluster_id],
      );
      return new URL(rows[0]!.endpoint).origin;
    },
  });
}
