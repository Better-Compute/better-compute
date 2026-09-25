import { describe, expect, it } from 'vitest';
import { placeablePending } from '@better-compute/capacity';
import {
  assertInvariants,
  checkI7,
  runNightly,
  type ControlPlaneSim,
} from '@better-compute/testing';

/** I7 after the night's quiet period: nothing pending that capacity's offline solver would place now. */
const i7 = async (rig: ControlPlaneSim) =>
  checkI7(
    await rig.database.transaction((tx) => placeablePending(tx, { now: rig.sim.scheduler.now() })),
  );

// The CI-sized night (PLAN.md §15): the full scenario mix on a small fleet for a few simulated minutes. The nightly
// matrix (`pnpm sim:nightly`, tests/nightly/) runs the same scenario bigger and longer over many seeds.

describe('nightly simulation (CI size)', () => {
  it('keeps every invariant through chaos with gangs, spot, calendar starts and releases', async () => {
    const report = await runNightly({
      seed: 'ci-1',
      nodes: 4,
      gateways: 2,
      minutes: 6,
      chaos: 'light',
      invariants: i7,
    });
    assertInvariants(report.violations);
    expect(report.ok).toBe(true);
    expect(Object.values(report.workload).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(20);
    // Something reached the nodes and came back.
    expect(
      (report.reservations.active ?? 0) +
        (report.reservations.released ?? 0) +
        (report.reservations.ended ?? 0),
    ).toBeGreaterThan(0);
    expect(report.commands.succeeded ?? 0).toBeGreaterThan(0);
    console.log(JSON.stringify({ ...report, violations: report.violations.length }));

    // The same seed asks for exactly the same workload.
    const again = await runNightly({
      seed: 'ci-1',
      nodes: 4,
      gateways: 2,
      minutes: 6,
      chaos: 'light',
    });
    expect(again.workloadDigest).toBe(report.workloadDigest);
    // Outcomes may differ (random ids break ties); the workload may not.
  }, 900_000);
});
