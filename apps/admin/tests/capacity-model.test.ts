import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type CapacityTimeline, type Reservation } from '@/lib/data/capacity';
import { packLanes, quotaCells, quotaSuggestions, runway } from '@/components/capacity/model';
import { decodeScenario, encodeScenario, evaluate, type Change } from '@/components/capacity/scenarios';

const T0 = Date.UTC(2026, 8, 20, 0);

/** A flat hourly timeline: `booked` GPUs of `allocatable` for `hours`. */
function flat(poolId: string, allocatable: number, booked: number | ((hour: number) => number), hours = 168): CapacityTimeline {
  return {
    poolId,
    allocatable,
    buckets: Array.from({ length: hours }, (_, index) => {
      const value = typeof booked === 'function' ? booked(index) : booked;
      return { start: T0 + index * HOUR, end: T0 + (index + 1) * HOUR, booked: value, free: Math.max(0, allocatable - value) };
    }),
  };
}

describe('scenarios.evaluate', () => {
  const timelines = new Map([['p', flat('p', 64, 48)]]);
  const perNode = new Map([['p', 8]]);

  it('is the baseline without changes', () => {
    const outcome = evaluate(timelines, perNode, [], T0, 168).pools.get('p')!;
    expect(outcome.minFree).toBe(16);
    expect(outcome.hoursFull).toBe(0);
    expect(outcome.displacedGpuHours).toBe(0);
    expect(outcome.earliest8x24).toBe(0);
  });

  it('displaces bookings that no longer fit when nodes go out', () => {
    // 4 nodes × 8 = 32 GPUs out for 10 h: capacity 32 < 48 booked → 16 GPUs × 10 h must move.
    const change: Change = { id: 'm', kind: 'maintenance', poolId: 'p', nodes: 4, startHours: 5, hours: 10 };
    const outcome = evaluate(timelines, perNode, [change], T0, 168).pools.get('p')!;
    expect(outcome.displacedGpuHours).toBe(160);
    expect(outcome.hoursFull).toBe(10);
    expect(outcome.free[4]).toBe(16);
    expect(outcome.free[5]).toBe(0);
    expect(outcome.free[15]).toBe(16);
  });

  it('counts a burst larger than the free GPUs as unmet demand', () => {
    const change: Change = { id: 'b', kind: 'burst', poolId: 'p', gpus: 24, startHours: 0, hours: 2 };
    const outcome = evaluate(timelines, perNode, [change], T0, 168).pools.get('p')!;
    expect(outcome.unmetGpuHours).toBe(16); // 8 GPUs short for 2 h
    expect(outcome.peak).toBeCloseTo(72 / 64);
  });

  it('adds capacity from the expansion start, for good', () => {
    const change: Change = { id: 'e', kind: 'expand', poolId: 'p', nodes: 2, startHours: 100 };
    const outcome = evaluate(timelines, perNode, [change], T0, 168).pools.get('p')!;
    expect(outcome.free[99]).toBe(16);
    expect(outcome.free[100]).toBe(32);
    expect(outcome.free[167]).toBe(32);
  });

  it('round-trips a scenario through the URL encoding and rejects garbage', () => {
    const changes: Change[] = [
      { id: 'a', kind: 'maintenance', poolId: 'pool_a', nodes: 3, startHours: 7, hours: 5 },
      { id: 'b', kind: 'burst', poolId: 'pool_b', gpus: 96, startHours: 24, hours: 48 },
      { id: 'c', kind: 'expand', poolId: 'pool_c', nodes: 8, startHours: 120 },
    ];
    const strip = (list: Change[]) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(decodeScenario(encodeScenario(changes)))).toEqual(strip(changes));
    expect(decodeScenario('%%%not-base64')).toEqual([]);
    expect(decodeScenario(null)).toEqual([]);
  });
});

describe('model.runway', () => {
  it('finds the trend and when it reaches 95%', () => {
    // Daily share rising 2 points a day from 50%: 14 days of hourly buckets.
    const timeline = flat('p', 100, (hour) => 50 + 2 * Math.floor(hour / 24), 14 * 24);
    const result = runway(timeline);
    expect(result.daily).toHaveLength(14);
    expect(result.slopePerWeek).toBeCloseTo(0.14, 5);
    expect(result.current).toBeCloseTo(0.76, 5);
    expect(result.daysToCeiling).toBeCloseTo((0.95 - 0.76) / 0.02, 3);
  });

  it('has no date when flat or falling, and 0 when already past the ceiling', () => {
    expect(runway(flat('p', 100, 60, 14 * 24)).daysToCeiling).toBeUndefined();
    expect(runway(flat('p', 100, (hour) => 90 - Math.floor(hour / 24), 14 * 24)).daysToCeiling).toBeUndefined();
    expect(runway(flat('p', 100, 99, 14 * 24)).daysToCeiling).toBe(0);
  });
});

