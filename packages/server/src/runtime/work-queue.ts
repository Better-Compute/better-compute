import { ComputeError, shardOf, type SqlTx, type WorkQueue } from '@better-compute/core';

// The coalescing work queue (PLAN.md §8.4). Enqueue runs in the state-change transaction: a key
// already queued gets `gen + 1` and the earlier `not_before` (`enqueueMany`: the same for a batch,
// in one INSERT … SELECT FROM unnest, equal to the single enqueues). Claims take ready rows of owned
// shards with FOR UPDATE SKIP LOCKED and stamp `claimed_until`; completion deletes the row only at the
// claimed `gen`, so a key re-dirtied while its reconciler ran survives and no wake-up is lost.
// `shard` is `shardOf(key)` for every kind, so node-keyed work lands on the node's own shard.
//
// A claim also parks `not_before` at 'infinity' until the run ends, so an enqueue made during the
// run keeps its own time: a plain re-dirty is due at once, and a reconciler that re-enqueues its own
// key with `notBefore` ("look again at T") is due at T, not at once. A claim that expires (its worker
// died) is claimable again whatever `not_before` says.

const kindPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const maxKeyLength = 512;

const enqueueWork = `INSERT INTO work_queue (kind, key, shard, gen, not_before)
  VALUES ($1, $2, $3, 1, COALESCE($4::timestamptz, compute_now()))
  ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1,
    not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)`;

/**
 * Set-based enqueue. ON CONFLICT cannot touch a row twice in one statement, so each distinct key
 * comes once with how many times the call named it (`n`): inserted at `gen = n`, or bumped by `n`,
 * exactly what `n` single enqueues would leave.
 */
const enqueueMany = `INSERT INTO work_queue (kind, key, shard, gen, not_before)
  SELECT $1, k.key, k.shard, k.n, COALESCE($5::timestamptz, compute_now())
    FROM unnest($2::text[], $3::smallint[], $4::bigint[]) AS k(key, shard, n)
  ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + EXCLUDED.gen,
    not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)`;

const seedWork = `INSERT INTO work_queue (kind, key, shard, gen, not_before)
  SELECT $1, k.key, k.shard, 1, compute_now() FROM unnest($2::text[], $3::smallint[]) AS k(key, shard)
  ON CONFLICT (kind, key) DO NOTHING`;

/** Ready: due and unclaimed, or claimed by a worker whose claim ran out. */
const ready = `((claimed_until IS NULL AND not_before <= compute_now()) OR claimed_until < compute_now())`;

const claimSharded = `WITH picked AS (
    SELECT kind, key, not_before FROM work_queue
     WHERE kind = $1 AND shard = ANY($2::smallint[]) AND ${ready}
     ORDER BY not_before, key LIMIT $3
     FOR UPDATE SKIP LOCKED)
  UPDATE work_queue w SET claimed_until = compute_now() + make_interval(secs => $4::float8),
    not_before = 'infinity'
    FROM picked WHERE w.kind = picked.kind AND w.key = picked.key
  RETURNING w.key, w.gen, w.shard, picked.not_before`;

const claimAll = `WITH picked AS (
    SELECT kind, key, not_before FROM work_queue
     WHERE kind = $1 AND ${ready}
     ORDER BY not_before, key LIMIT $2
     FOR UPDATE SKIP LOCKED)
  UPDATE work_queue w SET claimed_until = compute_now() + make_interval(secs => $3::float8),
    not_before = 'infinity'
    FROM picked WHERE w.kind = picked.kind AND w.key = picked.key
  RETURNING w.key, w.gen, w.shard, picked.not_before`;

/** DONE: gone at the claimed gen; re-dirtied meanwhile: unclaimed, due as the enqueue left it. */
const completeWork = `WITH done AS (
    DELETE FROM work_queue WHERE kind = $1 AND key = $2 AND gen = $3 RETURNING key)
  UPDATE work_queue SET claimed_until = NULL WHERE kind = $1 AND key = $2 AND gen <> $3`;

/**
 * Unclaims a key and defers it by `$4` seconds: SYNC_AGAIN and periodic keys only at the claimed
 * gen (a re-dirtied key stays due now), failures always (`$5`).
 */
const deferWork = `UPDATE work_queue SET claimed_until = NULL,
    not_before = CASE WHEN gen = $3 OR $5::boolean
      THEN compute_now() + make_interval(secs => $4::float8) ELSE not_before END
  WHERE kind = $1 AND key = $2`;

/**
 * Settles many claims of one kind in one statement: each row is completeWork (`delay` NULL) or
 * deferWork (`delay` seconds, `always`), exactly as those would leave it. The UPDATE reads the
 * snapshot before the DELETE, so it must skip the rows the DELETE removes.
 */
const settleWork = `WITH v AS (
    SELECT * FROM unnest($2::text[], $3::bigint[], $4::float8[], $5::boolean[]) AS v(key, gen, delay, always)),
  done AS (
    DELETE FROM work_queue w USING v
     WHERE w.kind = $1 AND w.key = v.key AND v.delay IS NULL AND w.gen = v.gen RETURNING w.key)
  UPDATE work_queue w SET claimed_until = NULL,
    not_before = CASE WHEN v.delay IS NOT NULL AND (w.gen = v.gen OR v.always)
      THEN compute_now() + make_interval(secs => v.delay) ELSE w.not_before END
    FROM v WHERE w.kind = $1 AND w.key = v.key AND NOT (v.delay IS NULL AND w.gen = v.gen)`;

/** One claimed row. */
export interface ClaimedWork {
  key: string;
  gen: number;
  shard: number;
  notBefore: number;
}

