'use client';

import { useConnection } from '@/components/shell/connection';
import { useWorkspaceSettings } from '@/components/shell/workspace';
import { useLiveProviders, type ProviderLiveState } from './live';

/** The provider module's live state; the simulation has no provider accounts, so `live` is false there. */
export function useProviders(): { live: boolean; state: ProviderLiveState } {
  const { source } = useWorkspaceSettings();
  const connection = useConnection();
  const live = source === 'live';
  return { live, state: useLiveProviders(live, connection.status?.tenantId) };
}
