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
