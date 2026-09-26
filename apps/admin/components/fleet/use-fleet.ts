'use client';

import { useMemo } from 'react';
import { useWorkspace } from '@/components/shell/workspace';
import { scopeFleet, simulateFleet, type FleetSnapshot } from '@/lib/data/fleet';
import { applyActions, useFleetActions } from './store';

/**
 * The fleet as the fleet pages see it: the simulation at the workspace clock, scoped to the workspace's site,
 * with the operator's actions applied. Recomputed on every clock tick (2 s) and after each action.
 */
export function useFleet(options: { scoped?: boolean } = {}): FleetSnapshot {
  const { now, siteId } = useWorkspace();
  const actions = useFleetActions();
  const scoped = options.scoped ?? true;
  return useMemo(() => {
    const snapshot = applyActions(simulateFleet(now), actions);
    return scoped ? scopeFleet(snapshot, siteId) : snapshot;
  }, [now, siteId, actions, scoped]);
}
