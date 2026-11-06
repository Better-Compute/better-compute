import { createHash } from 'node:crypto';
import type { FleetConfig, FleetKubernetesCluster, FleetKubernetesNodePool } from './config.js';
import { canonical, type FleetCall, type FleetChange } from './plan.js';
import type { FleetState, FleetStateCluster, FleetStateNodePool } from './state.js';

// FleetConfig for Kubernetes (D25, `@better-compute/kubernetes`): managed clusters and their node
// pools, and the provider account a pool substrate (`policy.substrate`) names. Fleet does not depend
// on the kubernetes module: it reads its tables (state.ts) and plans calls to its methods.

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sameSet = (a: readonly string[], b: readonly string[]) =>
  same([...new Set(a)].sort(), [...new Set(b)].sort());

/**
 * The idempotency key of a create that may happen again under the same name once the first object
 * is deleted: `incarnation` counts the objects of that name there ever were, so a re-created cluster
 * never replays (or conflicts with) the deleted one. At most 128 characters (hashed when longer).
 */
export function fleetCreateKey(
  tenantId: string,
  kind: 'kubernetesCluster' | 'kubernetesNodePool',
  name: string,
  incarnation: number,
): string {
  const key = `fleet:${tenantId}:${kind}:${name}:${incarnation}`;
  if (key.length <= 128) return key;
  const digest = createHash('sha256').update(`${tenantId}\n${kind}\n${name}`).digest('hex');
  return `fleet:${digest}:${incarnation}`;
}

// --- Pool substrates -----------------------------------------------------------------------------

type Policy = Record<string, unknown>;

const substrateOf = (policy: Policy | undefined): Record<string, unknown> | undefined => {
  const substrate = policy?.substrate;
  return typeof substrate === 'object' && substrate !== null && !Array.isArray(substrate)
    ? (substrate as Record<string, unknown>)
    : undefined;
};

/**
 * A pool policy whose `substrate.account` names a provider account of the document, with that
 * name replaced by the account's id; `unknown` when it names neither a known account nor an id.
 */
export function resolveSubstrateAccount(
  policy: Policy | undefined,
  accountIds: ReadonlyMap<string, string>,
): { policy: Policy | undefined; unknown?: string } {
  const substrate = substrateOf(policy);
  const account = substrate?.account;
  if (typeof account !== 'string') return { policy };
  const id = accountIds.get(account);
  if (id !== undefined) return { policy: { ...policy, substrate: { ...substrate, account: id } } };
  if (account.startsWith('pacct_')) return { policy };
  return { policy, unknown: account };
}

/** The provider account a (resolved) policy's substrate runs on, if any. */
export const substrateAccount = (policy: Policy | undefined): string | undefined => {
  const account = substrateOf(policy)?.account;
  return typeof account === 'string' ? account : undefined;
};

/**
 * What a substrate is, as opposed to how it is sized (the kubernetes module's `substrateIdentity`):
 * the account, and the cluster (created where, with private nodes and on which network; or adopted,
 * by id). A change of it is never converged in place (K-D8).
 */
export function substrateIdentity(policy: Policy | undefined): string | undefined {
  const substrate = substrateOf(policy);
  if (!substrate) return undefined;
  const cluster = (substrate.cluster ?? {}) as Record<string, unknown>;
  if (cluster.adopt !== undefined)
    return canonical({ account: substrate.account, mode: 'adopt', adopt: cluster.adopt });
  const create = (cluster.create ?? {}) as Record<string, unknown>;
  return canonical({
    account: substrate.account,
    mode: 'create',
    location: create.location,
    privateNodes: create.privateNodes === true,
    networkId: create.networkId ?? null,
  });
}

// --- Clusters and node pools ---------------------------------------------------------------------

