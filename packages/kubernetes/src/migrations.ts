import type { Migration } from '@better-compute/core';

/**
 * Managed Kubernetes clusters and their node pools. The API records what the tenant wants (`desired_state`), the
 * `kubernetes.clusters` reconciler converges the provider and writes back `state`. A cluster references the vps
 * tables it lives on (pool, provider account, tenant network) by id only, without foreign keys: vps owns those
 * rows and their deletion rules.
 *
 * `usage_windows` gains the `kubernetes` source kind (`kubernetes.cluster.hours`, see usage.ts): the CHECK of
 * core/0029 is replaced by the same list plus `kubernetes`, `NOT VALID` as there, so no partition is scanned.
 */
export const kubernetesClustersMigration: Migration = {
  name: 'kubernetes/0001_clusters',
  sql: `
CREATE TABLE kubernetes_clusters (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL,
  provider_account_id text NOT NULL,
  -- A vps tenant network the nodes use, and its subnet in the cluster's region.
  network_id text,
  subnet_id text,
  name text NOT NULL,
  description text,
  mode text NOT NULL CHECK (mode IN ('standard', 'autopilot')),
  location text NOT NULL,
  region text NOT NULL,
  release_channel text NOT NULL CHECK (release_channel IN ('rapid', 'regular', 'stable', 'extended')),
  requested_version text,
  authorized_networks jsonb NOT NULL DEFAULT '[]',
  private_nodes bool NOT NULL DEFAULT false,
  -- The provider-side name (bc-k-...), and the id ensureCluster answered (null until the provider was asked).
  provider_name text NOT NULL,
  provider_id text,
  state text NOT NULL
    CHECK (state IN ('pending', 'provisioning', 'ready', 'updating', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  endpoint text,
  kubernetes_version text,
  node_version text,
  -- The caller identity: idempotency keys are scoped to (tenant, caller), as the id derives from them.
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  -- The provider first accepted the cluster: it exists provider-side (and bills) from here.
  provisioned_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  -- How far kubernetes.usage has written kubernetes.cluster.hours windows.
  metered_until timestamptz,
  UNIQUE (tenant_id, created_by, idempotency_key)
);
-- A deleted cluster's name is free again.
CREATE UNIQUE INDEX kubernetes_clusters_name ON kubernetes_clusters (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX kubernetes_clusters_tenant ON kubernetes_clusters (tenant_id, created_at) WHERE state <> 'deleted';
-- The reconciler's 30 s sweep: clusters still converging (or being deleted).
CREATE INDEX kubernetes_clusters_converging ON kubernetes_clusters (id)
  WHERE state IN ('pending', 'provisioning', 'updating', 'deleting')
     OR (desired_state = 'deleted' AND state <> 'deleted');
-- The 5 min refresh: settled clusters, ready or in error.
CREATE INDEX kubernetes_clusters_settled ON kubernetes_clusters (id) WHERE state IN ('ready', 'error');
-- What kubernetes.usage scans: clusters that bill, or billed until a deletion it has not covered yet.
CREATE INDEX kubernetes_clusters_unmetered ON kubernetes_clusters ((coalesce(metered_until, provisioned_at)))
  WHERE provisioned_at IS NOT NULL
    AND (deleted_at IS NULL OR metered_until IS DISTINCT FROM deleted_at);

CREATE TABLE kubernetes_node_pools (
  id text PRIMARY KEY,
  cluster_id text NOT NULL REFERENCES kubernetes_clusters,
  tenant_id text NOT NULL,
  name text NOT NULL,
  machine_type text NOT NULL,
  node_count integer NOT NULL CHECK (node_count >= 0),
  autoscaling_min integer,
  autoscaling_max integer,
  disk_gib integer,
  disk_type text,
  spot bool NOT NULL DEFAULT false,
  accelerator_type text,
  accelerator_count integer,
  zones jsonb NOT NULL DEFAULT '[]',
  labels jsonb NOT NULL DEFAULT '{}',
  taints jsonb NOT NULL DEFAULT '[]',
  -- Created with the cluster (KubernetesClusterSpec.initialNodePools), not by ensureNodePool.
  initial bool NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'updating', 'deleting', 'deleted', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  created_by text,
  idempotency_key text,
  request_hash bytea,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  version bigint NOT NULL,
  CHECK ((autoscaling_min IS NULL) = (autoscaling_max IS NULL))
);
CREATE UNIQUE INDEX kubernetes_node_pools_name ON kubernetes_node_pools (cluster_id, name) WHERE state <> 'deleted';
CREATE INDEX kubernetes_node_pools_cluster ON kubernetes_node_pools (cluster_id) WHERE state <> 'deleted';

ALTER TABLE usage_windows DROP CONSTRAINT IF EXISTS usage_windows_source_kind_ck;
ALTER TABLE usage_windows
  ADD CONSTRAINT usage_windows_source_kind_ck
    CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost', 'kubernetes')) NOT VALID;
`,
};

