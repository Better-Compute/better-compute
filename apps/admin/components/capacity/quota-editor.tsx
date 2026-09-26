'use client';

import { useEffect, useMemo, useState } from 'react';
import { RiSave3Line } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { Meter } from '@/components/ui/charts';
import { Drawer } from '@/components/ui/overlay';
import { SeverityIcon } from '@/components/ui/signal';
import { fmtNum, fmtPct } from '@/lib/data/format';
import { useCapacity, useCapacityActions, useTenantName } from './data';
import { ReadOnlyHint } from './ui';

export interface QuotaTarget {
  tenantId: string;
  poolId: string;
  resource: string;
}

const unitOf = (resource: string) => (resource === 'gpu' ? 'GPUs' : resource === 'vcpu' ? 'vCPUs' : resource === 'memoryGiB' ? 'GiB' : resource);

/** Edit one tenant's maximum for one resource in one pool (quotas.set), with the impact shown before saving. */
export function QuotaEditor({ target, onClose }: { target?: QuotaTarget; onClose(): void }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const actions = useCapacityActions();
  const row = useMemo(
    () => (target ? snapshot.quotas.find((q) => q.tenantId === target.tenantId && q.poolId === target.poolId && q.resource === target.resource) : undefined),
    [snapshot, target],
  );
  const capacity = useMemo(() => {
    if (!target) return 0;
    const pool = snapshot.summary.pools.find((entry) => entry.poolId === target.poolId);
    return pool?.capacity.find((entry) => entry.resource === target.resource)?.total ?? 0;
  }, [snapshot, target]);
  const [value, setValue] = useState(0);
  useEffect(() => setValue(row?.max ?? 0), [row?.max, target?.tenantId, target?.poolId, target?.resource]);

  if (!target) return null;
  const used = row?.used ?? 0;
  const max = row?.max ?? 0;
  const ceiling = Math.max(capacity, max, used, 8);
  const step = target.resource === 'gpu' ? 1 : target.resource === 'vcpu' ? 8 : 64;
  const others = snapshot.quotas.filter((q) => q.poolId === target.poolId && q.resource === target.resource && q.tenantId !== target.tenantId && q.tenantId !== snapshot.tenantId);
  const committed = others.reduce((total, q) => total + q.max, 0) + value;
  const unit = unitOf(target.resource);

  return (
    <Drawer
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) {
          actions.reset();
          onClose();
        }
      }}
      title={`Quota · ${tenantName(target.tenantId)}`}
      subtitle={`${target.poolId} · ${target.resource}`}
      width={480}
    >
      <div className="flex flex-col gap-5">
        <Meter value={used} max={max} label="In use now" detail={`${fmtNum(used)} / ${fmtNum(max)} ${unit}`} />
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">New maximum</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={ceiling}
              step={step}
              value={value}
              onChange={(event) => setValue(Number(event.target.value))}
              className="flex-1 accent-[var(--color-signal-fill)]"
              aria-label="New maximum"
            />
            <input
              type="number"
              min={0}
              step={step}
              value={value}
              onChange={(event) => setValue(Math.max(0, Math.round(Number(event.target.value) || 0)))}
              className="h-8 w-24 border border-border-button-default bg-background-primary-default px-2 text-right font-mono text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            />
            <span className="font-mono text-[12px] text-text-tertiary">{unit}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[0.5, 1, 1.5, 2].map((factor) => (
              <button
                key={factor}
                type="button"
                onClick={() => setValue(Math.round((max * factor) / step) * step)}
                className="border border-separator-border px-1.5 py-0.5 font-mono text-[11px] text-text-secondary hover:border-separator-border-strong hover:text-text-primary"
              >
                ×{factor}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setValue(Math.ceil(used / step) * step)}
              className="border border-separator-border px-1.5 py-0.5 font-mono text-[11px] text-text-secondary hover:border-separator-border-strong hover:text-text-primary"
            >
              = in use
            </button>
          </div>
        </label>

        <dl className="grid grid-cols-2 gap-3 border border-separator-border p-3 font-mono text-[12px]">
          <dt className="text-text-tertiary">change</dt>
          <dd className="text-right tabular-nums">
            {value >= max ? '+' : '−'}
            {fmtNum(Math.abs(value - max))} {unit}
          </dd>
          <dt className="text-text-tertiary">use after</dt>
          <dd className="text-right tabular-nums">{value > 0 ? fmtPct(used / value, 0) : '—'}</dd>
          <dt className="text-text-tertiary">pool size</dt>
          <dd className="text-right tabular-nums">
            {fmtNum(capacity)} {unit}
          </dd>
          <dt className="text-text-tertiary">all tenants' max</dt>
          <dd className="text-right tabular-nums">
            {fmtNum(committed)} ({capacity ? fmtPct(committed / capacity, 0) : '—'} of pool)
          </dd>
        </dl>

        {value < used && (
          <p className="flex gap-2 border border-signal-fill/50 bg-signal-soft px-3 py-2 text-caption-1-regular text-text-primary">
            <SeverityIcon severity="warning" />
            Below what the tenant uses now. Nothing is evicted: running reservations keep their devices, and new ones fail
            with QUOTA_EXCEEDED until use drops under {fmtNum(value)}.
          </p>
        )}
        {capacity > 0 && committed > capacity && value > max && (
          <p className="flex gap-2 border border-separator-border px-3 py-2 text-caption-1-regular text-text-secondary">
            <SeverityIcon severity="info" />
            Tenants' maximums add up to more than the pool holds. That's normal (quotas are ceilings, not
            guarantees), but reservations can then wait in pending.
          </p>
        )}
        {actions.state.error && (
          <p className="flex gap-2 border border-red-500/40 bg-red-500/10 px-3 py-2 text-caption-1-regular text-text-error-primary">
            <SeverityIcon severity="critical" /> {actions.state.error}
          </p>
        )}
        {actions.state.done && <p className="font-mono text-[11px] text-text-secondary">✓ Saved: quotas.set {target.resource} = {fmtNum(max)}</p>}

        <div className="flex items-center gap-2">
          <Button
            size="small"
            leadingIcon={RiSave3Line}
            disabled={value === max || actions.state.busy || !actions.live}
            onClick={() => void actions.setQuota({ tenantId: target.tenantId, poolId: target.poolId, resource: target.resource, max: value, current: max })}
          >
            Save maximum
          </Button>
          {actions.readOnly ? <ReadOnlyHint reason={actions.readOnly} /> : <span className="font-mono text-[11px] text-text-tertiary">quotas.set · takes effect on the next admission</span>}
        </div>
      </div>
    </Drawer>
  );
}
