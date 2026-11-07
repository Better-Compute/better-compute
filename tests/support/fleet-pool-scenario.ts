import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '@better-compute/core';
import { fleetModule, type FleetConfig } from '@better-compute/fleet';
import { kubernetes, substrateNodePoolName, substratePoolLabel, substrateSubject } from '@better-compute/kubernetes';
import { kubernetesSubstrateAgent } from '@better-compute/provider-kubernetes';
import { cdiSpecPath, createDevStack, type DevStack } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { FakeKubeApi } from './fake-kube-api.js';
import type { ManagedKubernetesProfile } from './managed-k8s-profiles.js';
import { substrateBcd } from './substrate-world.js';

// The Kubernetes fleet pool end to end, the same on every managed Kubernetes provider: one FleetConfig document whose
// only provider-specific part is its provider account (and that account's vocabulary: region, machine type,
// accelerator). fleet.apply creates the pool; its substrate creates the cluster and the GPU node pool at the provider
// (the real driver over its emulator), applies bcd's DaemonSet through the cluster API with a credential the driver
// minted; a simulated kubelet per selected Node runs bcd's join container (a FakeDaemon joining through the real
// gateway with the hosted token from the Secret); compute books the nodes' GPUs; a scale-down in the document removes
// a Node and retires its pool node (its booking released once); pruning the pool from the document tears it all down,
// leaving no cluster, node pool, booking, token or bcd object. Adopting a cluster instead leaves the cluster, its own
// node pool and nothing of ours.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
  state?: () => Promise<unknown>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}${state ? `: ${JSON.stringify(await state())}` : ''}`);
    await sleep(50);
  }
}

const accountName = 'managed-k8s';
const siteName = 'k8s';

/** The fleet pool document: identical for every provider but for the account and what the account calls things. */
export function fleetPoolDocument(
  profile: Pick<ManagedKubernetesProfile, 'provider' | 'region' | 'flavor'>,
  accountConfig: Record<string, unknown>,
  pools: { name: string; nodes: number; adopt?: string }[],
): FleetConfig {
  return {
    version: 1,
    sites: [{ name: siteName, kind: 'shared', region: profile.region }],
    providerAccounts: [{ name: accountName, provider: profile.provider, config: accountConfig }],
    pools: pools.map((pool) => ({
      name: pool.name,
      site: siteName,
      class: 'metal-host',
      gpuModel: 'H100',
      policy: {
        acceptance: [{ kind: 'diag.nvml' }],
        kubernetes: { platformOperated: true },
        substrate: {
          kind: 'kubernetes',
          account: accountName,
          cluster: pool.adopt !== undefined ? { adopt: pool.adopt } : { create: { location: profile.region } },
          flavors: [{ name: 'h100', ...profile.flavor, nodes: pool.nodes }],
        },
      },
    })),
  };
}

export function fleetPoolScenario(makeProfile: () => ManagedKubernetesProfile): void {
  const profile = makeProfile();
  const logs: string[] = [];
  const record = (message: string, fields?: unknown) => void logs.push(JSON.stringify({ message, fields }));
  const log: Logger = { debug: record, info: record, warn: record, error: record };
  const kube = new FakeKubeApi({ nodes: (server) => profile.nodes(server), accepts: (token) => profile.accepts(token) });

  let dev: DevStack;
  let api: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let accountConfig: Record<string, unknown>;
  const kubelets = new Map<string, string>(); // Kubernetes Node name → better-compute node id
  let joins = 0;

  const poolIdOf = async (name: string): Promise<string> => {
    const { rows } = await dev.database.query<{ id: string }>(
      `SELECT object_id AS id FROM fleet_names WHERE tenant_id = $1 AND kind = 'pool' AND name = $2`,
      [dev.rootTenantId, name],
    );
    return rows[0]!.id;
  };
  const substrate = async (poolId: string) =>
    (await dev.database.query<any>(`SELECT * FROM kubernetes_pool_substrates WHERE pool_id = $1`, [poolId])).rows[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const substrateState = async (poolId: string) => {
    const row = await substrate(poolId);
    const { rows } = await dev.database.query(
      `SELECT c.state, c.message, (SELECT json_agg(json_build_object('name', p.name, 'state', p.state, 'message', p.message))
                                    FROM kubernetes_node_pools p WHERE p.cluster_id = c.id) AS pools
         FROM kubernetes_clusters c WHERE c.id = $1`,
      [row?.cluster_id ?? ''],
    );
    return { substrate: row && { state: row.state, message: row.message, listed: row.nodes_listed }, cluster: rows[0] };
  };
  const cluster = async (poolId: string) => {
    const row = await substrate(poolId);
    const { rows } = await dev.database.query<{ id: string; endpoint: string | null; provider_id: string | null }>(
      `SELECT id, endpoint, provider_id FROM kubernetes_clusters WHERE id = $1`,
      [row.cluster_id],
    );
    return rows[0]!;
  };
  /** Wakes the substrate and its cluster now (their sweeps run every 30 s of wall time). */
  const kick = async (poolId: string) => {
    const row = await substrate(poolId);
    await dev.compute.context.sql.transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      await dev.compute.context.work.enqueue(tx, 'kubernetes.substrates', poolId);
      if (row?.cluster_id) await dev.compute.context.work.enqueue(tx, 'kubernetes.clusters', row.cluster_id);
    });
  };
  const apply = async (pools: { name: string; nodes: number; adopt?: string }[], prune = false) => {
    const result = await api.fleet.apply(dev.root, {
      tenantId: dev.rootTenantId,
      config: fleetPoolDocument(profile, accountConfig, pools),
      ...(prune ? { prune: true } : {}),
    });
    expect(result.blocked ?? false).toBe(false);
    return result;
  };
  /** The kubelets: every selected Node that runs no bcd yet starts one, whose join reads the Secret's token. */
  const runKubelets = async (poolId: string, server: string): Promise<string[]> => {
    const daemonSet = kube.get(server, '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd');
    const secret = kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token');
    if (!daemonSet || !secret) return [];
    const selector: Record<string, string> = daemonSet.spec.template.spec.nodeSelector ?? {};
    const pending = kube
      .nodeList(server)
      .filter((node) => Object.entries(selector).every(([key, value]) => node.labels[key] === value))
      .filter((node) => !kubelets.has(node.name));
    if (pending.length === 0) return [];
    const ids = await dev.join({
      poolId,
      count: pending.length,
      token: secret.stringData.token,
      hostnames: pending.map((node) => node.name),
      // Fresh machines each time (a retired machine's serial never joins again).
      seed: `${profile.label.toLowerCase()}-${++joins}`,
    });
    pending.forEach((node, index) => kubelets.set(node.name, ids[index]!));
    return ids;
  };
  const book = async (poolId: string, key: string) => {
    const reservation = await api.reservations.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 8 }],
      duration: 3_600_000,
      binding: 'kubernetes',
      idempotencyKey: key,
    });
    return until(`reservation ${key} to bind`, async () => {
      const current = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: reservation.id });
      return current.state === 'active' ? current : undefined;
    });
  };
  const liveAllocations = async (poolId: string) =>
    (
      await dev.database.query<{ id: string; node_id: string; owner_id: string }>(
        `SELECT a.id, a.node_id, a.owner_id FROM allocations a JOIN nodes n ON n.id = a.node_id
          WHERE n.pool_id = $1 AND a.released_at IS NULL ORDER BY a.id`,
        [poolId],
      )
    ).rows;

  beforeAll(async () => {
    dev = await createDevStack({
      log,
      modules: [
        vps({ providers: profile.providers }),
        kubernetes({
          providers: profile.providers,
          substrate: { agent: kubernetesSubstrateAgent({ ...substrateBcd, transport: kube.transport }) },
        }),
        fleetModule(),
      ],
    });
    api = dev.compute.api;
    accountConfig = await profile.accountConfig(async (name, value) => {
      const { ref } = await api.secrets.put(dev.root, {
        tenantId: dev.rootTenantId,
        name,
        value,
        idempotencyKey: `secret-${name}`,
      });
      return ref as string;
    });
  }, 180_000);

  afterAll(async () => {
    await dev?.close();
  });

  describe(`Kubernetes fleet pool on ${profile.label} (end to end)`, () => {
    let poolId: string;
    let server: string;
    let providerId: string;
    const reservations: string[] = [];
    // A flavor's `nodes` are per zone of its node pool (the ProviderKubernetes contract): `zones` Nodes per node.
    const z = profile.zones;

    it('fleet.apply creates the cluster and its labelled GPU node pool at the provider, and applies bcd', async () => {
      await apply([{ name: 'gpu-fleet', nodes: 2 }]);
      poolId = await poolIdOf('gpu-fleet');
      const ready = await until('the substrate to apply bcd', async () => {
        await kick(poolId);
        const row = await substrate(poolId);
        return row?.state === 'ready' && row.token_applied && row.nodes_listed === 2 * z ? row : undefined;
      }, 60_000, () => substrateState(poolId));
      const created = await cluster(poolId);
      server = new URL(created.endpoint!).origin;
      providerId = created.provider_id!;
      expect(ready).toMatchObject({ mode: 'create' });
      expect(profile.clusters()).toContain(providerId);
      expect(profile.nodePools(providerId)).toContain('h100');
      expect(profile.machines(providerId).length).toBeGreaterThan(0);
      // The flavor's Nodes carry the pool label; bcd's DaemonSet selects exactly them.
      const selected = kube.nodeList(server).filter((node) => node.labels[substratePoolLabel] === poolId);
      expect(selected).toHaveLength(2 * z);
      expect(kube.kinds(server)).toEqual(
        expect.arrayContaining(['ConfigMap/bcd-config', 'DaemonSet/bcd', 'Namespace/bcd-system', 'Secret/bcd-join-token']),
      );
      expect(kube.get(server, '/apis/apps/v1/namespaces/bcd-system/daemonsets/bcd').spec.template.spec.nodeSelector).toEqual({
        [substratePoolLabel]: poolId,
      });
      // Every cluster API call carried a credential the driver minted.
      expect(kube.tokens.every((token) => profile.accepts(token))).toBe(true);
      // The applied document is the fleet: planning it again changes nothing, and neither does its export.
      const document = fleetPoolDocument(profile, accountConfig, [{ name: 'gpu-fleet', nodes: 2 }]);
      const again = await api.fleet.plan(dev.root, { tenantId: dev.rootTenantId, config: document });
      expect(again.calls).toEqual([]);
      const { config: exported } = await api.fleet.export(dev.root, { tenantId: dev.rootTenantId });
      expect((await api.fleet.plan(dev.root, { tenantId: dev.rootTenantId, config: exported, prune: true })).calls).toEqual([]);
    }, 90_000);

    it('the Nodes bcd runs on join the fleet pool, and the hosted token goes once they all did', async () => {
      const ids = await runKubelets(poolId, server);
      expect(ids).toHaveLength(2 * z);
      await dev.waitFor(ids, { timeoutMs: 60_000 });
      const { rows } = await dev.database.query<{ pool_id: string; trust: string }>(
        `SELECT pool_id, trust FROM nodes WHERE id = ANY($1)`,
        [ids],
      );
      expect(rows.map((row) => [row.pool_id, row.trust])).toEqual(ids.map(() => [poolId, 'platform']));
      const done = await until('the token to be revoked', async () => {
        await kick(poolId);
        const row = await substrate(poolId);
        return row?.join_token_id === null && row.nodes_joined === 2 * z ? row : undefined;
      });
      expect(done).toMatchObject({ state: 'ready', nodes_listed: 2 * z });
      // The substrate knows which Node each pool node is (by the Node name bcd reports).
      await until('every pool node to be matched to its Node', async () => {
        await kick(poolId);
        const { rows: matched } = await dev.database.query<{ node_id: string; kubernetes_node: string | null }>(
          `SELECT node_id, kubernetes_node FROM kubernetes_substrate_nodes WHERE node_id = ANY($1)`,
          [ids],
        );
        return matched.length === ids.length && matched.every((row) => kubelets.get(row.kubernetes_node ?? '') === row.node_id);
      });
      expect(kube.get(server, '/api/v1/namespaces/bcd-system/secrets/bcd-join-token')).toBeUndefined();
    }, 90_000);

    it("books every node's GPUs for kubernetes-bound reservations, through bcd's device plugin", async () => {
      // One 8-GPU booking per node: every node's GPUs are booked.
      for (let i = 0; i < 2 * z; i++) reservations.push((await book(poolId, `${profile.label}-booking-${i}`)).id);
      const live = await liveAllocations(poolId);
      expect(live).toHaveLength(2 * z);
      expect(new Set(live.map((allocation) => allocation.node_id))).toEqual(new Set(kubelets.values()));
      for (const allocation of live) {
        const spec = JSON.parse(dev.daemons.get(allocation.node_id)!.files.get(cdiSpecPath(allocation.id))!);
        expect(spec.annotations['bcd.dev/binding']).toBe('kubernetes');
        expect(spec.devices).toHaveLength(8);
      }
    }, 60_000);

    it('a scale-down in the document removes Nodes: their nodes are retired and their bookings released once', async () => {
      await apply([{ name: 'gpu-fleet', nodes: 1 }]);
      const remaining = await until('the provider to remove Nodes', async () => {
        await kick(poolId);
        const nodes = kube.nodeList(server).filter((node) => node.labels[substratePoolLabel] === poolId);
        return nodes.length === z ? nodes.map((node) => node.name) : undefined;
      });
      const gone = [...kubelets].filter(([name]) => !remaining.includes(name));
      expect(gone).toHaveLength(z);
      // Their bcd pods died with the Nodes.
      for (const [, id] of gone) dev.daemons.get(id)!.crash('node-deleted');
      const retired = await until('the removed nodes to be retired', async () => {
        await kick(poolId);
        const { rows } = await dev.database.query<{ provision_state: string; no_schedule_reasons: string[] }>(
          `SELECT provision_state, no_schedule_reasons FROM nodes WHERE id = ANY($1)`,
          [gone.map(([, id]) => id)],
        );
        return rows.every((row) => row.no_schedule_reasons.includes('substrate-node-removed')) ? rows : undefined;
      }, 60_000, async () => ({
        gone: gone.map(([name]) => name),
        listed: kube.nodeList(server).map((node) => node.name),
        nodes: (
          await dev.database.query(
            `SELECT n.id, n.connectivity, n.provision_state, n.no_schedule_reasons, k.kubernetes_node
               FROM nodes n LEFT JOIN kubernetes_substrate_nodes k ON k.node_id = n.id WHERE n.pool_id = $1`,
            [poolId],
          )
        ).rows,
        ...(await substrateState(poolId)),
      }));
      expect(new Set(retired.map((row) => row.provision_state))).toEqual(new Set(['retired']));
      const live = await liveAllocations(poolId);
      expect(live.map((allocation) => allocation.node_id).sort()).toEqual(
        remaining.map((name) => kubelets.get(name)!).sort(),
      );
      const states = await Promise.all(
        reservations.map(async (reservationId) =>
          (await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId })).state,
        ),
      );
      expect(states.filter((state) => state === 'released')).toHaveLength(z);
      expect(states.filter((state) => state === 'active')).toHaveLength(z);
      const row = await until('the substrate to settle on the Nodes left', async () => {
        await kick(poolId);
        const current = await substrate(poolId);
        return current?.nodes_listed === z ? current : undefined;
      });
      expect(row).toMatchObject({ state: 'ready', nodes_joined: z, join_token_id: null });
      for (const [name] of gone) kubelets.delete(name);
    }, 90_000);

    it('pruning the pool from the document tears it down and leaves no orphans', async () => {
      // Teardown drains: pruned with bookings still live, the substrate waits for them; nothing is force-released and
      // nothing is deleted at the provider meanwhile.
      const states = await Promise.all(
        reservations.map(async (reservationId) => ({
          reservationId,
          state: (await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId })).state,
        })),
      );
      const active = states.filter((entry) => entry.state === 'active').map((entry) => entry.reservationId);
      expect(active.length).toBeGreaterThan(0);
      const booked = await liveAllocations(poolId);
      await apply([], true);
      const waiting = await until('the substrate to wait for the live bookings', async () => {
        await kick(poolId);
        const row = await substrate(poolId);
        return row?.state === 'deleting' && /Waiting for \d+ booking/.test(row.message ?? '') ? row : undefined;
      }, 60_000, () => substrateState(poolId));
      expect(waiting.message).toContain(`Waiting for ${booked.length} booking`);
      expect(profile.clusters()).toContain(providerId);
      expect(await liveAllocations(poolId)).toEqual(booked);
      // The tenant ends its own bookings; then the teardown goes on.
      for (const reservationId of active)
        await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId });
      await until('the substrate to be deleted', async () => {
        await kick(poolId);
        return (await substrate(poolId))?.state === 'deleted';
      }, 90_000);
      // At the provider: no cluster, no node pool, and no machine left in the account (instance groups, node
      // groups, worker Droplets).
      expect(profile.clusters()).not.toContain(providerId);
      expect(profile.nodePools(providerId)).toEqual([]);
      expect(profile.machines(providerId)).toEqual([]);
      // In compute: no live booking, every node retired, no live hosted token.
      expect(await liveAllocations(poolId)).toEqual([]);
      const { rows: nodes } = await dev.database.query<{ provision_state: string }>(
        `SELECT provision_state FROM nodes WHERE pool_id = $1`,
        [poolId],
      );
      expect(nodes.length).toBeGreaterThan(0);
      expect(new Set(nodes.map((node) => node.provision_state))).toEqual(new Set(['retired']));
      const { rows: tokens } = await dev.database.query(
        `SELECT id FROM join_tokens WHERE pool_id = $1 AND revoked_at IS NULL AND uses_left > 0`,
        [poolId],
      );
      expect(tokens).toEqual([]);
      const { rows: clusters } = await dev.database.query<{ state: string }>(
        `SELECT state FROM kubernetes_clusters WHERE substrate_pool_id = $1`,
        [poolId],
      );
      expect(clusters.map((row) => row.state)).toEqual(['deleted']);
      // Those kubelets are gone with their cluster (EKS may reuse their IP-based Node names in another one).
      kubelets.clear();
    }, 120_000);
  });

  describe(`an adopted cluster on ${profile.label} (end to end)`, () => {
    let poolId: string;
    let adopted: string;
    let server: string;
    let ownPools: string[];
    let ownMachines: string[];

    it('adopts a running cluster: adds the flavor node pool beside its own, and bcd joins its Nodes', async () => {
      adopted = profile.seedCluster();
      ownPools = profile.nodePools(adopted);
      ownMachines = profile.machines(adopted).sort();
      await apply([{ name: 'gpu-adopted', nodes: 1, adopt: adopted }]);
      poolId = await poolIdOf('gpu-adopted');
      await until('the substrate to apply bcd', async () => {
        await kick(poolId);
        const row = await substrate(poolId);
        return row?.state === 'ready' && row.token_applied && row.nodes_listed === profile.zones ? row : undefined;
      }, 60_000, () => substrateState(poolId));
      server = new URL((await cluster(poolId)).endpoint!).origin;
      expect(profile.nodePools(adopted).sort()).toEqual([...ownPools, substrateNodePoolName(poolId, 'h100')].sort());
      const ids = await runKubelets(poolId, server);
      expect(ids).toHaveLength(profile.zones);
      // The substrate reaches the cluster as its own cluster-admin subject (DOKS names its service account per role).
      expect(profile.accessObjects(server).some((object) => object.startsWith(`ServiceAccount/bc-access/${substrateSubject}`))).toBe(true);
      await dev.waitFor(ids, { timeoutMs: 60_000 });
      await until('the token to be revoked', async () => {
        await kick(poolId);
        const row = await substrate(poolId);
        return row?.join_token_id === null && row.nodes_joined === profile.zones ? row : undefined;
      });
    }, 120_000);

    it('issues no tenant credential on the adopted cluster (it would outlive the substrate there)', async () => {
      const { cluster_id: clusterId } = await substrate(poolId);
      const refused = await api.kubernetesClusters
        .credentials(dev.root, { tenantId: dev.rootTenantId, clusterId, role: 'admin' })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'adopted' } });
      // Only the substrate's own subject holds access there.
      expect(
        profile.accessObjects(server).filter((object) => object.startsWith('ServiceAccount/') && !object.includes(substrateSubject)),
      ).toEqual([]);
    });

    it('pruning the pool leaves the cluster and its own node pool, and nothing of ours', async () => {
      await apply([], true);
      await until('the substrate to be deleted', async () => {
        await kick(poolId);
        return (await substrate(poolId))?.state === 'deleted';
      }, 90_000);
      expect(profile.clusters()).toContain(adopted);
      expect(profile.nodePools(adopted)).toEqual(ownPools);
      expect(profile.machines(adopted).sort()).toEqual(ownMachines);
      expect(kube.kinds(server)).toEqual([]);
      // Nor the substrate's own cluster-admin identity: no service account, binding or bc-access namespace stays.
      expect(profile.accessObjects(server)).toEqual([]);
      expect((await substrate(poolId))?.message ?? null).toBeNull();
      expect(await liveAllocations(poolId)).toEqual([]);
    }, 120_000);

    it('never wrote a provider secret or a minted token to a log line, a row, an event or an audit record', async () => {
      const tables = [
        'kubernetes_pool_substrates',
        'kubernetes_clusters',
        'kubernetes_node_pools',
        'kubernetes_substrate_nodes',
        'outbox',
        'audit_events',
      ];
      let stored = logs.join('\n');
      for (const table of tables) {
        const { rows } = await dev.database.query(`SELECT * FROM ${table}`);
        stored += JSON.stringify(rows);
      }
      // The check reads what it should: this run's events are there, and there are secrets to look for.
      expect(stored).toContain('kubernetes.substrate.');
      const secrets = [...profile.secrets(), ...kube.tokens];
      expect(secrets.length).toBeGreaterThan(0);
      for (const secret of secrets) expect(stored).not.toContain(secret);
    });
  });
}
