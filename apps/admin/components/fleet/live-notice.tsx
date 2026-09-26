'use client';

import { useConnection } from '@/components/shell/connection';
import { useNow } from '@/components/shell/workspace';
import { Led } from '@/components/ui/signal';
import { fmtRelative } from '@/lib/data/format';
import { useFleetSource } from './use-fleet';

/** In live mode: when the fleet last answered, and which API groups failed (so empty never reads as "no fleet"). */
export function LiveNotice() {
  const { live, state } = useFleetSource();
  const writable = (useConnection().status as { writable?: boolean } | null | undefined)?.writable === true;
  const now = useNow(5_000);
  if (!live) return null;
  const failed = Object.entries(state.errors);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-separator-border bg-surface-sunken px-3 py-1.5 font-mono text-[11px] text-text-secondary">
      <Led status={failed.some(([group]) => group === 'nodes') ? 'crit' : state.loading ? 'pending' : 'live'} />
      <span>live API{state.fetchedAt ? ` · updated ${fmtRelative(state.fetchedAt, now)}` : state.loading ? ' · loading…' : ''}</span>
      {!writable && <span className="text-signal" title="The live connection forwards reads only until operator sign-in; actions are refused.">read-only</span>}
      {failed.map(([group, error]) => (
        <span key={group} className={group === 'nodes' ? 'text-red-500' : 'text-text-tertiary'} title={error.message}>
          {group}: {error.code}
        </span>
      ))}
    </div>
  );
}
