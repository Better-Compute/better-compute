import type { KubernetesClusterSpec, KubernetesNodePoolSpec } from '@better-compute/core';

// The kubernetes module's views and inputs: what `kubernetesClusters.*` and `kubernetesNodePools.*` take and return.

/**
 * Where a cluster is: `pending` (recorded, nothing asked of the provider yet), `provisioning` (the provider is
 * creating it), `ready` (the control plane and every node pool are ready), `updating` (a change is converging),
 * `deleting`, `deleted`, `error` (with `message`; retried on the next change and by the periodic refresh).
 */
export type KubernetesClusterState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'deleting'
  | 'deleted'
  | 'error';

export type KubernetesNodePoolState =
  | 'pending'
  | 'ready'
  | 'updating'
  | 'deleting'
  | 'deleted'
  | 'error';

export type KubernetesMode = KubernetesClusterSpec['mode'];
export type KubernetesReleaseChannel = KubernetesClusterSpec['releaseChannel'];
export type KubernetesRole = 'view' | 'edit' | 'admin';
export type KubernetesTaint = NonNullable<KubernetesNodePoolSpec['taints']>[number];

export interface KubernetesNodePoolView {
  id: string;
  clusterId: string;
  /** Unique among the cluster's node pools that are not deleted; also the provider-side name. */
  name: string;
  machineType: string;
  /** Nodes per zone; with `autoscaling`, the initial count. */
  nodeCount: number;
  autoscaling?: { minNodes: number; maxNodes: number };
  diskGiB?: number;
  diskType?: string;
  spot: boolean;
  accelerators?: { type: string; count: number };
  zones: string[];
  labels: Record<string, string>;
  taints: KubernetesTaint[];
  state: KubernetesNodePoolState;
  message?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface KubernetesClusterView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  /** The tenant network (vps `networks`) the nodes use, and the subnet of it in the cluster's region. */
  networkId?: string;
  subnetId?: string;
  name: string;
  description?: string;
  mode: KubernetesMode;
  /** A region (regional cluster) or a zone (zonal cluster) of the provider account. */
  location: string;
  /** The region of `location`. */
  region: string;
  releaseChannel: KubernetesReleaseChannel;
  /** The control-plane version asked for (`1.33` or a full version); absent: the channel's default. */
  requestedVersion?: string;
  /** CIDRs that may reach the control-plane endpoint; empty: any address (still authenticated). */
  authorizedNetworks: string[];
  privateNodes: boolean;
  /** The provider-side cluster name (`bc-k-…`). */
  providerName: string;
  state: KubernetesClusterState;
  message?: string;
  /** `https://…` of the control plane, once the provider reported it. */
  endpoint?: string;
  /** The control-plane and node versions the provider last reported. */
  kubernetesVersion?: string;
  nodeVersion?: string;
  /** `standard` clusters: the node pools that are not deleted. Always empty for `autopilot`. */
  nodePools: KubernetesNodePoolView[];
  /** Bumped by every change through the API. */
  version: number;
  createdAt: number;
  /** When the cluster was first `ready`. */
  readyAt?: number;
  deletedAt?: number;
}

/** A node pool as `kubernetesClusters.create` (`nodePools`) and `kubernetesNodePools.create` take it. */
export interface NodePoolInput {
  name: string;
  machineType: string;
  nodeCount: number;
  autoscaling?: { minNodes: number; maxNodes: number };
  diskGiB?: number;
  diskType?: string;
  spot?: boolean;
  accelerators?: { type: string; count: number };
  zones?: string[];
  labels?: Record<string, string>;
  taints?: KubernetesTaint[];
}

export interface CreateClusterInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  name: string;
  mode: KubernetesMode;
  location: string;
  releaseChannel: KubernetesReleaseChannel;
  version?: string;
  networkId?: string;
  authorizedNetworks: string[];
  privateNodes: boolean;
  description?: string;
  /** `standard`: 1 to 10. `autopilot`: none. */
  nodePools: NodePoolInput[];
  idempotencyKey: string;
}

export type ClusterRef = { tenantId: string; clusterId: string };

export interface ListClustersInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}

export interface UpdateClusterInput extends ClusterRef {
  version?: string;
  releaseChannel?: KubernetesReleaseChannel;
  authorizedNetworks?: string[];
  description?: string;
}

export interface CredentialsInput extends ClusterRef {
  role: KubernetesRole;
  ttlSeconds?: number;
}

/** A short-lived kubeconfig for the caller; the module never stores the token. */
export interface KubernetesKubeconfig {
  /** kubeconfig YAML: one cluster, one user with a bearer token, one context, `current-context` set. */
  kubeconfig: string;
  /** Epoch ms after which the token no longer authenticates. */
  expiresAt: number;
  role: KubernetesRole;
}

export interface VersionsInput {
  tenantId: string;
  poolId: string;
  location: string;
}

export interface CreateNodePoolInput extends ClusterRef, NodePoolInput {
  idempotencyKey?: string;
}

export interface NodePoolRef extends ClusterRef {
  nodePoolId: string;
}

export interface UpdateNodePoolInput extends NodePoolRef {
  nodeCount?: number;
  /** `null` turns autoscaling off. */
  autoscaling?: { minNodes: number; maxNodes: number } | null;
}
