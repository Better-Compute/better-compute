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
    CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost', 'kubernetes', 'volume',
                           'address', 'loadBalancer')) NOT VALID;
`,
};

export const kubernetesMigrations: readonly Migration[] = Object.freeze([
  kubernetesClustersMigration,
]);
