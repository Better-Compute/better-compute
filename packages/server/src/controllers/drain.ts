import type { ModuleContext } from '@better-compute/core';
import { drainWorkKind, drainingReason, mergeReasons, toMs } from './node-state.js';

// Drain (PLAN.md §8.4, §9.2 `nodes.drain`). `nodes.drain` cordons the node, adds the `draining`
// NoSchedule reason and enqueues this controller. In v0.1 it releases nothing itself (P6; forced
// release within a pool's disruption budget comes with v0.4 rebalancing): it waits until the node
// holds no live allocation (released, or past the end of its interval), looking again at the
// earliest end and at least every `drainRecheckMs`. Then the drain is complete: `draining` leaves
// `no_schedule_reasons` (the node stays cordoned until `nodes.uncordon`) and `node.drained` is
// published.

/** The longest a draining node waits between two looks at its allocations. */
export const drainRecheckMs = 5 * 60_000;

export interface DrainOutcome {
  /** Whether the node is still draining. */
  draining: boolean;
  /** Live allocations left on the node. */
  allocations: number;
  /** When the controller looks again (while draining). */
  nextCheckAt?: number;
}

/** One Drain pass over a node, in one transaction with its row locked. */
export async function reconcileDrain(
  context: Pick<ModuleContext, 'sql' | 'clock' | 'work' | 'events'>,
  nodeId: string,
): Promise<DrainOutcome | undefined> {
  return context.sql.transaction(async (tx) => {
    const { rows } = await tx.query<{ owner_tenant_id: string; no_schedule_reasons: string[] }>(
      'SELECT owner_tenant_id, no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE',
      [nodeId],
    );
    const node = rows[0];
    if (!node) return undefined;
    if (!node.no_schedule_reasons.includes(drainingReason))
      return { draining: false, allocations: 0 };
    const { rows: live } = await tx.query<{ count: string | number; next_end: Date | null }>(
      `SELECT count(*) AS count, min(upper(during)) AS next_end FROM allocations
        WHERE node_id = $1 AND released_at IS NULL
          AND (upper_inf(during) OR upper(during) > compute_now())`,
      [nodeId],
    );
    const allocations = Number(live[0]?.count ?? 0);
    if (allocations > 0) {
      const nextEnd = toMs(live[0]?.next_end);
      const nextCheckAt = Math.min(
        nextEnd ?? Number.POSITIVE_INFINITY,
        context.clock.now() + drainRecheckMs,
      );
      await context.work.enqueue(tx, drainWorkKind, nodeId, { notBefore: nextCheckAt });
      return { draining: true, allocations, nextCheckAt };
    }
    await tx.query(
      'UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1',
      [nodeId, mergeReasons(node.no_schedule_reasons, [], [drainingReason])],
    );
    await context.events.publish(tx, {
      type: 'node.drained',
      tenantId: node.owner_tenant_id,
      subject: `node/${nodeId}`,
      data: { nodeId },
    });
    return { draining: false, allocations: 0 };
  });
}
