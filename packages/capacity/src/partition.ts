import { ComputeError, type SqlTx, type TimeRange } from '@better-compute/core';
import { gpuAtomFamily } from '@better-compute/inventory';

// The atom rule for partition changes (PLAN.md §10.4 point 2, §10.6): a MIG mode or layout change,
// or a time-slice/MPS slot change, books EVERY atom of the GPU, parent included, for the change
// window. A flat EXCLUDE cannot see parent/child overlap; booking the whole family makes the change
// commit only when nothing of the GPU is booked, and keeps anything new off it until it is released.

/** Bookings of a partition window use this allocation-id prefix (no `allocations` row). */
export const partitionBookingPrefix = 'partition:';

export type PartitionBooking =
  | { status: 'booked'; bookingId: string; atoms: string[] }
  /** Something of the GPU is booked in the window; the whole family is free from `freeFrom`. */
  | { status: 'conflict'; freeFrom: number };

const iso = (ms: number) => new Date(ms).toISOString();
let savepoints = 0;

/**
 * Books a GPU's whole atom family (inventory's `gpuAtomFamily`) for `during`, all-or-nothing. The
 * family's device rows are locked first, so health writes and concurrent changes serialize with it.
 * Throws `NOT_FOUND` for an unknown GPU and `INVALID_INPUT` for an empty window.
 */
export async function bookPartitionChange(
  tx: SqlTx,
  input: { gpuId: string; during: TimeRange },
): Promise<PartitionBooking> {
  if (!(input.during.end > input.during.start))
    throw new ComputeError('INVALID_INPUT', 'during must be a non-empty interval');
  const atoms = await gpuAtomFamily(tx, input.gpuId);
  if (atoms.length === 0) throw new ComputeError('NOT_FOUND', `GPU ${input.gpuId} not found`);
  await tx.query(`SELECT id FROM devices WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [
    atoms,
  ]);
  const bookingId = `${partitionBookingPrefix}${input.gpuId}:${input.during.start}`;
  const savepoint = `capacity_partition_${++savepoints}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  const { rows } = await tx.query<{ device_id: string }>(
    `INSERT INTO device_bookings (device_id, allocation_id, during)
     SELECT unnest($1::text[]), $2, tstzrange($3::timestamptz, $4::timestamptz)
     ON CONFLICT DO NOTHING RETURNING device_id`,
    [atoms, bookingId, iso(input.during.start), iso(input.during.end)],
  );
  if (rows.length === atoms.length) {
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { status: 'booked', bookingId, atoms };
  }
  await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  const blocking = await tx.query<{ free_ms: number | null }>(
    `SELECT (extract(epoch FROM max(upper(during))) * 1000)::float8 AS free_ms FROM device_bookings
      WHERE device_id = ANY($1::text[]) AND during && tstzrange($2::timestamptz, $3::timestamptz)`,
    [atoms, iso(input.during.start), iso(input.during.end)],
  );
  return { status: 'conflict', freeFrom: Number(blocking.rows[0]?.free_ms ?? input.during.end) };
}

/** Ends a partition window: its bookings are deleted. Answers how many there were (0: already gone). */
export async function releasePartitionChange(tx: SqlTx, bookingId: string): Promise<number> {
  if (!bookingId.startsWith(partitionBookingPrefix))
    throw new ComputeError('INVALID_INPUT', 'Not a partition booking');
  const { rowCount } = await tx.query(`DELETE FROM device_bookings WHERE allocation_id = $1`, [
    bookingId,
  ]);
  return rowCount;
}