describe('model.packLanes', () => {
  const r = (id: string, start: number, end: number) => ({ id, during: { start, end } }) as unknown as Reservation;

  it('reuses a lane once its last bar has ended and never overlaps within a lane', () => {
    const list = [r('a', 0, 10), r('b', 5, 15), r('c', 10, 20), r('d', 16, 30), r('e', 12, 14)];
    const { lanes, laneOf } = packLanes(list);
    expect(lanes).toBe(3);
    const byLane = new Map<number, Reservation[]>();
    for (const item of list) byLane.set(laneOf.get(item.id)!, [...(byLane.get(laneOf.get(item.id)!) ?? []), item]);
    for (const members of byLane.values()) {
      const sorted = members.sort((x, y) => x.during!.start - y.during!.start);
      for (let index = 1; index < sorted.length; index += 1) expect(sorted[index]!.during!.start).toBeGreaterThanOrEqual(sorted[index - 1]!.during!.end);
    }
  });
});

describe('model.quotaCells', () => {
  it('levels a row ok, warning from 80%, full when nothing is left', () => {
    const cells = quotaCells([
      { tenantId: 't', poolId: 'p', resource: 'gpu', max: 10, used: 5 },
      { tenantId: 't', poolId: 'q', resource: 'gpu', max: 10, used: 8 },
      { tenantId: 't', poolId: 'r', resource: 'gpu', max: 10, used: 10 },
      { tenantId: 't', poolId: 's', resource: 'gpu', max: 0, used: 0 },
    ]);
    expect(cells.map((cell) => cell.level)).toEqual(['ok', 'warning', 'full', 'ok']);
  });
});

describe('model.quotaSuggestions', () => {
  const now = T0 + 40 * DAY;
  const reservation = (id: string, tenantId: string, gpus: number, start: number, end: number): Reservation =>
    ({
      id,
      tenantId,
      poolId: 'p',
      state: 'released',
      request: { poolId: 'p', devices: [{ class: 'gpu', count: gpus }], duration: '1h' },
      during: { start, end },
      ownerIdentityId: 'i',
      idempotencyKey: id,
      conditions: [],
      version: 1,
    }) as Reservation;
  const snapshot = (reservations: Reservation[], quotas: { tenantId: string; max: number; used: number }[]) =>
    ({
      now,
      tenantId: 'root',
      reservations,
      quotas: quotas.map((q) => ({ ...q, poolId: 'p', resource: 'gpu' })),
    }) as unknown as Parameters<typeof quotaSuggestions>[0];

  it('lowers a mostly idle ceiling to 125% of the peak in whole nodes', () => {
    // Two overlapping 8-GPU bookings → peak 16 of 64: suggest 24 (16 × 1.25 = 20 → 24).
    const list = quotaSuggestions(snapshot([reservation('a', 't', 8, now - 5 * DAY, now - 4 * DAY), reservation('b', 't', 8, now - 5 * DAY, now - 4 * DAY)], [{ tenantId: 't', max: 64, used: 0 }]));
    expect(list).toEqual([expect.objectContaining({ tenantId: 't', peak: 16, suggested: 24, direction: 'lower' })]);
  });

  it('raises a ceiling that was reached, and leaves a well-sized one alone', () => {
    const list = quotaSuggestions(
      snapshot(
        [reservation('a', 'hot', 32, now - 2 * DAY, now - DAY), reservation('b', 'ok', 24, now - 2 * DAY, now - DAY)],
        [
          { tenantId: 'hot', max: 32, used: 0 },
          { tenantId: 'ok', max: 32, used: 0 },
        ],
      ),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tenantId: 'hot', direction: 'raise', suggested: 40 });
  });

  it('ignores the operator and bookings older than the window', () => {
    const list = quotaSuggestions(snapshot([reservation('old', 't', 64, now - 35 * DAY, now - 34 * DAY)], [{ tenantId: 'root', max: 64, used: 0 }, { tenantId: 't', max: 64, used: 0 }]));
    expect(list).toEqual([expect.objectContaining({ tenantId: 't', peak: 0, suggested: 8, direction: 'lower' })]);
  });
});

describe('time constants', () => {
  it('are the core ones', () => {
    expect(DAY).toBe(24 * HOUR);
  });
});
