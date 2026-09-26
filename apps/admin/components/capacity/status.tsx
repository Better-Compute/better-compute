'use client';

import { useMemo } from 'react';
import { StatusItem } from '@/components/shell/status-bar';
import { fmtNum, fmtPct } from '@/lib/data/format';
import { usePoolRows } from './data';
import { useInsights } from './insights';
import { fleetTotals } from './model';

// Capacity's readouts in the shell's status bar: free GPUs now, and reservations waiting for capacity.

export function FreeGpusStatus() {
  const { rows } = usePoolRows();
  const totals = useMemo(() => fleetTotals(rows), [rows]);
  return (
    <StatusItem
      label="free"
      value={`${fmtNum(totals.freeNow)} GPUs`}
      tone={totals.allocatable && totals.freeNow / totals.allocatable < 0.05 ? 'signal' : undefined}
      href="/capacity"
      title={`${fmtNum(totals.allocated)} of ${fmtNum(totals.allocatable)} schedulable GPUs allocated (${fmtPct(totals.utilization, 0)})`}
    />
  );
}

export function InsightsStatus() {
  const { visible } = useInsights();
  const critical = visible.filter((insight) => insight.severity === 'critical').length;
  if (!visible.length) return null;
  return (
    <StatusItem
      label="capacity"
      value={critical ? `${critical} critical` : `${visible.length} insight${visible.length === 1 ? '' : 's'}`}
      tone={critical ? 'crit' : 'signal'}
      href="/capacity"
      title={visible.slice(0, 3).map((insight) => insight.title).join('\n')}
    />
  );
}

export function WaitingStatus() {
  const { rows } = usePoolRows();
  const totals = useMemo(() => fleetTotals(rows), [rows]);
  return (
    <StatusItem
      label="waiting"
      value={fmtNum(totals.pending)}
      tone={totals.pending > 0 ? 'signal' : undefined}
      href="/reservations"
      title="Reservations pending capacity or a confirmation"
    />
  );
}
