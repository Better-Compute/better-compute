import {
  ComputeError,
  type Lease,
  type LeaseProvider,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import type { ClockMonitor } from './clock.js';

// Table leases with fencing epochs (PLAN.md §8.5): `shard:<n>`, `pool:<id>`, `site:<id>:boot`,
// `singleton:<job>`, `gateway:<id>`. A missing row is inserted unowned and expired; acquiring takes
// it when it is ours or expired, bumping the epoch on every change of owner. The fence is the first
// statement of a fenced transaction: `FOR SHARE` on the lease row, so a takeover waits for the
// zombie's transaction to end (a bare EXISTS is no fence under READ COMMITTED).

const namePattern = /^[A-Za-z0-9._:@/-]{1,200}$/;
const maxTtlMs = 86_400_000;

const ensureLeases = `INSERT INTO leases (name, owner, epoch, expires_at)
  SELECT name, NULL, 0, '-infinity' FROM unnest($1::text[]) AS name
  ON CONFLICT (name) DO NOTHING RETURNING name`;

const acquireLeases = `UPDATE leases SET owner = $2,
    epoch = CASE WHEN owner = $2 THEN epoch ELSE epoch + 1 END,
    expires_at = compute_now() + make_interval(secs => $3::float8)
  WHERE name = ANY($1::text[]) AND (owner = $2 OR expires_at < compute_now())
  RETURNING name, epoch, expires_at, compute_now() AS now`;

const releaseLeases = `UPDATE leases SET owner = NULL, expires_at = '-infinity'
  WHERE name = ANY($1::text[]) AND owner = $2`;

const fenceLease = `SELECT 1 AS held FROM leases
  WHERE name = $1 AND owner = $2 AND epoch = $3 AND expires_at > compute_now() FOR SHARE`;

/** The lease provider plus the bulk operations the worker runtime uses for its 256 shard leases. */
export interface TableLeases extends LeaseProvider {
  /** Acquires or renews every name it can; returns the leases now held, by name. */
  acquireMany(names: readonly string[], owner: string, ttlMs: number): Promise<Map<string, Lease>>;
  releaseMany(names: readonly string[], owner: string): Promise<void>;
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !namePattern.test(name))
    throw new ComputeError('INVALID_INPUT', `Invalid lease name ${JSON.stringify(name)}`);
}

function checkOwner(owner: unknown): asserts owner is string {
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > 200)
    throw new ComputeError('INVALID_INPUT', 'A lease owner is a non-empty string');
}

function checkTtl(ttlMs: unknown): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTtlMs)
    throw new ComputeError(
      'INVALID_INPUT',
      'A lease TTL is a whole number of milliseconds up to a day',
    );
}

export function createLeases(database: SqlExecutor, monitor: ClockMonitor): TableLeases {
  /** One acquire/renew pass over `names`; every reading of `compute_now()` feeds the clock monitor. */
  async function update(
    names: readonly string[],
    owner: string,
    ttlMs: number,
    held: Map<string, Lease>,
  ) {
    const sentAt = monitor.local();
    const { rows } = await database.query<{
      name: string;
      epoch: number | bigint;
      expires_at: Date;
      now: Date;
    }>(acquireLeases, [names, owner, ttlMs / 1000]);
    const receivedAt = monitor.local();
    for (const row of rows)
      held.set(row.name, {
        name: row.name,
        owner,
        epoch: Number(row.epoch),
        expiresAt: row.expires_at.getTime(),
      });
    const now = rows[0]?.now;
    if (now instanceof Date) monitor.observe(now.getTime(), sentAt, receivedAt);
  }

  async function acquireMany(
    names: readonly string[],
    owner: string,
    ttlMs: number,
  ): Promise<Map<string, Lease>> {
    for (const name of names) checkName(name);
    checkOwner(owner);
    checkTtl(ttlMs);
    const unique = [...new Set(names)];
    const held = new Map<string, Lease>();
    if (!unique.length) return held;
    // Renewals of held leases are one statement; names without a row are inserted unowned and
    // expired, then taken like any expired lease (so the first holder gets epoch 1).
    await update(unique, owner, ttlMs, held);
    const missing = unique.filter((name) => !held.has(name));
    if (missing.length) {
      const inserted = await database.query<{ name: string }>(ensureLeases, [missing]);
      if (inserted.rowCount)
        await update(
          inserted.rows.map((row) => row.name),
          owner,
          ttlMs,
          held,
        );
    }
    return held;
  }

  async function releaseMany(names: readonly string[], owner: string): Promise<void> {
    for (const name of names) checkName(name);
    checkOwner(owner);
    if (names.length) await database.query(releaseLeases, [[...new Set(names)], owner]);
  }

  return {
    acquireMany,
    releaseMany,
    async acquire(name, owner, ttlMs) {
      checkName(name);
      return (await acquireMany([name], owner, ttlMs)).get(name);
    },
    async release(name, owner) {
      await releaseMany([name], owner);
    },
    async fence(tx: SqlTx, lease) {
      if (!lease || typeof lease !== 'object')
        throw new ComputeError('INVALID_INPUT', 'fence() takes the lease to check');
      checkName(lease.name);
      const { rowCount } = await tx.query(fenceLease, [lease.name, lease.owner, lease.epoch]);
      if (!rowCount)
        throw new ComputeError('CONFLICT', `Lease ${lease.name} is no longer held`, undefined, {
          lease: lease.name,
          epoch: lease.epoch,
        });
    },
  };
}

/** Lease names (§8.5). */
export const leaseNames = {
  shard: (shard: number) => `shard:${shard}`,
  pool: (poolId: string) => `pool:${poolId}`,
  siteBoot: (siteId: string) => `site:${siteId}:boot`,
  singleton: (job: string) => `singleton:${job}`,
  gateway: (gatewayId: string) => `gateway:${gatewayId}`,
} as const;
