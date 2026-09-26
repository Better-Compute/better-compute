'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { fmtMoney, fmtNum, fmtPct } from '@/lib/data/format';
import { DAY, reservationGpus, type CapacitySnapshot } from '@/lib/data/capacity';
import { poolById } from '@/lib/data/topology';
import { usePoolRows } from './data';

// Spot capacity: GPUs lent at a discount that regular work can take back with notice. Per pool: what runs on spot
// now, what is under notice, and what spot saved tenants over 30 days (list price vs the spot rate).

export const SPOT_RATE = 0.4;

export interface SpotRow {
  poolId: string;
  name: string;
  gpusNow: number;
  shareOfAllocated: number;
  underNotice: number;
  gpuHours30: number;
  savings30: number;
}

export function spotRows(snapshot: CapacitySnapshot, inScope: ReadonlySet<string>, allocatedByPool: ReadonlyMap<string, number>): SpotRow[] {
  const from = snapshot.now - 30 * DAY;
  const rows = new Map<string, SpotRow>();
  const row = (poolId: string) => {
    let entry = rows.get(poolId);
    if (!entry) rows.set(poolId, (entry = { poolId, name: poolById(poolId)?.name ?? poolId, gpusNow: 0, shareOfAllocated: 0, underNotice: 0, gpuHours30: 0, savings30: 0 }));
    return entry;
  };
  for (const r of snapshot.reservations) {
    if (!r.request.spot || !inScope.has(r.poolId)) continue;
    if (r.state === 'active' || r.state === 'binding') {
      const entry = row(r.poolId);
      entry.gpusNow += reservationGpus(r);
      if (r.conditions.some((condition) => condition.type === 'PreemptionNotice')) entry.underNotice += 1;
    }
  }
  for (const window of snapshot.usage) {
    if (window.tags.spot !== 'true' || window.windowStart < from || !window.meter.startsWith('gpu.')) continue;
    const poolId = window.tags.poolId ?? '';
    if (!inScope.has(poolId)) continue;
    const entry = row(poolId);
    // Spot windows are metered at the spot rate: list-price hours = quantity / rate.
    const listHours = window.quantity / SPOT_RATE;
    entry.gpuHours30 += listHours;
    entry.savings30 += (listHours - window.quantity) * (snapshot.prices[window.meter] ?? 0);
  }
  for (const entry of rows.values()) {
    const allocated = allocatedByPool.get(entry.poolId) ?? 0;
    entry.shareOfAllocated = allocated ? entry.gpusNow / allocated : 0;
  }
  return [...rows.values()].sort((a, b) => b.gpusNow - a.gpusNow || b.gpuHours30 - a.gpuHours30);
}

export function useSpotRows() {
  const { snapshot, rows } = usePoolRows();
  return useMemo(() => {
    const inScope = new Set(rows.map((entry) => entry.id));
    const allocated = new Map(rows.map((entry) => [entry.id, entry.allocated]));
    return spotRows(snapshot, inScope, allocated);
  }, [snapshot, rows]);
}

/** Spot per pool as a compact list (widget and Usage page). */
export function SpotList({ limit }: { limit?: number }) {
  const list = useSpotRows();
  if (!list.length) return <EmptyState title="No spot work in scope" />;
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <table className="w-full text-body-regular">
      <thead>
        <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
          <th className="px-3 py-2 text-left font-normal">Pool</th>
          <th className="px-3 py-2 text-right font-normal">On spot now</th>
          <th className="px-3 py-2 text-right font-normal">Notice</th>
          <th className="px-3 py-2 text-right font-normal">Saved, 30 d</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((entry) => (
          <tr key={entry.poolId} className="border-b border-separator-border last:border-0">
            <td className="px-3 py-1.5">
              <Link href={`/pools/${entry.poolId}`} className="text-caption-1-medium hover:underline">
                {entry.name}
              </Link>
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
              {fmtNum(entry.gpusNow)} <span className="text-text-tertiary">({fmtPct(entry.shareOfAllocated, 0)})</span>
            </td>
            <td className="px-3 py-1.5 text-right">{entry.underNotice ? <Tag status="warn">{entry.underNotice}</Tag> : <span className="font-mono text-[12px] text-text-tertiary">0</span>}</td>
            <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.savings30, { short: true })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