/**
 * Pool substrates (`policy.substrate`): a pool whose machines are the nodes of a managed cluster. The
 * `kubernetes.substrates` reconciler records here what it made of the pool's policy; the cluster and its node pools
 * are ordinary `kubernetes_clusters` / `kubernetes_node_pools` rows marked with `substrate_pool_id`, so the cluster
 * reconciler, the events, metering and `kubernetesClusters.update` (upgrades) apply to them.
 *
 * - `kubernetes_clusters.adopted`: a cluster that existed before (`cluster: { adopt }`). The cluster reconciler reads
 *   it (`getCluster`) and never creates, changes or deletes it; only its substrate node pools are converged.
 * - `kubernetes_pool_substrates`: one row per pool that ever had a substrate. `identity` is the canonical account and
 *   cluster the row was made for (immutable, K-D8); `create_spec` the create-time settings last pushed to the cluster
 *   row (so a `kubernetesClusters.update` made meanwhile is not reverted); `join_token_id` the live hosted token, if
 *   any (never the secret); `manifests_sha256` what was last applied (without the token). No credential is stored.
 */
export const kubernetesSubstratesMigration: Migration = {
  name: 'kubernetes/0002_substrates',
  sql: `
ALTER TABLE kubernetes_clusters ADD COLUMN adopted bool NOT NULL DEFAULT false;
ALTER TABLE kubernetes_clusters ADD COLUMN substrate_pool_id text;
ALTER TABLE kubernetes_node_pools ADD COLUMN substrate_pool_id text;
CREATE INDEX kubernetes_node_pools_substrate ON kubernetes_node_pools (substrate_pool_id)
  WHERE substrate_pool_id IS NOT NULL AND state <> 'deleted';

CREATE TABLE kubernetes_pool_substrates (
  pool_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  provider_account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('create', 'adopt')),
  -- The provider id of the adopted cluster (mode adopt).
  adopt_id text,
  identity text NOT NULL,
  -- pools.version this row last converged from: a pools.update wakes the substrate at the next sweep.
  pool_version bigint,
  -- The kubernetes_clusters row (created, or the adopted cluster's row).
  cluster_id text,
  create_spec jsonb,
  state text NOT NULL
    CHECK (state IN ('pending', 'provisioning', 'ready', 'updating', 'error', 'deleting', 'deleted')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted')),
  message text,
  join_token_id text,
  -- The live token's Secret reached the cluster (a token minted in a run whose apply failed is replaced).
  token_applied bool NOT NULL DEFAULT false,
  manifests_sha256 text,
  applied_at timestamptz,
  -- Nodes of the substrate's node pools the cluster last listed, and of them the ones whose bcd joined the pool.
  nodes_listed integer,
  nodes_joined integer,
  -- upgrades: 'drain': the version being drained for, and since when (the pool's nodes are NoSchedule
  -- substrate-upgrade until the cluster is ready on it).
  upgrade_version text,
  upgrade_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  deleted_at timestamptz,
  version bigint NOT NULL
);
-- One live substrate per cluster.
CREATE UNIQUE INDEX kubernetes_pool_substrates_cluster ON kubernetes_pool_substrates (cluster_id)
  WHERE state <> 'deleted' AND cluster_id IS NOT NULL;
CREATE INDEX kubernetes_pool_substrates_live ON kubernetes_pool_substrates (pool_id) WHERE state <> 'deleted';
`,
};

/**
 * Which Kubernetes Node each substrate pool node runs on. A pool node is matched once, while its bcd is connected, by
 * the Node name bcd reports (inventory `kubernetes.nodeName`, else `os.hostname`) when it is exactly a listed Node's;
 * `kubernetes_node` stays NULL for one that matched no Node (never taken for gone: fail closed). `kubernetes_uid` is
 * the Node's `metadata.uid`, so a later Node of the same name (EKS reuses IP-based names) is not taken for it.
 * `learned_at` is when the match was made or last tried, `checked_at` when the node was last checked for a gone Node
 * (the oldest are checked first). A retired node's row is deleted.
 */
export const kubernetesSubstrateNodesMigration: Migration = {
  name: 'kubernetes/0003_substrate_nodes',
  sql: `
CREATE TABLE kubernetes_substrate_nodes (
  node_id text PRIMARY KEY,
  pool_id text NOT NULL,
  kubernetes_node text,
  kubernetes_uid text,
  learned_at timestamptz NOT NULL DEFAULT compute_now(),
  checked_at timestamptz
);
CREATE INDEX kubernetes_substrate_nodes_pool ON kubernetes_substrate_nodes (pool_id);
`,
};

export const kubernetesMigrations: readonly Migration[] = Object.freeze([
  kubernetesClustersMigration,
  kubernetesSubstratesMigration,
  kubernetesSubstrateNodesMigration,
]);
