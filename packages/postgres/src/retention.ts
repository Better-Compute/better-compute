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
