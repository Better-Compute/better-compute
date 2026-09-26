'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiEqualizerLine, RiScales3Line } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { usePageCommands } from '@/components/shell/page-commands';
import { EmptyState, Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { fmtGiB, fmtNum, fmtPct } from '@/lib/data/format';
import { cx } from '@/utils/cx';
import { useCapacity, useCapacityActions, usePoolRows, useTenantName } from '../data';
import { SourceNotice } from '../source-notice';
import { quotaCells, quotaSuggestions, type QuotaCell } from '../model';
import { QuotaEditor, type QuotaTarget } from '../quota-editor';
import { Segmented } from '../ui';

type Resource = 'gpu' | 'vcpu' | 'memoryGiB';
const RESOURCES: { id: Resource; label: string }[] = [
  { id: 'gpu', label: 'GPUs' },
  { id: 'vcpu', label: 'vCPUs' },
  { id: 'memoryGiB', label: 'Memory' },
];

const fmtAmount = (resource: Resource, value: number) => (resource === 'memoryGiB' ? fmtGiB(value) : fmtNum(value, { short: true }));

function CellMeter({ cell, resource, onEdit }: { cell: QuotaCell; resource: Resource; onEdit(): void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="group flex w-full flex-col gap-1 px-2 py-1.5 text-left outline-none hover:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      aria-label={`Edit quota: ${fmtAmount(resource, cell.used)} of ${fmtAmount(resource, cell.max)}`}
    >
      <span className="flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums">
        <span className={cx(cell.level === 'full' ? 'text-text-error-primary' : cell.level === 'warning' ? 'text-signal' : 'text-text-primary')}>{fmtAmount(resource, cell.used)}</span>
        <span className="text-text-tertiary">/ {fmtAmount(resource, cell.max)}</span>
      </span>
      <span className="block h-1 w-full bg-background-secondary-default">
        <span
          className="block h-full"
          style={{
            width: `${cell.ratio * 100}%`,
            background: cell.level === 'full' ? 'var(--color-red-500)' : cell.level === 'warning' ? 'var(--color-signal-fill)' : 'var(--color-text-tertiary)',
          }}
        />
      </span>
    </button>
  );
}

/** GPU quota right-sizing from the last 30 days of bookings, each with a one-click (confirmed) apply. */
function Suggestions({ inScope, onEdit }: { inScope: ReadonlySet<string>; onEdit(target: QuotaTarget): void }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const actions = useCapacityActions();
  const list = useMemo(() => quotaSuggestions(snapshot).filter((entry) => inScope.has(entry.poolId)), [snapshot, inScope]);
  return (
    <Panel className="col-span-12" title="Right-sizing" icon={RiEqualizerLine} meta="GPU quotas vs the 30-day peak" flush>
      {list.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-body-regular">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                <th className="px-3 py-2 text-left font-normal">Tenant · pool</th>
                <th className="px-3 py-2 text-left font-normal">Peak vs ceiling</th>
                <th className="px-3 py-2 text-right font-normal">Now</th>
                <th className="px-3 py-2 text-right font-normal">Suggest</th>
                <th className="px-3 py-2 text-left font-normal">Why</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => (
                <tr key={`${entry.tenantId}:${entry.poolId}`} className="border-b border-separator-border last:border-0">
                  <td className="px-3 py-1.5">
                    <span className="text-body-medium">{tenantName(entry.tenantId)}</span>
                    <span className="ml-2 font-mono text-[11px] text-text-tertiary">{entry.poolId}</span>
                  </td>
                  <td className="w-56 px-3 py-1.5">
                    <div className="relative h-2 bg-background-secondary-default" title={`peak ${entry.peak} of ${entry.max}`}>
                      <div className="h-full bg-text-tertiary/70" style={{ width: `${Math.min(1, entry.peak / Math.max(entry.max, entry.suggested)) * 100}%` }} />
                      <span className="absolute top-[-2px] h-3 w-0.5 bg-text-primary" style={{ left: `${(entry.max / Math.max(entry.max, entry.suggested)) * 100}%` }} />
                      <span className="absolute top-[-2px] h-3 w-0.5 bg-signal-fill" style={{ left: `calc(${(entry.suggested / Math.max(entry.max, entry.suggested)) * 100}% - 2px)` }} />
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
                    {fmtNum(entry.peak)} / {fmtNum(entry.max)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
                    <span className={entry.direction === 'raise' ? 'text-signal' : 'text-text-primary'}>
                      {entry.direction === 'raise' ? '↑' : '↓'} {fmtNum(entry.suggested)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-caption-1-regular text-text-secondary">{entry.reason}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button type="button" className="mr-3 font-mono text-[11px] text-text-tertiary hover:text-text-primary" onClick={() => onEdit({ tenantId: entry.tenantId, poolId: entry.poolId, resource: 'gpu' })}>
                      edit
                    </button>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={actions.state.busy || !actions.live}
                      onClick={() => void actions.setQuota({ tenantId: entry.tenantId, poolId: entry.poolId, resource: 'gpu', max: entry.suggested, current: entry.max })}
                    >
                      Apply
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Every GPU quota fits its use" className="py-6">
          No ceiling sat mostly idle, and none was reached, in the last 30 days.
        </EmptyState>
      )}
      <p className="px-3 py-2 font-mono text-[10px] text-text-tertiary">bar: 30-day peak · white tick: today's ceiling · amber tick: the suggestion (whole 8-GPU nodes)</p>
    </Panel>
  );
}

/** Tenant × pool quota matrix (quotas.get / quotas.set): who may use how much, how much they use, where it's tight. */
export function QuotasPage() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const [resource, setResource] = useState<Resource>((search.get('resource') as Resource) ?? 'gpu');
  const [target, setTarget] = useState<QuotaTarget | undefined>();
  const focusTenant = search.get('tenant') ?? undefined;
  const [hideOperator, setHideOperator] = useState(true);

  usePageCommands(
    useMemo(
      () => [
        ...RESOURCES.map((entry) => ({ id: `quotas.resource.${entry.id}`, label: `Show ${entry.label} quotas`, group: 'This page', run: () => setResource(entry.id) })),
        { id: 'quotas.operator', label: 'Show or hide the operator row', group: 'This page', run: () => setHideOperator((value) => !value) },
      ],
      [],
    ),
  );
  const cells = useMemo(() => quotaCells(snapshot.quotas.filter((row) => row.resource === resource)), [snapshot, resource]);
  const pools = useMemo(() => rows.filter((row) => cells.some((cell) => cell.poolId === row.id)), [rows, cells]);
  const tenants = useMemo(() => {
    const ids = [...new Set(cells.filter((cell) => pools.some((pool) => pool.id === cell.poolId)).map((cell) => cell.tenantId))];
    return ids
      .filter((id) => !hideOperator || id !== snapshot.tenantId || focusTenant === id)
      .sort((a, b) => (a === focusTenant ? -1 : b === focusTenant ? 1 : tenantName(a).localeCompare(tenantName(b))));
  }, [cells, pools, hideOperator, snapshot.tenantId, focusTenant, tenantName]);
  const cellOf = (tenantId: string, poolId: string) => cells.find((cell) => cell.tenantId === tenantId && cell.poolId === poolId);
  const alerts = useMemo(
    () => cells.filter((cell) => cell.level !== 'ok' && cell.tenantId !== snapshot.tenantId && pools.some((pool) => pool.id === cell.poolId)).sort((a, b) => b.ratio - a.ratio),
    [cells, pools, snapshot.tenantId],
  );

  const committed = (poolId: string) => {
    const offered = cells.filter((cell) => cell.poolId === poolId && cell.tenantId !== snapshot.tenantId).reduce((total, cell) => total + cell.max, 0);
    const size = snapshot.summary.pools.find((entry) => entry.poolId === poolId)?.capacity.find((entry) => entry.resource === resource)?.total ?? 0;
    return { offered, size, ratio: size ? offered / size : 0 };
  };

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiScales3Line}
        title="Quotas"
        description="Every tenant's ceiling per pool and resource, and how much of it is in use. Quotas are ceilings, not guarantees: tenants' maximums may add up to more than a pool holds. Click a cell to change it."
        meta={
          <>
            {alerts.length > 0 && <Tag status="warn">{alerts.length} at ≥80%</Tag>}
            {focusTenant && (
              <Tag status="live">
                {tenantName(focusTenant)}
                <button
                  type="button"
                  aria-label="Clear tenant focus"
                  className="ml-1 text-text-tertiary hover:text-text-primary"
                  onClick={() => router.replace(pathname)}
                >
                  ×
                </button>
              </Tag>
            )}
          </>
        }
        actions={
          <>
            <label className="flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
              <input type="checkbox" checked={hideOperator} onChange={(event) => setHideOperator(event.target.checked)} className="accent-[var(--color-signal-fill)]" />
              hide operator
            </label>
            <Segmented label="Resource" value={resource} onChange={(value) => setResource(value as Resource)} options={RESOURCES} />
          </>
        }
      />
      <Grid>
        <Panel className="col-span-12 xl:col-span-9" title="Tenants × pools" meta={RESOURCES.find((entry) => entry.id === resource)?.label} flush>
          {pools.length && tenants.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-body-regular">
                <thead>
                  <tr className="border-b border-separator-border">
                    <th className="sticky left-0 z-10 min-w-44 bg-surface-raised px-3 py-2 text-left font-mono text-[11px] font-normal tracking-wide text-text-tertiary uppercase">Tenant</th>
                    {pools.map((pool) => (
                      <th key={pool.id} className="min-w-32 border-l border-separator-border px-2 py-2 text-left font-normal">
                        <Link href={`/pools/${pool.id}?tab=tenants`} className="block truncate font-mono text-[11px] text-text-primary hover:underline">
                          {pool.short} · {pool.siteId}
                        </Link>
                        <span className="block truncate text-caption-2-regular text-text-tertiary">{pool.name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tenantId) => (
                    <tr key={tenantId} className={cx('border-b border-separator-border', tenantId === focusTenant && 'bg-signal-soft')}>
                      <th scope="row" className={cx('sticky left-0 z-10 px-3 py-1 text-left font-normal', tenantId === focusTenant ? 'bg-signal-soft' : 'bg-surface-raised')}>
                        <Link href={`/quotas?tenant=${tenantId}&resource=${resource}`} className="text-body-medium hover:underline">
                          {tenantName(tenantId)}
                        </Link>
                      </th>
                      {pools.map((pool) => {
                        const cell = cellOf(tenantId, pool.id);
                        return (
                          <td key={pool.id} className="border-l border-separator-border p-0">
                            {cell ? (
                              <CellMeter cell={cell} resource={resource} onEdit={() => setTarget({ tenantId, poolId: pool.id, resource })} />
                            ) : (
                              <span className="block px-2 py-1.5 text-center font-mono text-[11px] text-text-tertiary/60" title="Not offered to this tenant">
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th className="sticky left-0 z-10 bg-surface-sunken px-3 py-2 text-left font-mono text-[11px] font-normal text-text-tertiary">offered ÷ pool size</th>
                    {pools.map((pool) => {
                      const c = committed(pool.id);
                      return (
                        <td key={pool.id} className="border-l border-separator-border bg-surface-sunken px-2 py-2 font-mono text-[11px] tabular-nums">
                          <span className={cx(c.ratio > 1 ? 'text-signal' : 'text-text-secondary')}>{fmtPct(c.ratio, 0)}</span>
                          <span className="text-text-tertiary"> of {fmtAmount(resource, c.size)}</span>
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <EmptyState title="No quota rows for this resource in scope" />
          )}
        </Panel>
        <Panel className="col-span-12 xl:col-span-3" title="Near or at the ceiling" meta={`${alerts.length}`} flush>
          {alerts.length ? (
            <ul className="max-h-[560px] overflow-y-auto">
              {alerts.map((cell) => (
                <li key={`${cell.tenantId}:${cell.poolId}`} className="border-b border-separator-border last:border-0">
                  <button
                    type="button"
                    className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-background-secondary-default"
                    onClick={() => setTarget({ tenantId: cell.tenantId, poolId: cell.poolId, resource })}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-caption-1-medium">{tenantName(cell.tenantId)}</span>
                      <Tag status={cell.level === 'full' ? 'crit' : 'warn'}>{fmtPct(cell.ratio, 0)}</Tag>
                    </span>
                    <span className="font-mono text-[11px] text-text-tertiary">
                      {cell.poolId} · {fmtAmount(resource, cell.used)} / {fmtAmount(resource, cell.max)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Everyone has headroom" />
          )}
        </Panel>
        {resource === 'gpu' && <Suggestions inScope={new Set(pools.map((pool) => pool.id))} onEdit={setTarget} />}
      </Grid>
      <QuotaEditor target={target} onClose={() => setTarget(undefined)} />
    </>
  );
}