function checkKind(kind: unknown): asserts kind is string {
  if (typeof kind !== 'string' || !kindPattern.test(kind))
    throw new ComputeError('INVALID_INPUT', `Invalid work kind ${JSON.stringify(kind)}`);
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > maxKeyLength)
    throw new ComputeError('INVALID_INPUT', 'A work key is a non-empty string');
}

/** Whether `name` can be a work kind (and so a reconciler name). */
export const isWorkKind = (name: unknown): name is string =>
  typeof name === 'string' && kindPattern.test(name);

/** `options.notBefore` as a timestamp parameter (`null`: due now). */
function notBeforeParam(options: { notBefore?: number } | undefined): Date | null {
  const notBefore = options?.notBefore;
  if (notBefore === undefined) return null;
  if (typeof notBefore !== 'number' || !Number.isFinite(notBefore))
    throw new ComputeError('INVALID_INPUT', 'notBefore is epoch milliseconds');
  return new Date(notBefore);
}

/**
 * One statement for many keys of one kind. Repeated keys are counted, not repeated; distinct keys
 * go in sorted order so concurrent batches over overlapping keys lock rows in the same order.
 */
async function enqueueCounted(
  tx: SqlTx,
  kind: string,
  keys: readonly string[],
  notBefore: Date | null,
): Promise<void> {
  if (!keys.length) return;
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const distinct = [...counts.keys()].sort();
  await tx.query(enqueueMany, [
    kind,
    distinct,
    distinct.map(shardOf),
    distinct.map((key) => counts.get(key)!),
    notBefore,
  ]);
}

/** `ctx.work`: enqueue in the caller's transaction. */
export const workQueue: WorkQueue = Object.freeze({
  async enqueue(tx: SqlTx, kind: string, key: string, options: { notBefore?: number } = {}) {
    checkKind(kind);
    checkKey(key);
    await tx.query(enqueueWork, [kind, key, shardOf(key), notBeforeParam(options)]);
  },
  /**
   * The set-based enqueue: one statement for the whole batch, leaving exactly the rows the same
   * `enqueue` calls one by one would (a key named `n` times is inserted at `gen = n` or bumped by
   * `n`; `not_before` is the earlier one). Every key is checked before anything is written.
   */
  async enqueueMany(
    tx: SqlTx,
    kind: string,
    keys: readonly string[],
    options: { notBefore?: number } = {},
  ) {
    checkKind(kind);
    if (!Array.isArray(keys))
      throw new ComputeError('INVALID_INPUT', 'enqueueMany() takes an array of keys');
    for (const key of keys) checkKey(key);
    await enqueueCounted(tx, kind, keys, notBeforeParam(options));
  },
});

/** Enqueues many keys of one kind, due now (the level-trigger resync). */
export async function enqueueKeys(tx: SqlTx, kind: string, keys: readonly string[]): Promise<void> {
  await enqueueCounted(tx, kind, keys, null);
}

/** Inserts keys that are not queued yet, due now (periodic keys on first sight). */
export async function seedKeys(tx: SqlTx, kind: string, keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  await tx.query(seedWork, [kind, keys, keys.map(shardOf)]);
}

/** Claims up to `limit` ready keys of `kind`, in `shards` (all shards when undefined). */
export async function claimWork(
  tx: SqlTx,
  kind: string,
  shards: readonly number[] | undefined,
  limit: number,
  claimTtlMs: number,
): Promise<ClaimedWork[]> {
  if (shards && !shards.length) return [];
  const { rows } = await tx.query<{
    key: string;
    gen: number | bigint;
    shard: number;
    not_before: Date | string | number;
  }>(
    shards ? claimSharded : claimAll,
    shards ? [kind, shards, limit, claimTtlMs / 1000] : [kind, limit, claimTtlMs / 1000],
  );
  // A reclaimed row whose claim ran out still reads 'infinity': it sorts last.
  const time = (value: Date | string | number) => {
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };
  return rows
    .map((row) => ({
      key: row.key,
      gen: Number(row.gen),
      shard: Number(row.shard),
      notBefore: time(row.not_before),
    }))
    .sort((a, b) => a.notBefore - b.notBefore || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function completeClaim(tx: SqlTx, kind: string, item: ClaimedWork): Promise<void> {
  await tx.query(completeWork, [kind, item.key, item.gen]);
}

/**
 * Unclaims `item` and makes it due `delayMs` from now. `always` also defers a key re-dirtied while
 * it ran (failure back-off); otherwise only the claimed generation is deferred.
 */
export async function deferClaim(
  tx: SqlTx,
  kind: string,
  item: ClaimedWork,
  delayMs: number,
  always: boolean,
): Promise<void> {
  await tx.query(deferWork, [kind, item.key, item.gen, Math.max(0, delayMs) / 1000, always]);
}

/** How a finished claim ends: completed (`delayMs` null) or deferred like `deferClaim`. */
export interface Settlement {
  item: ClaimedWork;
  delayMs: number | null;
  always: boolean;
}

/**
 * `completeClaim`/`deferClaim` for many claims of one kind in one statement. A key named twice
 * keeps its last settlement (a claim is settled once; this only guards the statement).
 */
export async function settleClaims(tx: SqlTx, kind: string, settlements: readonly Settlement[]): Promise<void> {
  if (!settlements.length) return;
  const last = new Map<string, Settlement>();
  for (const settlement of settlements) last.set(settlement.item.key, settlement);
  const rows = [...last.values()].sort((a, b) => (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0));
  await tx.query(settleWork, [
    kind,
    rows.map((row) => row.item.key),
    rows.map((row) => row.item.gen),
    rows.map((row) => (row.delayMs === null ? null : Math.max(0, row.delayMs) / 1000)),
    rows.map((row) => row.always),
  ]);
}
