import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// A pool's booking calendar (`capacity.timeline`, v0.2): GPUs booked and free per bucket, with a level a
// view colors, the peak, and "the earliest window where N GPUs are free for D", which the reservation form
// shows before submitting. Pure derivations over the API result, so they test without a server.

/** `capacity.timeline` as the API returns it. */
export interface CapacityTimelineInput {
  poolId: string;
  allocatable: number;
  buckets: { start: number; end: number; booked: number; free: number }[];
}

export interface TimelineBucket {
  start: number;
  end: number;
  booked: number;
  free: number;
  /** booked / allocatable (1 when nothing is allocatable). */
  ratio: number;
  level: 'free' | 'busy' | 'full';
}

export interface TimelineView {
  poolId: string;
  allocatable: number;
  buckets: TimelineBucket[];
  /** The most GPUs booked in any bucket, and when first. */
  peak: { booked: number; start?: number };
  /** Buckets per local calendar day (`YYYY-MM-DD`), for a day-by-day strip. */
  days: { day: string; buckets: TimelineBucket[] }[];
}

const dayOf = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function timelineView(
  timeline: CapacityTimelineInput,
  options: { busyAt?: number } = {},
): TimelineView {
  const busyAt = options.busyAt ?? 0.8;
  const buckets = [...timeline.buckets]
    .sort((a, b) => a.start - b.start)
    .map((bucket): TimelineBucket => {
      const ratio =
        timeline.allocatable > 0 ? Math.min(1, bucket.booked / timeline.allocatable) : 1;
      return {
        ...bucket,
        ratio,
        level: bucket.free <= 0 ? 'full' : ratio >= busyAt ? 'busy' : 'free',
      };
    });
  let peak: TimelineView['peak'] = { booked: 0 };
  for (const bucket of buckets)
    if (bucket.booked > peak.booked) peak = { booked: bucket.booked, start: bucket.start };
  const days = new Map<string, TimelineBucket[]>();
  for (const bucket of buckets) {
    const day = dayOf(bucket.start);
    days.set(day, [...(days.get(day) ?? []), bucket]);
  }
  return {
    poolId: timeline.poolId,
    allocatable: timeline.allocatable,
    buckets,
    peak,
    days: [...days].map(([day, entries]) => ({ day, buckets: entries })),
  };
}

/**
 * The earliest start (a bucket boundary at or after `notBefore`) where `gpus` are free in every bucket for
 * `durationMs`, or undefined when the timeline shows no such window. Buckets must be contiguous; a gap ends a
 * window. The server still decides: bookings can land between this answer and the request.
 */
export function earliestFit(
  timeline: CapacityTimelineInput,
  gpus: number,
  durationMs: number,
  options: { notBefore?: number } = {},
): number | undefined {
  if (!(gpus > 0) || !(durationMs > 0)) return undefined;
  const buckets = [...timeline.buckets].sort((a, b) => a.start - b.start);
  const notBefore = options.notBefore ?? -Infinity;
  let windowStart: number | undefined;
  let previousEnd: number | undefined;
  for (const bucket of buckets) {
    // A gap between buckets ends the window; this bucket may still start the next one.
    if (bucket.start !== previousEnd) windowStart = undefined;
    previousEnd = bucket.end;
    if (bucket.free < gpus || bucket.start < notBefore) {
      windowStart = undefined;
      continue;
    }
    windowStart ??= bucket.start;
    if (bucket.end - windowStart >= durationMs) return windowStart;
  }
  return undefined;
}

/** `capacity.timeline` for one pool, with its view derived. */
export function createTimelineView(
  api: ComputeRequester,
  options: {
    tenantId: string;
    poolId: string;
    from?: number;
    to?: number;
    stepMinutes?: number;
    busyAt?: number;
  },
): ValueResource<TimelineView & { raw: CapacityTimelineInput }> {
  return createValueResource({
    load: async (signal) => {
      const raw = await api.$request<CapacityTimelineInput>(
        'capacity/timeline',
        {
          tenantId: options.tenantId,
          poolId: options.poolId,
          ...(options.from !== undefined ? { from: options.from } : {}),
          ...(options.to !== undefined ? { to: options.to } : {}),
          ...(options.stepMinutes !== undefined ? { stepMinutes: options.stepMinutes } : {}),
        },
        { signal },
      );
      return {
        ...timelineView(raw, options.busyAt !== undefined ? { busyAt: options.busyAt } : {}),
        raw,
      };
    },
  });
}
