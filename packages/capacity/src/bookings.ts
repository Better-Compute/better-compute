import { ComputeError, type Allocation, type SqlTx, type TimeRange } from '@better-compute/core';
import { applyRollupDelta, rollupResource } from './rollup.js';

// Allocation lifecycle after placement (PLAN.md §10.5): release truncates `during` at
// compute_now(), extend raises `upper(during)` and lets the EXCLUDE constraint decide.

interface RawAllocation {
  id: string;
  tenant_id: string;
  pool_id: string;
  node_id: string;
  owner_kind: 'reservation' | 'instance' | 'volume';
  owner_id: string;
  atoms: string[];
  resources: Record<string, number> | string;
  start_ms: number;
  end_ms: number;
  released: boolean;
}

const allocationColumns = `id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, resources,
  (extract(epoch FROM lower(during)) * 1000)::float8 AS start_ms,
  (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms,
  released_at IS NOT NULL AS released`;

/** An allocation with its release flag. */
export interface AllocationRecord extends Allocation {
  released: boolean;
}

function toAllocation(row: RawAllocation): AllocationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    nodeId: row.node_id,
    owner: { kind: row.owner_kind, id: row.owner_id },
    atoms: row.atoms ?? [],
    resources:
      typeof row.resources === 'string'
        ? (JSON.parse(row.resources) as Record<string, number>)
        : row.resources,
    during: { start: Number(row.start_ms), end: Number(row.end_ms) },
    released: row.released,
  };
}