/** The calls of the Kubernetes part of a plan, by where they run in the call list. */
export interface KubernetesCalls {
  /** `kubernetesClusters/create`, `kubernetesClusters/update`, `kubernetesNodePools/create|update`. */
  writes: FleetCall[];
  /** `kubernetesNodePools/delete` then `kubernetesClusters/delete` (prune): before pools are archived. */
  deletes: FleetCall[];
}

/** A document node pool as `kubernetesClusters.create` and `kubernetesNodePools.create` take it. */
function apiNodePool(pool: FleetKubernetesNodePool): Record<string, unknown> {
  return {
    name: pool.name,
    machineType: pool.machineType,
    nodeCount: pool.nodeCount,
    ...(pool.autoscaling !== undefined ? { autoscaling: pool.autoscaling } : {}),
    ...(pool.diskGiB !== undefined ? { diskGiB: pool.diskGiB } : {}),
    ...(pool.diskType !== undefined ? { diskType: pool.diskType } : {}),
    ...(pool.spot ? { spot: true } : {}),
    ...(pool.accelerators !== undefined ? { accelerators: pool.accelerators } : {}),
    ...(pool.zones !== undefined ? { zones: pool.zones } : {}),
    ...(pool.labels !== undefined ? { labels: pool.labels } : {}),
    ...(pool.taints !== undefined ? { taints: pool.taints } : {}),
  };
}

const taintsOf = (taints: FleetKubernetesNodePool['taints']) =>
  (taints ?? []).map((taint) => canonical(taint)).sort();

/** The fields of a live node pool that differ from the document, split by whether they can change. */
function nodePoolDiff(current: FleetStateNodePool, wanted: FleetKubernetesNodePool) {
  const immutable: string[] = [];
  if (current.machineType !== wanted.machineType) immutable.push('machineType');
  // Server- or provider-filled fields are compared only when the document names them.
  if (wanted.diskGiB !== undefined && current.diskGiB !== wanted.diskGiB) immutable.push('diskGiB');
  if (wanted.diskType !== undefined && current.diskType !== wanted.diskType)
    immutable.push('diskType');
  if (wanted.zones !== undefined && !sameSet(current.zones ?? [], wanted.zones))
    immutable.push('zones');
  if ((current.spot ?? false) !== (wanted.spot ?? false)) immutable.push('spot');
  if (!same(current.accelerators ?? null, wanted.accelerators ?? null))
    immutable.push('accelerators');
  if (!same(current.labels ?? {}, wanted.labels ?? {})) immutable.push('labels');
  if (!same(taintsOf(current.taints), taintsOf(wanted.taints))) immutable.push('taints');
  const update: Record<string, unknown> = {};
  if (current.nodeCount !== wanted.nodeCount) update.nodeCount = wanted.nodeCount;
  if (!same(current.autoscaling ?? null, wanted.autoscaling ?? null))
    update.autoscaling = wanted.autoscaling ?? null;
  return { immutable, update };
}

/** The fields of a live cluster that differ from the document, split by whether they can change. */
function clusterDiff(current: FleetStateCluster, wanted: FleetKubernetesCluster, poolId: string) {
  const immutable: string[] = [];
  if (current.poolId !== poolId) immutable.push('pool');
  if (current.mode !== (wanted.mode ?? 'standard')) immutable.push('mode');
  if (current.location !== wanted.location) immutable.push('location');
  if (current.privateNodes !== (wanted.privateNodes ?? false)) immutable.push('privateNodes');
  if (wanted.networkId !== undefined && current.networkId !== wanted.networkId)
    immutable.push('networkId');
  if (wanted.projectId !== undefined && current.projectId !== wanted.projectId)
    immutable.push('projectId');
  const update: Record<string, unknown> = {};
  const releaseChannel = wanted.releaseChannel ?? 'regular';
  if (current.releaseChannel !== releaseChannel) update.releaseChannel = releaseChannel;
  // Without a version the channel picks one, and the provider moves it: never compared.
  if (wanted.version !== undefined && current.version !== wanted.version)
    update.version = wanted.version;
  if (!sameSet(current.authorizedNetworks, wanted.authorizedNetworks ?? []))
    update.authorizedNetworks = wanted.authorizedNetworks ?? [];
  if (wanted.description !== undefined && current.description !== wanted.description)
    update.description = wanted.description;
  return { immutable, update };
}

