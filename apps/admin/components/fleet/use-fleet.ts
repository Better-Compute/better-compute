'use client';

import { useMemo } from 'react';
import { useConnection } from '@/components/shell/connection';
import { useNow, useWorkspaceSettings } from '@/components/shell/workspace';
import { scopeFleet, simulateFleet, type FleetSnapshot } from '@/lib/data/fleet';
import { liveSnapshot } from '@/lib/data/fleet-live';
import { useLiveFleet, type LiveState } from './live';
import { applyActions, useFleetActions } from './store';

/**
 * The fleet as the fleet pages see it. Simulated: the simulation at the workspace clock with the operator's
 * actions laid over it. Live (Settings → Connection): the API's answers, refreshed every 15 s; actions go to the
 * API instead (commands.tsx). Either way scoped to the workspace's site.
 */
export function useFleet(options: { scoped?: boolean; bucketMs?: number } = {}): FleetSnapshot {
  const now = useNow(options.bucketMs ?? 5_000);
  const { siteId, source } = useWorkspaceSettings();
  const connection = useConnection();
  const actions = useFleetActions();
  const live = source === 'live';
  const liveState = useLiveFleet(live, connection.status?.tenantId);
  const scoped = options.scoped ?? true;
  return useMemo(() => {
    const snapshot = live && liveState.parts ? liveSnapshot(liveState.parts, now) : applyActions(simulateFleet(now), actions);
    return scoped ? scopeFleet(snapshot, siteId) : snapshot;
  }, [now, siteId, actions, scoped, live, liveState.parts]);
}

/** Live-mode fetch state for banners: which API groups failed, when it last answered. */
export function useFleetSource(): { live: boolean; state: LiveState } {
  const { source } = useWorkspaceSettings();
  const connection = useConnection();
  const live = source === 'live';
  return { live, state: useLiveFleet(live, connection.status?.tenantId) };
}
