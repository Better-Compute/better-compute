import { ComputeError, type SqlTx } from '@better-compute/core';
import { simClockFunction, systemClockFunction } from './migrations/0001_clock.js';

// The database side of the one clock (P9): compute_now() reads either the server clock or
// compute_sim_clock. Every function here takes an executor or a transaction of a migrated store.

function checkTime(ms: number, name: string): void {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `${name} must be a non-negative integer number of milliseconds`,
    );
}

/**
 * Points `compute_now()` at `compute_sim_clock` and sets that clock to `startMs`, so leases,
 * `not_before`, `not_after` and liveness expire in simulated time. For tests and the simulator;
 * the setting is database-wide and outlives the connection, so undo it with `restoreSystemClock`.
 */
export async function useSimClock(sql: SqlTx, startMs: number): Promise<void> {
  checkTime(startMs, 'startMs');
  await sql.query(
    `INSERT INTO compute_sim_clock (id, ts) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts`,
    [new Date(startMs)],
  );
  await sql.query(simClockFunction);
}

/** Moves the sim clock to `ms`. Time never moves backwards: an earlier `ms` is `INVALID_INPUT`. */
export async function setSimClock(sql: SqlTx, ms: number): Promise<void> {
  checkTime(ms, 'ms');
  const moved = await sql.query(
    'UPDATE compute_sim_clock SET ts = $1 WHERE id = 1 AND ts <= $1 RETURNING ts',
    [new Date(ms)],
  );
  if (moved.rowCount > 0) return;
  const current = await sql.query<{ ts: Date }>('SELECT ts FROM compute_sim_clock WHERE id = 1');
  const ts = current.rows[0]?.ts;
  if (!ts)
    throw new ComputeError('INVALID_STATE', 'The sim clock is not set; call useSimClock first');
  throw new ComputeError(
    'INVALID_INPUT',
    `The sim clock never moves backwards (it is at ${ts.toISOString()})`,
  );
}

/** Points `compute_now()` back at the database server's clock. */
export async function restoreSystemClock(sql: SqlTx): Promise<void> {
  await sql.query(systemClockFunction);
}

/**
 * Which clock `compute_now()` reads: `system` in production, `sim` under `useSimClock`, `custom`
 * for any other body, and `missing` before migration. `doctor` flags anything but `system`.
 */
export async function computeNowMode(sql: SqlTx): Promise<'system' | 'sim' | 'custom' | 'missing'> {
  // The function a bare compute_now() call resolves to on this search_path.
  const { rows } = await sql.query<{ body: string }>(
    "SELECT prosrc AS body FROM pg_proc WHERE oid = to_regprocedure('compute_now()')",
  );
  const body = rows[0]?.body;
  if (body === undefined) return 'missing';
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const bodyOf = (definition: string) => normalize(definition.split('$$')[1] ?? '');
  if (normalize(body) === bodyOf(systemClockFunction)) return 'system';
  if (normalize(body) === bodyOf(simClockFunction)) return 'sim';
  return 'custom';
}
