import { SHARD_COUNT, type Clock, type Lease, type SqlExecutor } from '@better-compute/core';
import { leaseNames, type TableLeases } from './leases.js';

// Shard ownership (PLAN.md §8.1, §8.5). Every worker heartbeats its `workers` row; rendezvous
// hashing over the live rows names one desired owner per shard, and each worker holds the
// `shard:<n>` leases it is the desired owner of (in v0.1 one worker usually holds all 256). A
// shard moves only when its holder lets go on its next membership pass and the new owner takes it,
// or when the holder's lease expires; the epoch fences whatever the old holder still has in flight.

const heartbeat = `INSERT INTO workers (id, started_at, heartbeat_at) VALUES ($1, compute_now(), compute_now())
  ON CONFLICT (id) DO UPDATE SET heartbeat_at = compute_now()`;

const liveWorkers = `SELECT id FROM workers
  WHERE heartbeat_at > compute_now() - make_interval(secs => $1::float8) ORDER BY id`;

/** Rows of workers gone for a long time; their shards were taken over long before. */
const forgetWorkers = `DELETE FROM workers
  WHERE heartbeat_at < compute_now() - make_interval(secs => $1::float8) AND id <> $2`;

const leaveWorkers = 'DELETE FROM workers WHERE id = $1';

/** FNV-1a (32-bit) over UTF-16 code units, then murmur3's finalizer so nearby inputs spread. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The rendezvous (highest random weight) owner of `shard` among `workers`; ties go to the lower id. */
export function shardOwner(workers: readonly string[], shard: number): string | undefined {
  let best: string | undefined;
  let bestWeight = -1;
  for (const worker of workers) {
    const weight = hash32(`${worker}#${shard}`);
    if (weight > bestWeight || (weight === bestWeight && best !== undefined && worker < best)) {
      best = worker;
      bestWeight = weight;
    }
  }
  return best;
}

/** The shards `me` should own when `workers` (which should include `me`) are the live workers. */
export function assignShards(workers: readonly string[], me: string): number[] {
  const live = [...new Set([...workers, me])];
  const owned: number[] = [];
  for (let shard = 0; shard < SHARD_COUNT; shard++)
    if (shardOwner(live, shard) === me) owned.push(shard);
  return owned;
}

export interface MembershipSettings {
  workerId: string;
  shardLeaseTtlMs: number;
  renewMs: number;
  /** A worker is live while its heartbeat is younger than this. */
  liveWorkerMs: number;
}

export interface Membership {
  /** Heartbeats, recomputes the desired shards and renews or takes their leases when due. */
  ensure(): Promise<ReadonlyMap<number, Lease>>;
  /** Forces a membership pass now. */
  sync(): Promise<ReadonlyMap<number, Lease>>;
  /** Shards held as of the last pass (leases valid until their `expiresAt`). */
  owned(): ReadonlyMap<number, Lease>;
  /** Releases every shard lease and removes the worker row. */
  leave(): Promise<void>;
}

export function createMembership(
  database: SqlExecutor,
  leases: TableLeases,
  clock: Clock,
  settings: MembershipSettings,
): Membership {
  const { workerId: me } = settings;
  let owned = new Map<number, Lease>();
  let nextSyncAt = -Infinity;
  let syncing: Promise<ReadonlyMap<number, Lease>> | undefined;
  /** Whether this process has a `workers` row to remove on leave(). */
  let joined = false;

  async function pass(): Promise<ReadonlyMap<number, Lease>> {
    joined = true;
    await database.query(heartbeat, [me]);
    await database.query(forgetWorkers, [(settings.liveWorkerMs * 20) / 1000, me]);
    const live = (
      await database.query<{ id: string }>(liveWorkers, [settings.liveWorkerMs / 1000])
    ).rows.map((row) => row.id);
    const desired = new Set(assignShards(live, me));
    const letGo = [...owned.keys()].filter((shard) => !desired.has(shard));
    if (letGo.length) await leases.releaseMany(letGo.map(leaseNames.shard), me);
    const held = await leases.acquireMany(
      [...desired].sort((a, b) => a - b).map(leaseNames.shard),
      me,
      settings.shardLeaseTtlMs,
    );
    const next = new Map<number, Lease>();
    for (const lease of held.values()) next.set(Number(lease.name.slice('shard:'.length)), lease);
    owned = next;
    nextSyncAt = clock.now() + settings.renewMs;
    return owned;
  }

  const sync = () =>
    (syncing ??= pass().finally(() => {
      syncing = undefined;
    }));

  return {
    async ensure() {
      const now = clock.now();
      // Renew on schedule, or earlier if a lease would lapse before the next pass.
      const lapsing = [...owned.values()].some(
        (lease) => lease.expiresAt - now < settings.shardLeaseTtlMs / 3,
      );
      if (now < nextSyncAt && !lapsing) return owned;
      return sync();
    },
    sync,
    owned: () => owned,
    async leave() {
      await syncing?.catch(() => undefined);
      const shards = [...owned.keys()];
      owned = new Map();
      nextSyncAt = -Infinity;
      if (!joined) return;
      joined = false;
      if (shards.length) await leases.releaseMany(shards.map(leaseNames.shard), me);
      await database.query(leaveWorkers, [me]);
    },
  };
}

/** A `singleton:<job>` lease one process holds at a time, renewed when a third of its TTL is left. */
export interface SingletonLease {
  readonly name: string;
  ensure(): Promise<Lease | undefined>;
  current(): Lease | undefined;
  release(): Promise<void>;
}

export function createSingletonLease(
  leases: TableLeases,
  clock: Clock,
  job: string,
  owner: string,
  ttlMs: number,
): SingletonLease {
  const name = leaseNames.singleton(job);
  let lease: Lease | undefined;
  return {
    name,
    async ensure() {
      if (lease && lease.expiresAt - clock.now() > ttlMs / 3) return lease;
      lease = await leases.acquire(name, owner, ttlMs);
      return lease;
    },
    current: () => (lease && lease.expiresAt > clock.now() ? lease : undefined),
    async release() {
      if (!lease) return;
      lease = undefined;
      await leases.release(name, owner);
    },
  };
}
