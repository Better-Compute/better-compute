import { ComputeError, type SqlTx } from '@better-compute/core';

// IPAM (§3.6, network ipam 'pool'): one IPv4 range per hosted pool; each instance holds at most
// one lease, taken when it is placed and returned when it is deleted. Concurrent allocations race on
// the (pool, address) primary key and retry, so no address is ever leased twice.

export interface IpPool {
  poolId: string;
  cidr: string;
  gateway: string;
  firstHost: string;
  lastHost: string;
  /** (v1.1) DNS servers handed to guests; empty: guests keep their image's. */
  dns: string[];
}

/**
 * Configures a pool's range; `first`/`last` default to the usable hosts after the gateway. The gateway
 * and `dns` reach each guest's network-config (InstanceNic.gateway, .nameservers).
 */
export async function setIpPool(
  tx: SqlTx,
  input: {
    poolId: string;
    cidr: string;
    gateway: string;
    firstHost?: string;
    lastHost?: string;
    dns?: string[];
  },
): Promise<IpPool> {
  try {
    const { rows } = await tx.query<{
      cidr: string;
      gateway: string;
      first_host: string;
      last_host: string;
      dns: string[];
    }>(
      `INSERT INTO ip_pools (pool_id, cidr, gateway, first_host, last_host, dns)
       SELECT $1, c, $3::inet,
              COALESCE($4::inet, host(set_masklen($3::inet, 32))::inet + 1),
              COALESCE($5::inet, host(broadcast(c))::inet - 1), $6::inet[]
         FROM (SELECT $2::cidr AS c) s
       ON CONFLICT (pool_id) DO UPDATE SET cidr = EXCLUDED.cidr, gateway = EXCLUDED.gateway,
         first_host = EXCLUDED.first_host, last_host = EXCLUDED.last_host, dns = EXCLUDED.dns
       RETURNING cidr::text, host(gateway) AS gateway, host(first_host) AS first_host,
                 host(last_host) AS last_host, ARRAY(SELECT host(d) FROM unnest(dns) d) AS dns`,
      [
        input.poolId,
        input.cidr,
        input.gateway,
        input.firstHost ?? null,
        input.lastHost ?? null,
        input.dns ?? [],
      ],
    );
    const row = rows[0]!;
    return {
      poolId: input.poolId,
      cidr: row.cidr,
      gateway: row.gateway,
      firstHost: row.first_host,
      lastHost: row.last_host,
      dns: [...(row.dns ?? [])],
    };
  } catch (error) {
    throw new ComputeError(
      'INVALID_INPUT',
      `Invalid IP range for pool ${input.poolId}: ${String((error as Error).message ?? error)}`,
    );
  }
}

/**
 * Leases the lowest free address of the pool's range to `instanceId` (idempotent: an instance that
 * holds a lease gets it back). `undefined` when the pool has no range; `CAPACITY_UNAVAILABLE` when
 * the range is exhausted.
 */
export async function leaseAddress(
  tx: SqlTx,
  poolId: string,
  instanceId: string,
): Promise<string | undefined> {
  const existing = await tx.query<{ address: string }>(
    `SELECT host(address) AS address FROM ip_leases WHERE instance_id = $1`,
    [instanceId],
  );
  if (existing.rows[0]) return existing.rows[0].address;
  const range = await tx.query(`SELECT 1 FROM ip_pools WHERE pool_id = $1`, [poolId]);
  if (range.rows.length === 0) return undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { rows } = await tx.query<{ address: string }>(
      `INSERT INTO ip_leases (pool_id, address, instance_id)
       SELECT $1, candidate, $2 FROM (
         SELECT p.first_host + step AS candidate
           FROM ip_pools p, generate_series(0, p.last_host - p.first_host) AS step
          WHERE p.pool_id = $1 AND p.first_host + step <> p.gateway
            AND NOT EXISTS (SELECT 1 FROM ip_leases l WHERE l.pool_id = $1 AND l.address = p.first_host + step)
          ORDER BY step LIMIT 1) free
       ON CONFLICT DO NOTHING RETURNING host(address) AS address`,
      [poolId, instanceId],
    );
    if (rows[0]) return rows[0].address;
    const full = await tx.query<{ free: string | number }>(
      `SELECT (p.last_host - p.first_host + 1) - (SELECT count(*) FROM ip_leases l WHERE l.pool_id = p.pool_id)
              - CASE WHEN p.gateway BETWEEN p.first_host AND p.last_host THEN 1 ELSE 0 END AS free
         FROM ip_pools p WHERE p.pool_id = $1`,
      [poolId],
    );
    if (Number(full.rows[0]?.free ?? 0) <= 0) break;
  }
  throw new ComputeError('CAPACITY_UNAVAILABLE', `Pool ${poolId} has no free IP address`);
}

/** Returns an instance's lease, if any. */
export async function releaseAddress(tx: SqlTx, instanceId: string): Promise<void> {
  await tx.query(`DELETE FROM ip_leases WHERE instance_id = $1`, [instanceId]);
}
