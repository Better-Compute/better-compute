import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { anchoredClock, clockSkewThresholdMs, isAnchoredClock } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { memoryLogger } from './support/server.js';
import { sibling } from './support/runtime.js';

// The one clock (PLAN.md §8.4, P9): business time anchored to compute_now(), sampled at lease
// renewals, with ClockSkew (a log warning and a selfCheck finding) beyond one second.

afterEach(closeFixtures);

const START = Date.UTC(2026, 0, 1);

const skewFindings = async (compute: { selfCheck(): Promise<{ findings: { check: string }[] }> }) =>
  (await compute.selfCheck()).findings.filter((finding) => finding.check === 'clock.skew');

describe('anchoredClock', () => {
  it('reads the process clock plus the offset of the last sample (midpoint of the round trip)', () => {
    const clock = anchoredClock();
    expect(isAnchoredClock(clock)).toBe(true);
    expect(clock.sampled()).toBe(false);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
    const sentAt = Date.now();
    clock.anchor(sentAt + 60_000 + 5, sentAt, sentAt + 10);
    expect(clock.offsetMs()).toBe(60_000);
    expect(clock.sampled()).toBe(true);
    expect(Math.abs(clock.now() - (Date.now() + 60_000))).toBeLessThan(50);
    expect(isAnchoredClock(manualClock())).toBe(false);
  });
});

describe('clock monitoring', () => {
  it('finds nothing when the sim clock and compute_now() move together', async () => {
    const fixture = await computeFixture();
    await fixture.compute.context.leases.acquire('shard:1', 'wkr', 15_000);
    await fixture.advance(90_000);
    await fixture.compute.context.leases.acquire('shard:1', 'wkr', 15_000);
    expect(await skewFindings(fixture.compute)).toEqual([]);
  });

  it('raises ClockSkew at a lease renewal when a clock drifts from compute_now() by more than 1 s', async () => {
    const fixture = await computeFixture();
    const log = memoryLogger();
    const drifting = manualClock(START - clockSkewThresholdMs - 500);
    const compute = await sibling(fixture, { clock: drifting, log });
    await compute.context.leases.acquire('singleton:x', 'wkr', 15_000);
    expect(await skewFindings(compute)).toEqual([
      expect.objectContaining({ check: 'clock.skew', severity: 'warning' }),
    ]);
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ condition: 'ClockSkew', skewMs: 1500 }),
      }),
    );
    drifting.set(START + 200);
    await compute.context.leases.acquire('singleton:x', 'wkr', 15_000);
    expect(await skewFindings(compute)).toEqual([]);
    expect(log.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  it('anchors the default clock to compute_now() at initialize and flags a process clock that is off', async () => {
    const fixture = await computeFixture(); // compute_now() reads the sim clock: 2026-01-01
    const compute = await sibling(fixture, { clock: undefined, log: memoryLogger() });
    expect(Math.abs(compute.context.clock.now() - START)).toBeLessThan(5_000);
    expect(await skewFindings(compute)).toHaveLength(1);
    // Every lease renewal re-anchors it.
    await fixture.advance(3_600_000);
    await compute.context.leases.acquire('singleton:y', 'wkr', 15_000);
    expect(Math.abs(compute.context.clock.now() - (START + 3_600_000))).toBeLessThan(5_000);
  });
});
