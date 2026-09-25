import { describe, expect, it } from 'vitest';
import {
  createTimelineView,
  earliestFit,
  timelineView,
  type CapacityTimelineInput,
  type ComputeRequester,
} from '@better-compute/console-kit';

// console-kit booking calendar: levels, peak, day grouping and the earliest free window.

const hour = 3_600_000;
const t0 = new Date(2026, 8, 24, 22).getTime(); // 22:00 local, so the strip crosses midnight

const timeline = (booked: number[], allocatable = 8): CapacityTimelineInput => ({
  poolId: 'pool_a',
  allocatable,
  buckets: booked.map((count, index) => ({
    start: t0 + index * hour,
    end: t0 + (index + 1) * hour,
    booked: count,
    free: Math.max(0, allocatable - count),
  })),
});

describe('timeline view', () => {
  it('levels each bucket, finds the peak and groups by local day', () => {
    const view = timelineView(timeline([2, 7, 8, 0]));
    expect(view.buckets.map((bucket) => bucket.level)).toEqual(['free', 'busy', 'full', 'free']);
    expect(view.buckets[1]!.ratio).toBe(7 / 8);
    expect(view.peak).toEqual({ booked: 8, start: t0 + 2 * hour });
    expect(view.days.map((day) => day.buckets.length)).toEqual([2, 2]);
  });

  it('treats a pool with nothing allocatable as full', () => {
    const view = timelineView(timeline([0, 0], 0));
    expect(view.buckets.map((bucket) => [bucket.ratio, bucket.level])).toEqual([
      [1, 'full'],
      [1, 'full'],
    ]);
    expect(view.peak).toEqual({ booked: 0 });
  });

  it('sorts buckets the API returned out of order', () => {
    const raw = timeline([1, 2, 3]);
    raw.buckets.reverse();
    expect(timelineView(raw).buckets.map((bucket) => bucket.booked)).toEqual([1, 2, 3]);
  });
});

describe('earliest fit', () => {
  it('returns the first window with enough GPUs free for the whole duration', () => {
    // free: 6, 1, 4, 4, 4, 0
    const raw = timeline([2, 7, 4, 4, 4, 8]);
    expect(earliestFit(raw, 4, 3 * hour)).toBe(t0 + 2 * hour);
    expect(earliestFit(raw, 4, hour)).toBe(t0);
    expect(earliestFit(raw, 4, 4 * hour)).toBeUndefined();
    expect(earliestFit(raw, 7, hour)).toBeUndefined();
  });

  it('honours notBefore and treats a gap between buckets as a break', () => {
    const raw = timeline([0, 0, 0, 0]);
    expect(earliestFit(raw, 2, 2 * hour, { notBefore: t0 + hour })).toBe(t0 + hour);
    raw.buckets.splice(1, 1); // hour 1 missing: 0, (gap), 2, 3
    expect(earliestFit(raw, 2, 2 * hour)).toBe(t0 + 2 * hour);
    expect(earliestFit(raw, 2, 3 * hour)).toBeUndefined();
  });

  it('refuses nonsense requests', () => {
    expect(earliestFit(timeline([0]), 0, hour)).toBeUndefined();
    expect(earliestFit(timeline([0]), 1, 0)).toBeUndefined();
  });
});

describe('createTimelineView', () => {
  it('loads capacity.timeline with only the inputs given', async () => {
    const calls: unknown[] = [];
    const api: ComputeRequester = {
      async $request<Output>(path: string, input?: unknown): Promise<Output> {
        calls.push([path, input]);
        return timeline([1, 8]) as Output;
      },
    };
    const view = createTimelineView(api, { tenantId: 'ten', poolId: 'pool_a', stepMinutes: 30 });
    await view.refresh();
    expect(calls).toEqual([
      ['capacity/timeline', { tenantId: 'ten', poolId: 'pool_a', stepMinutes: 30 }],
    ]);
    const value = view.get().value!;
    expect(value.buckets.map((bucket) => bucket.level)).toEqual(['free', 'full']);
    expect(value.raw.allocatable).toBe(8);
  });
});
