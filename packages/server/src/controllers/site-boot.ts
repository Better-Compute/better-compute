import type { SqlTx } from '@better-compute/core';

// SiteBoot (PLAN.md §8.5 "Site routing"): the control-plane side of a site's boot lease. The lease
// `site:<id>:boot` (15 s TTL) names the one connected site agent that answers proxyDHCP and iPXE and
// vouches for discovery, with an epoch that grows on every change of holder. The holder publishes
// `site.boot = {active, epoch}` in its NodeSpec. An agent that loses its session self-fences after
// the TTL, and only then is a standby promoted. The lease never changes hands while it is live,
// so two agents can never both think they are active at the same epoch.

export const siteBootTtlSeconds = 15;

export const siteBootLeaseName = (siteId: string) => `site:${siteId}:boot`;

export interface SiteBootState {
  siteId: string;
  /** The site agent (node id) holding the lease, if any. */
  active?: string;
  epoch: number;
  expiresAt?: number;
  /** Whether this tick handed the lease to another agent (or to the first one). */
  changed: boolean;
  /** The agent that held it before a change. */
  previous?: string;
}

interface LeaseRow {
  owner: string | null;
  epoch: unknown;
  expires_at: Date;
  live: boolean;
}

/**
 * One SiteBoot tick for a site, in the caller's transaction: renews the lease while its holder is a
 * connected site agent. It promotes the first connected site agent (by id) once the lease has expired
 * or was never held. A holder that disconnected keeps its lease until it expires. Callers invalidate
 * the NodeSpec of `active` and `previous` when `changed`.
 */
export async function tickSiteBoot(
  tx: SqlTx,
  siteId: string,
  options: { ttlSeconds?: number } = {},
): Promise<SiteBootState> {
  const ttl = options.ttlSeconds ?? siteBootTtlSeconds;
  const name = siteBootLeaseName(siteId);
  await tx.query(
    `INSERT INTO leases (name, owner, epoch, expires_at) VALUES ($1, NULL, 0, compute_now())
     ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  const { rows: leases } = await tx.query<LeaseRow>(
    `SELECT owner, epoch, expires_at, expires_at > compute_now() AS live FROM leases WHERE name = $1 FOR UPDATE`,
    [name],
  );
  const lease = leases[0]!;
  const { rows: agents } = await tx.query<{ id: string }>(
    `SELECT n.id FROM nodes n
      WHERE n.site_id = $1 AND n.role = 'site' AND n.connectivity = 'connected' AND n.deleted_at IS NULL
        AND n.provision_state <> 'retired'
      ORDER BY n.id`,
    [siteId],
  );
  const connected = agents.map((agent) => agent.id);
  const state = (row: { owner: string | null; epoch: unknown; expires_at: Date }, changed: boolean) => {
    const result: SiteBootState = { siteId, epoch: Number(row.epoch), changed };
    if (row.owner !== null) {
      result.active = row.owner;
      result.expiresAt = row.expires_at.getTime();
    }
    if (changed && lease.owner !== null && lease.owner !== row.owner) result.previous = lease.owner;
    return result;
  };

  if (lease.owner !== null && lease.live) {
    // A live lease stays with its holder: renewed while connected, left to run out otherwise.
    if (!connected.includes(lease.owner)) return state(lease, false);
    const { rows } = await tx.query<LeaseRow>(
      `UPDATE leases SET expires_at = compute_now() + make_interval(secs => $2::int) WHERE name = $1
       RETURNING owner, epoch, expires_at, true AS live`,
      [name, ttl],
    );
    return state(rows[0]!, false);
  }
  // A holder that is still connected keeps its role after a missed renewal (under a new epoch: it
  // self-fenced when the lease ran out); otherwise the first standby is promoted.
  const next = lease.owner !== null && connected.includes(lease.owner) ? lease.owner : connected[0];
  if (next === undefined) {
    if (lease.owner === null) return state(lease, false);
    // The holder is gone and no one can take over: the lease is released and the epoch moves on.
    const { rows } = await tx.query<LeaseRow>(
      `UPDATE leases SET owner = NULL, epoch = epoch + 1 WHERE name = $1
       RETURNING owner, epoch, expires_at, false AS live`,
      [name],
    );
    return state(rows[0]!, true);
  }
  const { rows } = await tx.query<LeaseRow>(
    `UPDATE leases SET owner = $2, epoch = epoch + 1, expires_at = compute_now() + make_interval(secs => $3::int)
      WHERE name = $1 RETURNING owner, epoch, expires_at, true AS live`,
    [name, next, ttl],
  );
  return state(rows[0]!, true);
}
