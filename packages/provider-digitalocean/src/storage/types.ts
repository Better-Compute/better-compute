// The members of DigitalOcean Block Storage resources that this provider reads.

/** A Block Storage volume (`GET /volumes/{id}`). DO has no status: a volume that exists is usable. */
export interface DoVolume {
  id: string;
  name: string;
  region: { slug: string; name?: string };
  /** The Droplets it is attached to: at most one for a Block Storage volume. */
  droplet_ids: number[];
  size_gigabytes: number;
  created_at: string;
  description?: string;
  /** `ext4`, `xfs`, or empty when unformatted. */
  filesystem_type?: string;
  filesystem_label?: string;
  tags?: string[] | null;
}

/** A snapshot (`GET /snapshots/{id}`, `GET /volumes/{id}/snapshots`). */
export interface DoSnapshot {
  id: string;
  name: string;
  created_at: string;
  regions: string[];
  /** The volume (or Droplet) it was taken of. */
  resource_id: string;
  resource_type: 'volume' | 'droplet';
  /** The smallest volume it restores to, in GiB. */
  min_disk_size: number;
  /** What it bills for, in GiB (0 until DO has measured it). */
  size_gigabytes: number;
  tags?: string[] | null;
}

// Network File Storage (P6). The shapes are unverified (tests/fixtures/digitalocean/nfs.json says
// why): no field is trusted beyond what the provider checks.

/** An NFS share (`GET /nfs/{id}?region=`). Shares carry no tags. */
export interface DoShare {
  id: string;
  name: string;
  size_gib: number;
  /** A region slug. */
  region: string;
  status: 'CREATING' | 'ACTIVE' | 'FAILED' | 'DELETED' | string;
  created_at: string;
  /** The VPCs the share is reachable from. */
  vpc_ids?: string[] | null;
  /** The private address the guest mounts from (once `ACTIVE`). */
  host?: string;
  /** The export path on `host` (once `ACTIVE`). */
  mount_path?: string;
}

/** An NFS share snapshot (`GET /nfs/snapshots/{id}?region=`). */
export interface DoShareSnapshot {
  id: string;
  name: string;
  size_gib: number;
  region: string;
  status: 'UNKNOWN' | 'CREATING' | 'ACTIVE' | 'FAILED' | 'DELETED' | string;
  created_at: string;
  share_id: string;
}

/** A share action (`POST /nfs/{id}/actions`); it carries no id of its own. */
export interface DoShareAction {
  status: 'in-progress' | 'completed' | 'errored' | string;
  type: string;
  started_at?: string;
  completed_at?: string | null;
  resource_id?: string;
}
