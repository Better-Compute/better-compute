import type { Migration, ModuleContext, ReconcileContext, SqlTx } from '@better-compute/core';
import { bookPartitionChange, releasePartitionChange } from './partition.js';

// The MIG layout gate (PLAN.md §10.4 point 2, §10.6 "MIG changes apply only when all of the GPU's
// atoms are free"). A pool's `policy.migLayout` reaches each node through the provision
// `mig-layout` config unit, and the daemon repartitions its GPUs to it. Changing it on a pool with
// booked MIG instances must not repartition them under their holders, so:
//
// 1. `pools.update` freezes every node of a `mig` pool at the old layout, with the new one pending
//    (`capacity_mig_layouts`); provision's host config reads the node's gated layout
//    (`grantedMigLayout`), falling back to the pool's for nodes never gated.
// 2. The `capacity.mig` reconciler books every GPU family of the node (parent + every atom, the
//    atom rule) from the end of its last booking onward, so nothing new lands past that point.
// 3. At that time it grants the pending layout and invalidates the node's spec; the daemon
//    repartitions idle GPUs.
// 4. Once the node has converged the spec that carried it (a newer generation, observed), the
//    partition bookings are released and the new atoms take work.
//
// A node joining later reads the pool's layout directly: it is not schedulable before its first
// converged spec, so nothing of it can be booked yet.

/** How long a granted change may leave the node's generation unmoved before the gate assumes its spec never carried the layout. */
export const migGrantSettleMs = 5 * 60_000;
/** Polling while a change waits for convergence. */
const convergencePollMs = 30_000;
/** Partition windows are open-ended in practice: they end when released. */
const partitionHorizonMs = 400 * 86_400_000;

export const migGateWork = 'capacity.mig';