/**
 * Plans the document's `kubernetesClusters` against the state: creates (with their node pools),
 * in-place updates, node pools added, resized or (with `prune`) deleted, and clusters deleted (with
 * `prune`). `poolIds` maps the document's pool names to ids; `createdPools` are the pools this same
 * plan creates: a cluster on one waits for the next apply (`deferred`), since the kubernetes module
 * admits a cluster only on a pool that exists.
 */
export function planKubernetes(
  desired: FleetConfig,
  state: FleetState,
  options: {
    prune: boolean;
    poolIds: ReadonlyMap<string, string>;
    createdPools: ReadonlySet<string>;
    add(change: FleetChange): void;
  },
): KubernetesCalls {
  const { add } = options;
  const tenantId = state.tenantId;
  const writes: FleetCall[] = [];
  const nodePoolDeletes: FleetCall[] = [];
  const clusterDeletes: FleetCall[] = [];
  const missing = state.missing.includes('kubernetes_clusters');
  const wanted = new Set<string>();

  for (const cluster of desired.kubernetesClusters ?? []) {
    wanted.add(cluster.name);
    const current = state.kubernetesClusters.find((item) => item.name === cluster.name);
    const action = current ? 'update' : 'create';
    const block = (blocked: string, fields?: string[]) =>
      add({
        kind: 'kubernetesCluster',
        name: cluster.name,
        action,
        ...(fields ? { fields } : {}),
        blocked,
      });
    if (missing) {
      block('this deployment does not run the kubernetes module');
      continue;
    }
    // A pool of this document by name, or an offered pool by id.
    const poolId =
      options.poolIds.get(cluster.pool) ??
      (cluster.pool.startsWith('pool_') ? cluster.pool : undefined);
    if (!poolId) {
      block(`unknown pool ${cluster.pool}`);
      continue;
    }
    const substrate = state.substrateClusters.find((item) => item.name === cluster.name);
    if (substrate) {
      block(`the name is taken by the substrate cluster of pool ${substrate.poolId}`);
      continue;
    }
    if (!current) {
      if (options.createdPools.has(cluster.pool)) {
        add({
          kind: 'kubernetesCluster',
          name: cluster.name,
          action: 'create',
          deferred: true,
          note: `waits for pool ${cluster.pool}, which this plan creates: apply again once it exists`,
        });
        continue;
      }
      add({ kind: 'kubernetesCluster', name: cluster.name, action: 'create' });
      for (const pool of cluster.nodePools ?? [])
        add({ kind: 'kubernetesNodePool', name: `${cluster.name}/${pool.name}`, action: 'create' });
      writes.push({
        path: 'kubernetesClusters/create',
        input: {
          tenantId,
          poolId,
          name: cluster.name,
          mode: cluster.mode ?? 'standard',
          location: cluster.location,
          ...(cluster.releaseChannel !== undefined
            ? { releaseChannel: cluster.releaseChannel }
            : {}),
          ...(cluster.version !== undefined ? { version: cluster.version } : {}),
          ...(cluster.networkId !== undefined ? { networkId: cluster.networkId } : {}),
          ...(cluster.projectId !== undefined ? { projectId: cluster.projectId } : {}),
          ...(cluster.authorizedNetworks !== undefined
            ? { authorizedNetworks: cluster.authorizedNetworks }
            : {}),
          ...(cluster.privateNodes ? { privateNodes: true } : {}),
          ...(cluster.description !== undefined ? { description: cluster.description } : {}),
          ...(cluster.nodePools !== undefined
            ? { nodePools: cluster.nodePools.map(apiNodePool) }
            : {}),
          idempotencyKey: fleetCreateKey(
            tenantId,
            'kubernetesCluster',
            cluster.name,
            state.clusterIncarnations[cluster.name] ?? 0,
          ),
        },
      });
      continue;
    }
    if (current.deleting) {
      block('the cluster is being deleted: apply again once it is gone, to create it anew');
      continue;
    }
    const { immutable, update } = clusterDiff(current, cluster, poolId);
    const mutable = Object.keys(update);
    if (immutable.length)
      block(`${immutable.join(', ')} cannot change; create a cluster under another name`, [
        ...immutable,
        ...mutable,
      ]);
    else if (mutable.length) {
      add({ kind: 'kubernetesCluster', name: cluster.name, action: 'update', fields: mutable });
      writes.push({
        path: 'kubernetesClusters/update',
        input: { tenantId, clusterId: current.id, ...update },
      });
    } else add({ kind: 'kubernetesCluster', name: cluster.name, action: 'unchanged' });
    // A blocked cluster's node pools wait for it (apply refuses a blocked plan anyway).
    if (immutable.length) continue;

    const wantedPools = new Set<string>();
    for (const pool of cluster.nodePools ?? []) {
      wantedPools.add(pool.name);
      const name = `${cluster.name}/${pool.name}`;
      const live = current.nodePools.find((item) => item.name === pool.name);
      if (!live) {
        add({ kind: 'kubernetesNodePool', name, action: 'create' });
        writes.push({
          path: 'kubernetesNodePools/create',
          input: {
            tenantId,
            clusterId: current.id,
            ...apiNodePool(pool),
            idempotencyKey: fleetCreateKey(
              tenantId,
              'kubernetesNodePool',
              pool.name,
              current.nodePoolIncarnations[pool.name] ?? 0,
            ),
          },
        });
        continue;
      }
      if (live.deleting) {
        add({
          kind: 'kubernetesNodePool',
          name,
          action: 'update',
          blocked: 'the node pool is being deleted: apply again once it is gone, to create it anew',
        });
        continue;
      }
      const diff = nodePoolDiff(live, pool);
      const fields = Object.keys(diff.update);
      if (diff.immutable.length)
        add({
          kind: 'kubernetesNodePool',
          name,
          action: 'update',
          fields: [...diff.immutable, ...fields],
          blocked: `${diff.immutable.join(', ')} cannot change; add a node pool under another name`,
        });
      else if (fields.length) {
        add({ kind: 'kubernetesNodePool', name, action: 'update', fields });
        writes.push({
          path: 'kubernetesNodePools/update',
          input: { tenantId, clusterId: current.id, nodePoolId: live.id, ...diff.update },
        });
      } else add({ kind: 'kubernetesNodePool', name, action: 'unchanged' });
    }
    if (options.prune)
      for (const live of current.nodePools)
        if (!wantedPools.has(live.name) && !live.deleting) {
          add({
            kind: 'kubernetesNodePool',
            name: `${cluster.name}/${live.name}`,
            action: 'delete',
            note: 'its nodes are drained and deleted at the provider',
          });
          nodePoolDeletes.push({
            path: 'kubernetesNodePools/delete',
            input: { tenantId, clusterId: current.id, nodePoolId: live.id },
          });
        }
  }

  if (options.prune && !missing)
    for (const cluster of state.kubernetesClusters)
      if (!wanted.has(cluster.name) && !cluster.deleting) {
        add({
          kind: 'kubernetesCluster',
          name: cluster.name,
          action: 'delete',
          note: 'deleted at the provider with its node pools and everything running on it',
        });
        clusterDeletes.push({
          path: 'kubernetesClusters/delete',
          input: { tenantId, clusterId: cluster.id },
        });
      }

  return { writes, deletes: [...nodePoolDeletes, ...clusterDeletes] };
}
