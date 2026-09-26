'use client';

import { RiRefreshLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { useWorkspace } from '@/components/shell/workspace';
import { Led, SeverityIcon } from '@/components/ui/signal';
import { fmtRelative } from '@/lib/data/format';
import { useCapacity, useCapacityStatus } from './data';

/**
 * In live mode, says where capacity data stands: loading, refused (with the API's reason and a way back to the
 * simulation), empty for this tenant, or fresh. Renders nothing for simulated data.
 */
export function SourceNotice() {
  const status = useCapacityStatus();
  const snapshot = useCapacity();
  const { setDataSource, wallNow } = useWorkspace();
  if (status.mode !== 'live') return null;
  if (status.error)
    return (
      <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 border border-red-500/40 bg-red-500/10 px-3 py-2">
        <SeverityIcon severity="critical" />
        <span className="min-w-0 flex-1 text-caption-1-regular text-text-primary">
          The compute API didn't answer the capacity calls: <span className="font-mono">{status.error}</span>
          {status.loadedAt ? ` Showing data from ${fmtRelative(status.loadedAt, wallNow)}.` : ''}
        </span>
        <Button size="xs" variant="secondary" onClick={() => setDataSource('simulated')}>
          Use the simulation
        </Button>
      </div>
    );
  if (!status.loadedAt)
    return (
      <div className="mb-3 flex items-center gap-2 border border-separator-border px-3 py-2 font-mono text-[11px] text-text-secondary">
        <RiRefreshLine className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> loading capacity from the compute API…
      </div>
    );
  if (!snapshot.pools.length)
    return (
      <div className="mb-3 flex items-center gap-2 border border-separator-border px-3 py-2 text-caption-1-regular text-text-secondary">
        <Led status="off" /> The API answered, but this tenant owns or is offered no pools yet.
      </div>
    );
  return (
    <div className="mb-3 flex items-center gap-2 font-mono text-[11px] text-text-tertiary">
      <Led status="live" /> live · updated {fmtRelative(status.loadedAt, wallNow)} · refreshes every 15 s
    </div>
  );
}