export const migLayoutsMigration: Migration = {
  name: 'capacity/0004_mig_layouts',
  sql: `
CREATE TABLE capacity_mig_layouts (
  node_id text PRIMARY KEY REFERENCES nodes ON DELETE CASCADE,
  -- The layout the node's spec may carry.
  layout text NOT NULL,
  -- The pool's newer layout, waiting for the node's GPUs to be free.
  pending_layout text,
  -- When the partition bookings start: the change is granted then.
  change_at timestamptz,
  -- The partition bookings held for the change (allocation ids 'partition:<gpu>:<start>').
  bookings text[] NOT NULL DEFAULT '{}',
  -- nodes.generation when the change was granted, and when.
  granted_generation bigint,
  granted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

/** The MIG layout a node's spec may carry, when a change ever gated it (else the pool's applies). */
export async function grantedMigLayout(tx: SqlTx, nodeId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ layout: string }>(
    `SELECT layout FROM capacity_mig_layouts WHERE node_id = $1`,
    [nodeId],
  );
  return rows[0]?.layout;
}

/**
 * `pools.update` changed a `mig` pool's layout from `before` to `after`: every live node of the
 * pool keeps `before` (or the layout it already holds) with `after` pending, and its gate runs.
 */
export async function freezeMigLayouts(
  tx: SqlTx,
  work: ModuleContext['work'],
  poolId: string,
  before: string,
  after: string,
): Promise<number> {
  const { rows } = await tx.query<{ node_id: string }>(
    `INSERT INTO capacity_mig_layouts AS m (node_id, layout, pending_layout)
     SELECT id, $2, $3 FROM nodes WHERE pool_id = $1 AND deleted_at IS NULL
     ON CONFLICT (node_id) DO UPDATE
       SET pending_layout = CASE WHEN m.layout = EXCLUDED.pending_layout THEN NULL
                                 ELSE EXCLUDED.pending_layout END,
           updated_at = compute_now()
     RETURNING node_id`,
    [poolId, before, after],
  );
  for (const row of rows) await work.enqueue(tx, migGateWork, row.node_id);
  return rows.length;
}

interface GateRow {
  layout: string;
  pending_layout: string | null;
  change_at_ms: number | null;
  bookings: string[];
  granted_generation: string | number | null;
  granted_at_ms: number | null;
}

/** One step of a node's MIG layout gate; answers when to look again (epoch ms), or `undefined`. */
export async function stepMigGate(
  tx: SqlTx,
  context: Pick<ModuleContext, 'clock' | 'desired' | 'events'>,
  nodeId: string,
): Promise<number | undefined> {
  const now = context.clock.now();
  const { rows } = await tx.query<GateRow>(
    `SELECT layout, pending_layout, bookings, granted_generation,
            (extract(epoch FROM change_at) * 1000)::float8 AS change_at_ms,
            (extract(epoch FROM granted_at) * 1000)::float8 AS granted_at_ms
       FROM capacity_mig_layouts WHERE node_id = $1 FOR UPDATE`,
    [nodeId],
  );
  const gate = rows[0];
  if (!gate) return undefined;
  const { rows: nodes } = await tx.query<{
    generation: string | number;
    observed_generation: string | number;
    owner_tenant_id: string;
  }>(`SELECT generation, observed_generation, owner_tenant_id FROM nodes WHERE id = $1`, [nodeId]);
  const node = nodes[0];
  if (!node) return undefined;

  // A granted change: hold the families until the node converged the spec that carried it.
  if (gate.granted_generation !== null) {
    const granted = Number(gate.granted_generation);
    const generation = Number(node.generation);
    const converged =
      (generation > granted && Number(node.observed_generation) >= generation) ||
      (generation === granted && now - Number(gate.granted_at_ms) >= migGrantSettleMs);
    if (!converged) return now + convergencePollMs;
    for (const booking of gate.bookings) await releasePartitionChange(tx, booking);
    await tx.query(
      `UPDATE capacity_mig_layouts SET bookings = '{}', change_at = NULL, granted_generation = NULL,
              granted_at = NULL, updated_at = compute_now() WHERE node_id = $1`,
      [nodeId],
    );
    await context.events.publish(tx, {
      type: 'node.mig.applied',
      tenantId: node.owner_tenant_id,
      subject: `node/${nodeId}`,
      data: { layout: gate.layout },
    });
    // A newer layout may already be waiting.
    return gate.pending_layout !== null ? now : undefined;
  }
  if (gate.pending_layout === null) return undefined;

  // Book every GPU family from the end of its last booking onward (idle from then on).
  if (gate.bookings.length === 0) {
    const { rows: gpus } = await tx.query<{ id: string }>(
      `SELECT id FROM devices WHERE node_id = $1 AND class = 'gpu' AND parent_id IS NULL ORDER BY id`,
      [nodeId],
    );
    const { rows: ends } = await tx.query<{ end_ms: number | null }>(
      `SELECT (extract(epoch FROM max(upper(b.during))) * 1000)::float8 AS end_ms
         FROM device_bookings b JOIN devices d ON d.id = b.device_id
        WHERE d.node_id = $1 AND (d.class = 'gpu' OR d.parent_id IS NOT NULL)
          AND upper(b.during) > compute_now()`,
      [nodeId],
    );
    const from = Math.max(now, Number(ends[0]?.end_ms ?? now));
    const held: string[] = [];
    for (const gpu of gpus) {
      const booked = await bookPartitionChange(tx, {
        gpuId: gpu.id,
        during: { start: from, end: from + partitionHorizonMs },
      });
      if (booked.status === 'conflict') {
        // Something was booked meanwhile: give back what this run took and look again.
        for (const booking of held) await releasePartitionChange(tx, booking);
        return now + convergencePollMs;
      }
      held.push(booked.bookingId);
    }
    await tx.query(
      `UPDATE capacity_mig_layouts SET bookings = $2::text[], change_at = $3::timestamptz,
              updated_at = compute_now() WHERE node_id = $1`,
      [nodeId, held, new Date(from).toISOString()],
    );
    await context.events.publish(tx, {
      type: 'node.mig.scheduled',
      tenantId: node.owner_tenant_id,
      subject: `node/${nodeId}`,
      data: { layout: gate.pending_layout, at: from },
    });
    if (from > now) return from;
    gate.change_at_ms = from;
  }

  if (now < Number(gate.change_at_ms)) return Number(gate.change_at_ms);
  // Every family is idle and held: grant the new layout; the daemon repartitions.
  await tx.query(
    `UPDATE capacity_mig_layouts SET layout = pending_layout, pending_layout = NULL,
            granted_generation = $2, granted_at = compute_now(), updated_at = compute_now()
      WHERE node_id = $1`,
    [nodeId, Number(node.generation)],
  );
  await context.desired.invalidate(tx, nodeId);
  await context.events.publish(tx, {
    type: 'node.mig.granted',
    tenantId: node.owner_tenant_id,
    subject: `node/${nodeId}`,
    data: { layout: gate.pending_layout },
  });
  return now + convergencePollMs;
}

/** The `capacity.mig` reconciler (shardBy node): one gate step, re-enqueued at its next time. */
export async function runMigGate(context: ReconcileContext, nodeId: string): Promise<'DONE'> {
  await context.sql.transaction(async (tx) => {
    const next = await stepMigGate(tx, context, nodeId);
    if (next !== undefined)
      await context.work.enqueue(tx, migGateWork, nodeId, { notBefore: next });
  });
  return 'DONE';
}
