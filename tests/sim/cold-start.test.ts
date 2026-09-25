import { describe, expect, it } from 'vitest';
import { runColdStart } from '@better-compute/testing';

// The v0.4 cold start (PLAN.md §15 "10k cold start ≤3 min") at CI size: the fleet powers on within 30 s behind
// three gateways; every node is connected, adopted and schedulable within 3 simulated minutes, nothing is marked
// unreachable, and after a full power cycle every node is back within the same bound. The 10k run is nightly
// (tests/nightly/cold-start.nightly.ts, `pnpm sim:nightly`).

describe('cold start (CI size)', () => {
  it('boots and power-cycles a fleet within 3 minutes', async () => {
    const report = await runColdStart({ seed: 'ci', nodes: 24 });
    console.log(JSON.stringify(report));
    expect(report.violations).toEqual([]);
    expect(report.boot).toMatchObject({ notConnected: 0, notAdopted: 0, unreachableMarks: 0 });
    expect(report.boot.allReadyMs).toBeLessThanOrEqual(3 * 60_000);
    expect(report.restart).toMatchObject({ notConnected: 0 });
    expect(report.restart!.allReadyMs).toBeLessThanOrEqual(3 * 60_000);
    expect(report.schedulable).toBe(24);
    expect(report.ok).toBe(true);
  }, 600_000);
});
