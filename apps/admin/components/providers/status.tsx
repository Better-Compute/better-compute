'use client';

import { StatusItem } from '@/components/shell/status-bar';
import { useNow } from '@/components/shell/workspace';
import { providerAttention, providersHref } from './attention';
import { useProviders } from './use-providers';

// Status-bar readout in live mode: what the provider accounts need (findings and billing leaks). Subscribing here
// also keeps the poller running, so the attention queue has the provider items on every page.

export function ProvidersStatus() {
  const { live, state } = useProviders();
  const now = useNow(10_000);
  if (!live || !state.parts) return null;
  const items = providerAttention(state.parts, now);
  const urgent = items.filter((item) => item.severity !== 'info').length;
  return (
    <StatusItem
      label="providers"
      value={urgent ? `${urgent} to look at` : `${state.parts.accounts.length} accounts`}
      {...(urgent ? { tone: 'signal' as const } : {})}
      href={providersHref}
      title={urgent ? `${urgent} warnings or worse on provider accounts` : 'no provider findings or leaks'}
    />
  );
}
