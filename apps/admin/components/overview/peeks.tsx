'use client';

import { RiFocus3Line } from 'react-icons/ri';
import { controlPlane, fleetPulse, fmtDuration, fmtNum, fmtPct, siteById } from '@/lib/data';
import { Button } from '@/components/base/buttons/button';
import { EntityLink } from '@/components/shell/peek';
import { useLive, useWorkspace } from '@/components/shell/workspace';
import { Sparkline, StackedBar, TimeSeriesChart } from '@/components/ui/charts';
import { KeyValue, Panel } from '@/components/ui/panel';
import { Led, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';

const health = { ok: 'ok', degraded: 'warn', down: 'crit' } as const;

/** A site at a glance: its pools, nodes, GPUs, power and gateway, with a button to scope the panel to it. */
export function SitePeek({ id }: { id: string }) {
  const site = siteById(id);
  const { siteId, setSiteId } = useWorkspace();
  const pulse = useLive((now) => fleetPulse(now, { siteId: id }), { bucketMs: 10_000, deps: [id] });
  const gateway = useLive((now) => controlPlane(now).find((c) => c.id === `gw-${id}`), { bucketMs: 10_000, deps: [id] });
  if (!site) return <p className="text-text-secondary">No site {id}.</p>;
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        columns={3}
        items={[
          { label: 'City', value: site.city },
          { label: 'Region', value: site.region.toUpperCase(), mono: true },
          { label: 'Provider', value: site.provider, mono: true },
        ]}
      />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Nodes ready" value={pulse.nodes.ready} unit={`/ ${pulse.nodes.total}`} size="sm" />
        <Stat label="GPU util" value={pulse.gpus.total ? fmtPct(pulse.gpuUtilization, 0) : '—'} size="sm" />
        <Stat label="Power" value={fmtNum(pulse.powerKw)} unit="kW" size="sm" />
      </div>
      <Panel title="Pools" flush>
        <ul>
          {pulse.pools.map((p) => (
            <li key={p.pool.id} className="grid grid-cols-[minmax(0,1fr)_40%_auto] items-center gap-3 border-b border-separator-border/70 px-3 py-2 last:border-0">
              <div className="min-w-0">
                <EntityLink kind="pool" id={p.pool.id} href={`/pools/${p.pool.id}`}>{p.pool.name}</EntityLink>
                <div className="truncate font-mono text-[10px] text-text-tertiary">
                  {p.pool.short} · {p.nodes.ready}/{p.pool.nodes} nodes
                </div>
              </div>
              <StackedBar
                height={6}
                total={p.total}
                parts={[
                  { label: 'allocated', value: p.allocated, tone: 'signal' },
                  { label: 'reserved', value: p.reserved, tone: 'neutral' },
                  { label: 'free', value: p.available, tone: 'muted' },
                  { label: 'unschedulable', value: p.unhealthy, tone: 'hatch' },
                ]}
              />
              <span className="w-12 text-right font-mono text-[11px] tabular-nums">{fmtPct(p.utilization, 0)}</span>
            </li>
          ))}
        </ul>
      </Panel>
      {gateway && (
        <Panel title="Gateway">
          <div className="flex items-center gap-3">
            <Led status={health[gateway.status]} />
            <span className="font-mono text-[12px]">{gateway.name}</span>
            <Sparkline className="flex-1" values={gateway.series} height={20} area={false} tone="neutral" />
            <span className="font-mono text-[12px] tabular-nums">{fmtDuration(gateway.latencyMs)}</span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-text-tertiary">{gateway.detail}</p>
        </Panel>
      )}
      <Button variant={siteId === id ? 'secondary' : 'primary'} size="small" leadingIcon={RiFocus3Line} onClick={() => setSiteId(siteId === id ? undefined : id)}>
        {siteId === id ? 'Clear site scope' : `Scope the panel to ${id}`}
      </Button>
    </div>
  );
}

/** One control-plane component: status, 30-minute latency and what it is doing. */
export function ComponentPeek({ id }: { id: string }) {
  const { now } = useWorkspace();
  const component = useLive((t) => controlPlane(t).find((c) => c.id === id), { bucketMs: 5_000, deps: [id] });
  if (!component) return <p className="text-text-secondary">No component {id}.</p>;
  const times = component.series.map((_, i) => Math.floor(now / 60_000) * 60_000 - (component.series.length - 1 - i) * 60_000);
  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        items={[
          { label: 'Status', value: <Tag status={health[component.status]}>{component.status}</Tag> },
          { label: 'Kind', value: component.kind, mono: true },
          { label: 'Latency', value: fmtDuration(component.latencyMs), mono: true },
          { label: 'Throughput', value: `${fmtNum(component.rate)} ${component.rateUnit}`, mono: true },
        ]}
      />
      <p className="font-mono text-[12px] text-text-secondary">{component.detail}</p>
      <Panel title="Last 30 minutes">
        <TimeSeriesChart times={times} height={180} series={[{ id: 'l', label: 'latency', values: component.series, tone: 'signal', area: true }]} yFormat={(v) => fmtDuration(v)} />
      </Panel>
    </div>
  );
}
