import { ComputeError, type SqlTx } from '@better-compute/core';

// Retention for the cursor-read logs (PLAN.md §8.4): `outbox` and `authz_changes` rows are
// deleted only once every durable cursor of their stream (`outbox_cursors`) has passed them and
// they are older than a minimum age. A stream without cursors is never pruned: a reader that has
// not saved a cursor yet could still need everything.

export type CursorStream = 'outbox' | 'authz_changes';

/** Saves a reader's position (`txid` as text, as readers alias it: `txid_text`). */
export async function saveCursor(
  tx: SqlTx,
  cursor: { name: string; stream?: CursorStream; txid: string; seq: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_cursors (name, stream, txid, seq) VALUES ($1, $2, $3::xid8, $4)
     ON CONFLICT (name) DO UPDATE SET txid = EXCLUDED.txid, seq = EXCLUDED.seq, stream = EXCLUDED.stream,
       updated_at = compute_now()`,
    [cursor.name, cursor.stream ?? 'outbox', cursor.txid, cursor.seq],
  );
}

/** A reader's saved position, or undefined before its first save. */
export async function loadCursor(tx: SqlTx, name: string): Promise<{ txid: string; seq: number } | undefined> {
  const { rows } = await tx.query<{ txid_text: string; seq: number }>(
    'SELECT txid::text AS txid_text, seq FROM outbox_cursors WHERE name = $1',
    [name],
  );
  return rows[0] ? { txid: rows[0].txid_text, seq: Number(rows[0].seq) } : undefined;
}

export interface PruneOptions {
  /** Keep rows younger than this (default one hour). */
  minAgeSeconds?: number;
  /** Rows deleted per statement, so one pass never holds long locks (default 5,000). */
  batch?: number;
}

/**
 * Deletes up to `batch` rows of one stream that every cursor of that stream has passed and that
 * are older than `minAgeSeconds`. Returns how many went; run it until it returns less than `batch`.
 */
export async function pruneBehindCursors(tx: SqlTx, stream: CursorStream, options: PruneOptions = {}): Promise<number> {
  if (stream !== 'outbox' && stream !== 'authz_changes') throw new ComputeError('INVALID_INPUT', `Unknown stream ${String(stream)}`);
  const minAge = options.minAgeSeconds ?? 3600;
  const batch = options.batch ?? 5000;
  if (!(minAge >= 0) || !Number.isSafeInteger(batch) || batch < 1) throw new ComputeError('INVALID_INPUT', 'minAgeSeconds and batch must be positive');
  const table = stream; // a checked literal, never input
  const result = await tx.query(
    `WITH floor AS (
       SELECT txid, seq FROM outbox_cursors WHERE stream = $1 ORDER BY txid, seq LIMIT 1
     ), doomed AS (
       SELECT t.seq FROM ${table} t, floor f
        WHERE (t.txid, t.seq) <= (f.txid, f.seq)
          AND t.created_at < compute_now() - make_interval(secs => $2)
        ORDER BY t.txid, t.seq LIMIT $3
     )
     DELETE FROM ${table} WHERE seq IN (SELECT seq FROM doomed)`,
    [stream, minAge, batch],
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes up to `batch` `authz_changes` rows older than `olderThanSeconds` (default one day) while the
 * stream has no durable cursor. Its readers are the IAM projection tails, which live in memory and
 * reload the whole projection on start (sqlProjectionSource.load), so only a live tail more than a day
 * behind could miss a pruned row. Once any reader saves an `authz_changes` cursor, only
 * `pruneBehindCursors` prunes the stream.
 */
export async function pruneUncursoredAuthzChanges(tx: SqlTx, options: { olderThanSeconds?: number; batch?: number } = {}): Promise<number> {
  const olderThan = options.olderThanSeconds ?? 86_400;
  const batch = options.batch ?? 5000;
  if (!(olderThan >= 3600) || !Number.isSafeInteger(batch) || batch < 1)
    throw new ComputeError('INVALID_INPUT', 'olderThanSeconds must be at least 3600 and batch positive');
  const result = await tx.query(
    `DELETE FROM authz_changes WHERE seq IN (
       SELECT t.seq FROM authz_changes t
        WHERE NOT EXISTS (SELECT 1 FROM outbox_cursors WHERE stream = 'authz_changes')
          AND t.created_at < compute_now() - make_interval(secs => $1)
          AND t.txid < pg_snapshot_xmin(pg_current_snapshot())
        ORDER BY t.txid, t.seq LIMIT $2)`,
    [olderThan, batch],
  );
  return result.rowCount ?? 0;
}

/** Command states that never change again (PLAN.md §7.4). */
export const settledCommandStates = Object.freeze(['succeeded', 'failed', 'rejected', 'expired', 'cancelled'] as const);

/**
 * Deletes up to `batch` settled commands last updated more than `olderThanDays` ago (default 30;
 * at least 1), by the `commands_settled` index (core/0020). Their idempotency keys become free again,
 * so keep the window longer than any caller retries a key: workflow, reservation and instance keys
 * name objects that finished long before.
 */
export async function pruneSettledCommands(tx: SqlTx, options: { olderThanDays?: number; batch?: number } = {}): Promise<number> {
  const olderThan = options.olderThanDays ?? 30;
  const batch = options.batch ?? 5000;
  if (!(olderThan >= 1) || !Number.isFinite(olderThan) || !Number.isSafeInteger(batch) || batch < 1)
    throw new ComputeError('INVALID_INPUT', 'olderThanDays must be at least 1 and batch positive');
  // The state list is a literal, so the planner can match the partial index.
  const result = await tx.query(
    `DELETE FROM commands WHERE id IN (
       SELECT id FROM commands
        WHERE state IN (${settledCommandStates.map((state) => `'${state}'`).join(', ')})
          AND updated_at < compute_now() - $1::float8 * interval '1 day'
        ORDER BY updated_at LIMIT $2)`,
    [olderThan, batch],
  );
  return result.rowCount ?? 0;
}

/**
 * Marks pending and approved join requests past their expiry as expired (at most `batch`; core/0010),
 * and returns how many. Reads already show them as expired; this frees the one-pending-per-machine
 * index for a new request.
 */
export async function expireJoinRequests(tx: SqlTx, options: { batch?: number } = {}): Promise<number> {
  const batch = options.batch ?? 1000;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new ComputeError('INVALID_INPUT', 'batch must be positive');
  const { rowCount } = await tx.query(
    `UPDATE join_requests SET state = 'expired', version = version + 1
      WHERE id IN (SELECT id FROM join_requests
                    WHERE state IN ('pending', 'approved') AND expires_at <= compute_now()
                    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [batch],
  );
  return rowCount ?? 0;
}

/**
 * Deletes up to `batch` `attestation_uses` rows whose `expires_at` passed (core/0011): evidence that
 * can no longer be presented needs no replay guard. Rows without an expiry stay. Returns how many went.
 */
export async function pruneAttestationUses(tx: SqlTx, options: { batch?: number } = {}): Promise<number> {
  const batch = options.batch ?? 5000;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new ComputeError('INVALID_INPUT', 'batch must be positive');
  const result = await tx.query(
    `DELETE FROM attestation_uses WHERE (attestor, subject) IN (
       SELECT attestor, subject FROM attestation_uses
        WHERE expires_at IS NOT NULL AND expires_at <= compute_now()
        ORDER BY expires_at LIMIT $1)`,
    [batch],
  );
  return result.rowCount ?? 0;
}
