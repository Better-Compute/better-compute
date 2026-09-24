import { afterEach, describe, expect, it } from 'vitest';
import { createRealtimeFleet, type RealtimeFleet } from '@better-compute/testing';

// The v0.1 spine on the wall clock (PLAN.md §15, §16): FakeDaemons Join through a real gateway to a real control
// plane, pass diag.nvml acceptance and apply their NodeSpec; then a tenant's reservations bind on them and turn
// active when the daemons report AllocationBound. The 1k acceptance run is `pnpm bench:scale`.

let fleet: RealtimeFleet | undefined;
afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
});

describe('real-time fleet', () => {
  it('joins nodes to adopted and turns placed reservations active', async () => {
    fleet = await createRealtimeFleet();
    const joined = await fleet.join(3, { timeoutMs: 60_000 });
    expect(joined.missing).toEqual([]);
    expect(joined.nodes).toHaveLength(3);
    expect(joined.adopted.count).toBe(3);

    const placed = await fleet.place(3, { timeoutMs: 30_000 });
    expect(placed.missing).toEqual([]);
    expect(placed.active.count).toBe(3);
    // Every node carries one whole-node reservation.
    const { rows } = await fleet.database.query<{ node_id: string }>(
      `SELECT DISTINCT a.node_id FROM allocations a JOIN reservations r ON r.id = a.owner_id
        WHERE r.id = ANY($1::text[]) AND a.released_at IS NULL`,
      [placed.reservations],
    );
    expect(rows.map((row) => row.node_id).sort()).toEqual([...joined.nodes].sort());
  }, 120_000);
});