/** One allocation, optionally row-locked (`FOR UPDATE`). */
export async function readAllocation(
  tx: SqlTx,
  allocationId: string,
  options: { lock?: boolean } = {},
): Promise<AllocationRecord | undefined> {
  const { rows } = await tx.query<RawAllocation>(
    `SELECT ${allocationColumns} FROM allocations WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [allocationId],
  );
  return rows[0] ? toAllocation(rows[0]) : undefined;
}

/** The allocations one reservation or instance owns, oldest first. */
export async function readOwnerAllocations(
  tx: SqlTx,
  owner: Allocation['owner'],
  options: { includeReleased?: boolean } = {},
): Promise<AllocationRecord[]> {
  const { rows } = await tx.query<RawAllocation>(
    `SELECT ${allocationColumns} FROM allocations
      WHERE owner_kind = $1 AND owner_id = $2 ${options.includeReleased ? '' : 'AND released_at IS NULL'}
      ORDER BY id`,
    [owner.kind, owner.id],
  );
  return rows.map(toAllocation);
}

/** Current and future booked atoms of an allocation, per rollup resource. */
async function bookedByResource(
  tx: SqlTx,
  allocationId: string,
): Promise<Map<string, { now: number; later: number }>> {
  const { rows } = await tx.query<{ class: string; now: string | number; later: string | number }>(
    `SELECT d.class,
            count(*) FILTER (WHERE b.during @> compute_now()) AS now,
            count(*) FILTER (WHERE lower(b.during) > compute_now()) AS later
       FROM device_bookings b JOIN devices d ON d.id = b.device_id
      WHERE b.allocation_id = $1 GROUP BY d.class`,
    [allocationId],
  );
  const result = new Map<string, { now: number; later: number }>();
  for (const row of rows) {
    const resource = rollupResource(row.class);
    const entry = result.get(resource) ?? { now: 0, later: 0 };
    entry.now += Number(row.now);
    entry.later += Number(row.later);
    result.set(resource, entry);
  }
  return result;
}

/**
 * Releases an allocation at compute_now(): future bookings are deleted, the current one is
 * truncated, past ones stay as history; scalar claims and rollups are returned. Idempotent:
 * answers `false` for an allocation that is already released (and `NOT_FOUND` for none at all).
 */
export async function releaseAllocation(tx: SqlTx, allocationId: string): Promise<boolean> {
  const allocation = await readAllocation(tx, allocationId, { lock: true });
  if (!allocation) throw new ComputeError('NOT_FOUND', `Allocation ${allocationId} not found`);
  if (allocation.released) return false;

  const booked = await bookedByResource(tx, allocationId);
  await tx.query(
    `DELETE FROM device_bookings WHERE allocation_id = $1 AND lower(during) >= compute_now()`,
    [allocationId],
  );
  await tx.query(
    `UPDATE device_bookings SET during = tstzrange(lower(during), compute_now())
      WHERE allocation_id = $1 AND during @> compute_now()`,
    [allocationId],
  );
  for (const [resource, amount] of Object.entries(allocation.resources))
    if (amount > 0)
      await tx.query(
        `UPDATE node_resources SET allocated = GREATEST(0, allocated - $3)
          WHERE node_id = $1 AND resource = $2`,
        [allocation.nodeId, resource, amount],
      );
  await tx.query(
    `UPDATE allocations
        SET released_at = compute_now(), version = version + 1,
            during = CASE WHEN during @> compute_now() AND lower(during) < compute_now()
                          THEN tstzrange(lower(during), compute_now()) ELSE during END
      WHERE id = $1`,
    [allocationId],
  );
  for (const [resource, { now, later }] of booked)
    await applyRollupDelta(tx, allocation.poolId, resource, { allocated: -now, reserved: -later });
  return true;
}

export type ResizeOutcome =
  | { status: 'resized'; resources: Record<string, number> }
  /** `resource` does not fit on the allocation's node; nothing changed. */
  | { status: 'conflict'; resource: string };

/**
 * Changes an allocation's scalar claims in place (instance resize): growth takes the guarded
 * `allocated + Δ <= floor(allocatable × ratio)` update on its node, shrinkage returns room.
 * All-or-nothing. Quota deltas are the caller's, charged before and refunded after (lock order).
 */
export async function resizeAllocation(
  tx: SqlTx,
  allocationId: string,
  resources: Readonly<Record<string, number>>,
): Promise<ResizeOutcome> {
  const allocation = await readAllocation(tx, allocationId, { lock: true });
  if (!allocation) throw new ComputeError('NOT_FOUND', `Allocation ${allocationId} not found`);
  if (allocation.released)
    throw new ComputeError('INVALID_STATE', `Allocation ${allocationId} is released`);
  for (const [resource, amount] of Object.entries(resources))
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new ComputeError(
        'INVALID_INPUT',
        `Resource ${resource} must be a non-negative integer`,
      );
  const names = [
    ...new Set([...Object.keys(allocation.resources), ...Object.keys(resources)]),
  ].sort();
  const savepoint = `capacity_resize_${++savepoints}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    for (const resource of names) {
      const delta = (resources[resource] ?? 0) - (allocation.resources[resource] ?? 0);
      if (delta > 0) {
        const claimed = await tx.query(
          `UPDATE node_resources SET allocated = allocated + $3
            WHERE node_id = $1 AND resource = $2 AND allocated + $3 <= floor(allocatable * ratio)
            RETURNING allocated`,
          [allocation.nodeId, resource, delta],
        );
        if (claimed.rows.length === 0) {
          await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
          return { status: 'conflict', resource };
        }
      } else if (delta < 0)
        await tx.query(
          `UPDATE node_resources SET allocated = GREATEST(0, allocated - $3)
            WHERE node_id = $1 AND resource = $2`,
          [allocation.nodeId, resource, -delta],
        );
    }
    const next = Object.fromEntries(
      Object.entries(resources).filter(([, amount]) => amount > 0),
    ) as Record<string, number>;
    await tx.query(
      `UPDATE allocations SET resources = $2::jsonb, version = version + 1 WHERE id = $1`,
      [allocationId, JSON.stringify(next)],
    );
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { status: 'resized', resources: next };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export type ExtendOutcome =
  | { status: 'extended'; during: TimeRange }
  /** Another booking starts at `availableUntil`: the latest end this allocation can reach. */
  | { status: 'conflict'; availableUntil: number };

const iso = (ms: number) => new Date(ms).toISOString();
let savepoints = 0;

/** The earliest start of another booking on these atoms inside `[from, to)`, if any. */
async function nextConflict(
  tx: SqlTx,
  allocation: AllocationRecord,
  from: number,
  to: number,
): Promise<number | undefined> {
  if (allocation.atoms.length === 0) return undefined;
  const { rows } = await tx.query<{ next_ms: number | null }>(
    `SELECT (extract(epoch FROM min(lower(during))) * 1000)::float8 AS next_ms
       FROM device_bookings
      WHERE device_id = ANY($1::text[]) AND allocation_id <> $2
        AND during && tstzrange($3::timestamptz, $4::timestamptz)`,
    [allocation.atoms, allocation.id, iso(from), iso(to)],
  );
  const next = rows[0]?.next_ms;
  return next === null || next === undefined ? undefined : Number(next);
}

/**
 * Moves an allocation's end to `end` (§10.5 `extend`, tx 2). The EXCLUDE constraint is the arbiter:
 * a conflicting booking answers `conflict` with the latest reachable end, and nothing changes.
 * Scalar claims are not time-ranged, so they are unaffected.
 */
export async function extendAllocation(
  tx: SqlTx,
  allocationId: string,
  end: number,
): Promise<ExtendOutcome> {
  const allocation = await readAllocation(tx, allocationId, { lock: true });
  if (!allocation) throw new ComputeError('NOT_FOUND', `Allocation ${allocationId} not found`);
  if (allocation.released)
    throw new ComputeError('INVALID_STATE', `Allocation ${allocationId} is released`);
  if (!Number.isFinite(end) || end <= allocation.during.end)
    throw new ComputeError('INVALID_INPUT', 'An extension must move the end later');

  const blocked = await nextConflict(tx, allocation, allocation.during.end, end);
  if (blocked !== undefined) return { status: 'conflict', availableUntil: blocked };

  const savepoint = `capacity_extend_${++savepoints}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    await tx.query(
      `UPDATE device_bookings SET during = tstzrange(lower(during), $2::timestamptz)
        WHERE allocation_id = $1 AND upper(during) = $3::timestamptz`,
      [allocationId, iso(end), iso(allocation.during.end)],
    );
    await tx.query(
      `UPDATE allocations SET during = tstzrange(lower(during), $2::timestamptz),
                              version = version + 1
        WHERE id = $1`,
      [allocationId, iso(end)],
    );
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    // A booking committed between the check and the update: the EXCLUDE constraint refused it.
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    const raced = await nextConflict(tx, allocation, allocation.during.end, end);
    if (raced !== undefined) return { status: 'conflict', availableUntil: raced };
    throw error;
  }
  return { status: 'extended', during: { start: allocation.during.start, end } };
}
