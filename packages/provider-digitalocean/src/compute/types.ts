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
