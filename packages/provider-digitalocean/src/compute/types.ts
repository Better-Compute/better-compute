// The members of DigitalOcean API v2 resources that this provider reads.

/** An `action` (`GET /actions/{id}`): the asynchronous part of most Droplet and network calls. */
export interface DoAction {
  id: number;
  status: 'in-progress' | 'completed' | 'errored';
  type: string;
  started_at?: string;
  completed_at?: string | null;
  resource_id?: number;
  resource_type?: string;
  region_slug?: string | null;
}

/** A size (`GET /sizes`): a Droplet plan, GPU plans included. */
export interface DoSize {
  slug: string;
  /** MiB. */
  memory: number;
  vcpus: number;
  /** GiB. */
  disk: number;
  price_hourly: number;
  price_monthly?: number;
  /** The slugs of the regions that offer this size. */
  regions: string[];
  available: boolean;
  description?: string;
  gpu_info?: { count: number; model: string; vram?: { amount: number; unit: string } };
}

/** A region (`GET /regions`). `sizes` lists what it can create right now. */
export interface DoRegion {
  slug: string;
  name: string;
  available: boolean;
  sizes: string[];
  features?: string[];
}
