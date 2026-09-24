import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  createControlPlaneSim,
  type ControlPlaneSim,
} from '@better-compute/testing';

// I1 and I8 (PLAN.md §15) against the real capacity module: the real control plane and gateway under the fleet
// simulator, with links that drop, partition and reset, and daemons that crash. Tenants reserve and release GPUs
// throughout; the store's bookings never overlap (I1), and every released allocation bills exactly its bound
// time in atoms (I8), with no duplicate usage keys.

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('capacity invariants under the fleet simulator', () => {
  it('keeps I1 and I8 while reservations churn over a faulty fleet', async () => {
    rig = await createControlPlaneSim({
      seed: 'capacity-invariants',
      nodes: 4,
      up: { latencyMs: 5, jitterMs: 20, drop: 0.001, dropMode: 'reset' },
      down: { latencyMs: 5, jitterMs: 20, drop: 0.001, dropMode: 'reset' },
      chaos: { everyMs: 20_000, crash: 0.2, partition: 0.2, reset: 0.2 },
    });
    const { compute, tenants, api, database } = rig;
    const acme = { token: tenants.acme.token };
    await rig.run(2 * MIN);

    // Half-node reservations arrive every 20 s; each is released 40 s after it turned active.
    const live: { id: string; activeAt?: number }[] = [];
    let created = 0;
    let released = 0;
    for (let step = 0; step < 30; step++) {
      await rig.run(20_000);
      const reservation = await api(() =>
        compute.api.reservations.create(acme, {
          tenantId: tenants.acme.id,
          poolId: rig!.poolId,
          devices: [{ class: 'gpu', count: 4 }],
          duration: '1h',
          idempotencyKey: `churn-${step}`,
        } as never),
      );
      created++;
      live.push({ id: reservation.id });
      const now = rig.sim.scheduler.now();
      const { rows } = await database.query<{ id: string; state: string }>(
        'SELECT id, state FROM reservations WHERE id = ANY($1::text[])',
        [live.map((entry) => entry.id)],
      );
      for (const row of rows) {
        const entry = live.find((item) => item.id === row.id)!;
        if (row.state === 'active') entry.activeAt ??= now;
        if (entry.activeAt !== undefined && now - entry.activeAt >= 40_000) {
          await api(() =>
            compute.api.reservations.release(acme, {
              tenantId: tenants.acme.id,
              reservationId: row.id,
            } as never),
          );
          released++;
          live.splice(live.indexOf(entry), 1);
        }
      }
    }
    rig.sim.quiesce();
    // capacity.usage meters every 5 minutes: let one pass cover every release.
    await rig.run(6 * MIN);

    expect(created).toBe(30);
    expect(released).toBeGreaterThan(10);
    const facts = (await rig.facts.refresh(), rig.facts.facts());
    expect(facts.bookings.length).toBeGreaterThan(0);
    // Released allocations have been metered (their final window is written once billing ends).
    const closed = facts.allocations.filter((allocation) => allocation.end !== undefined);
    expect(closed.length).toBeGreaterThan(0);
    expect(facts.usage.length).toBeGreaterThanOrEqual(closed.length);
    assertInvariants(await rig.invariants({ flushedUpTo: rig.sim.scheduler.now() - 60 * MIN }));
  }, 900_000);
});
