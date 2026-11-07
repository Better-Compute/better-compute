// The members of the DigitalOcean Kubernetes (DOKS) resources of API v2 that the driver reads.

/** `status.state` of a cluster. */
export type DoksClusterState =
  | 'running'
  | 'provisioning'
  | 'degraded'
  | 'error'
  | 'deleted'
  | 'upgrading'
  | 'deleting'
  | 'invalid';

export interface DoksNode {
  id: string;
  name?: string;
  status?: { state?: 'provisioning' | 'running' | 'draining' | 'deleting' | string };
  droplet_id?: string;
  created_at?: string;
}

export interface DoksTaint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

export interface DoksNodePool {
  id: string;
  name: string;
  size: string;
  count: number;
  tags?: string[];
  labels?: Record<string, string> | null;
  taints?: DoksTaint[] | null;
  auto_scale?: boolean;
  min_nodes?: number;
  max_nodes?: number;
  nodes?: DoksNode[];
  /** Spot capacity: not in DO's published spec yet (Spot GPU is a preview); unverified. */
  spot?: boolean;
}

/** A device plugin or exporter DOKS can install on a cluster. */
export interface DoksPluginSwitch {
  enabled?: boolean;
}

export interface DoksCluster {
  id: string;
  name: string;
  region: string;
  /** The version slug (`1.33.5-do.1`). */
  version: string;
  vpc_uuid?: string;
  /** `https://<uuid>.k8s.ondigitalocean.com`, empty until the control plane runs. */
  endpoint?: string;
  ipv4?: string;
  tags?: string[];
  node_pools?: DoksNodePool[];
  auto_upgrade?: boolean;
  surge_upgrade?: boolean;
  ha?: boolean;
  status?: { state?: DoksClusterState; message?: string };
  created_at?: string;
  control_plane_firewall?: { enabled?: boolean; allowed_addresses?: string[] };
  nvidia_gpu_device_plugin?: DoksPluginSwitch;
  amd_gpu_device_plugin?: DoksPluginSwitch;
  amd_gpu_device_metrics_exporter_plugin?: DoksPluginSwitch;
}

/** A version of `GET /kubernetes/options` or of a cluster's `/upgrades`. */
export interface DoksVersion {
  slug: string;
  kubernetes_version: string;
  supported_features?: string[];
}

export interface DoksOptions {
  regions?: { name?: string; slug: string }[];
  versions?: DoksVersion[];
  sizes?: { name?: string; slug: string }[];
}

/** `GET /kubernetes/clusters/{id}/credentials`: a short-lived cluster-admin credential. */
export interface DoksCredentials {
  server?: string;
  certificate_authority_data?: string;
  client_certificate_data?: string | null;
  client_key_data?: string | null;
  token?: string | null;
  expires_at?: string;
}

/** `GET /kubernetes/clusters/{id}/destroy_with_associated_resources`. */
export interface DoksAssociatedResources {
  load_balancers?: { id: string; name?: string }[];
  volumes?: { id: string; name?: string }[];
  volume_snapshots?: { id: string; name?: string }[];
}
