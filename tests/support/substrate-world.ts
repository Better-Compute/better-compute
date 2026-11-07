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
  /**
   * Inserts `count` adopted nodes in the pool, as bcd joining would; with `hostnames`, node `i` reports inventory
   * `os.hostname` `hostnames[i]` (its Kubernetes Node name), plus the inventory sections `sections[i]`. Each is
   * admitted, as JoinService records it (the `node.joined` audit row), by the substrate's latest hosted token;
   * `foreign` joins them with a token of their own (a machine joined into the pool some other way), and
   * `connected: false` leaves them joined but never connected (no session yet).
   */
  joinNodes(
    poolId: string,
    count: number,
    hostnames?: readonly (string | undefined)[],
    sections?: readonly (Record<string, unknown> | undefined)[],
    options?: { foreign?: boolean; connected?: boolean },
  ): Promise<string[]>;
  /** The Node names the fake Kubernetes API lists for the substrate's cluster now. */
  nodeNames(poolId: string): Promise<string[]>;
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
    async nodeNames(poolId: string) {
      const row = await substrate(poolId);
      const { rows } = await world.fixture.database.query<{ endpoint: string }>(
        `SELECT endpoint FROM kubernetes_clusters WHERE id = $1`,
        [row.cluster_id],
      );
      return kube.nodeList(rows[0]!.endpoint).map((node) => node.name);
    },
    async joinNodes(
      poolId: string,
      count: number,
      hostnames?: readonly (string | undefined)[],
      sections?: readonly (Record<string, unknown> | undefined)[],
      options: { foreign?: boolean; connected?: boolean } = {},
    ) {
      const ids: string[] = [];
      const connected = options.connected ?? true;
      const { rows: tokens } = await world.fixture.database.query<{ token_id: string }>(
        `SELECT token_id FROM kubernetes_substrate_tokens WHERE pool_id = $1 ORDER BY issued_at DESC, token_id DESC LIMIT 1`,
        [poolId],
      );
      const tokenId = options.foreign ? newId('jt') : tokens[0]?.token_id;
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
           VALUES ($1, $2, $3, $4, 'host', $5, false, false, $6, 'platform', 1, 1, 1, 1, 0, 1)`,
          [
            id,
            rows[0]!.site_id,
            poolId,
            rows[0]!.owner_tenant_id,
            connected ? 'adopted' : 'adopting',
            connected ? 'connected' : 'disconnected',
          ],
        );
        await world.fixture.database.query(
          connected
            ? `INSERT INTO node_sessions (node_id, session_epoch, connected_at) VALUES ($1, 1, compute_now())`
            : `INSERT INTO node_sessions (node_id, session_epoch, last_seen) VALUES ($1, 0, compute_now())`,
          [id],
        );
        if (tokenId !== undefined)
          await world.fixture.database.query(
            `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, details)
             VALUES ($1, $2, 'node.joined', 'node', $3, $4::jsonb)`,
            [newId('aud'), rows[0]!.owner_tenant_id, id, JSON.stringify({ attestor: 'join-token', tokenId })],
          );
        const hostname = hostnames?.[i];
        const extra = sections?.[i];
        if (hostname !== undefined || extra !== undefined)
          await world.fixture.database.query(
            `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
             VALUES ($1, $2, decode($3, 'hex'), '{}'::jsonb, $4::jsonb, compute_now())`,
            [
              `inv_${id}`,
              id,
              'ab'.repeat(32),
              JSON.stringify({ ...(hostname !== undefined ? { os: { hostname } } : {}), ...(extra ?? {}) }),
            ],
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
