'use client';

import { useEffect, useMemo } from 'react';
import { parseDuration } from 'better-compute/core';
import { createTimelineView, earliestFit } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from './console-provider';

const hour = 3_600_000;

/**
 * "Earliest start" for a reservation being drafted: the pool's next 7 days (`capacity.timeline`) searched for
 * `gpus` free for `duration`. A hint only; the scheduler decides when the request is placed.
 */
export function EarliestStart({
  poolId,
  gpus,
  duration,
}: {
  poolId?: string | undefined;
  gpus?: number | undefined;
  duration?: string | undefined;
}) {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => {
    if (!poolId) return undefined;
    const from = Math.floor(Date.now() / hour) * hour;
    return createTimelineView(api, { tenantId, poolId, from, to: from + 7 * 24 * hour });
  }, [api, tenantId, poolId]);
  useEffect(() => {
    if (view) void view.refresh();
  }, [view]);
  const state = useStore(view ?? idle);

  let durationMs: number | undefined;
  try {
    durationMs = duration ? parseDuration(duration) : undefined;
  } catch {
    durationMs = undefined;
  }
  if (!view || !gpus || !durationMs || state.status !== 'ready' || !state.value) return null;
  if (durationMs > 7 * 24 * hour) return null;
  const start = earliestFit(state.value.raw, gpus, durationMs, { notBefore: Date.now() - hour });
  return (
    <p className="muted">
      {start === undefined
        ? 'The calendar shows no free window in the next 7 days.'
        : start <= Date.now()
          ? 'The calendar has room now.'
          : `Earliest free window: ${new Date(start).toLocaleString()}.`}
    </p>
  );
}

// A store that never changes, for hooks that must be called unconditionally.
const idle = {
  get: () => idleState,
  subscribe: () => () => undefined,
};
const idleState = { status: 'idle' as const, value: undefined };
