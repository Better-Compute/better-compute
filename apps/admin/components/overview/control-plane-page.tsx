'use client';

import { useMemo, useState } from 'react';
import { RiServerLine } from 'react-icons/ri';
import { controlPlane, fmtDuration, fmtNum, MINUTE, siteById, type ControlPlaneComponent } from '@/lib/data';
import { useLive, useWorkspace } from '@/components/shell/workspace';
import { TimeSeriesChart, Sparkline } from '@/components/ui/charts';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Drawer } from '@/components/ui/overlay';
import { Grid, KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { LiveVitals } from './live-vitals';

const status = { ok: 'ok', degraded: 'warn', down: 'crit' } as const;

export function ControlPlanePage() {
  const components = useLive((now) => controlPlane(now), { bucketMs: 5_000 });
  const { now } = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = components.find((c) => c.id === openId) ?? null;
  const degraded = components.filter((c) => c.status !== 'ok');
  const api = components.find((c) => c.id === 'api')!;
  const db = components.find((c) => c.id === 'db')!;
  const workers = components.find((c) => c.id === 'workers')!;
  const gateways = components.filter((c) => c.kind === 'gateway');
  const times = useMemo(() => Array.from({ length: 30 }, (_, i) => Math.floor(now / MINUTE) * MINUTE - (29 - i) * MINUTE), [now]);

  const columns: Column<ControlPlaneComponent>[] = [
    { id: 'status', header: '', width: 28, pinned: true, cell: (c) => <Led status={status[c.status]} label={c.status} /> },
    { id: 'name', header: 'Component', pinned: true, value: (c) => c.name, cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: 'kind', header: 'Kind', value: (c) => c.kind, cell: (c) => <Mono dim>{c.kind}</Mono> },
    { id: 'site', header: 'Site', value: (c) => c.siteId ?? 'global', cell: (c) => <Mono dim>{c.siteId ? `${c.siteId} · ${siteById(c.siteId)?.city}` : 'global'}</Mono> },
    { id: 'latency', header: 'Latency', align: 'right', value: (c) => c.latencyMs, cell: (c) => <Mono className={c.status === 'ok' ? undefined : 'text-signal'}>{fmtDuration(c.latencyMs)}</Mono> },
    { id: 'trend', header: '30 min', width: 120, cell: (c) => <Sparkline values={c.series} height={20} area={false} tone={c.status === 'ok' ? 'neutral' : 'signal'} /> },
    { id: 'rate', header: 'Throughput', align: 'right', value: (c) => c.rate, cell: (c) => <Mono>{fmtNum(c.rate)} <span className="text-text-tertiary">{c.rateUnit}</span></Mono> },
    { id: 'detail', header: 'Detail', value: (c) => c.detail, cell: (c) => <span className="text-text-secondary">{c.detail}</span> },
  ];

  return (
    <>
      <PageHeader
        icon={RiServerLine}
        title="Control plane"
        description="The API, the better-iam bridge, the database, reconcile workers, the event outbox and one gateway per site. Latency is p99 (API, IAM, gateways), replica lag (database), oldest job (workers) and cursor lag (outbox)."
        meta={degraded.length ? <Tag status="warn">{degraded.length} degraded</Tag> : <Tag status="live">all nominal</Tag>}
      />
      <Grid>
        <LiveVitals />
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="API p99" meta="req/s">
          <Stat label="latency" value={fmtDuration(api.latencyMs)} hint={`${fmtNum(api.rate)} req/s`} trend={api.series} />
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="Database">
          <Stat label="replica lag" value={fmtDuration(db.latencyMs)} hint={db.detail} trend={db.series} tone="neutral" />
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="Workers">
          <Stat label="oldest job" value={fmtDuration(workers.latencyMs)} hint={workers.detail} trend={workers.series} tone="neutral" />
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="Gateways">
          <Stat
            label="daemon sessions"
            value={fmtNum(gateways.reduce((s, g) => s + g.rate, 0))}
            hint={`${gateways.length} gateways · ${gateways.filter((g) => g.status !== 'ok').length} degraded`}
          />
        </Panel>
        <Panel className="col-span-12 xl:col-span-8" title="Latency, last 30 minutes" meta="ms">
          <TimeSeriesChart
            times={times}
            height={220}
            yFormat={(v) => `${Math.round(v)}`}
            series={[
              { id: 'api', label: 'API p99', values: api.series, tone: 'signal', area: true },
              { id: 'db', label: 'DB lag', values: db.series, tone: 'neutral' },
              ...gateways.slice(0, 1).map((g) => ({ id: g.id, label: g.name, values: g.series, tone: 'muted' as const, dashed: true })),
            ]}
          />
        </Panel>
        <Panel className="col-span-12 xl:col-span-4" title="Gateways by site">
          <ul className="flex flex-col gap-2">
            {gateways.map((g) => (
              <li key={g.id} className="flex items-center gap-3">
                <Led status={status[g.status]} />
                <span className="w-16 font-mono text-[12px]">{g.siteId}</span>
                <Sparkline className="flex-1" values={g.series} height={18} area={false} tone={g.status === 'ok' ? 'neutral' : 'signal'} />
                <Mono className="w-14 text-right">{fmtDuration(g.latencyMs)}</Mono>
                <Mono dim className="w-16 text-right">{g.rate} str</Mono>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel className="col-span-12" title="Components" flush>
          <DataTable rows={components} columns={columns} rowId={(c) => c.id} onRowClick={(c) => setOpenId(c.id)} activeId={openId ?? undefined} exportName="control-plane" initialSort={{ id: 'latency', dir: 'desc' }} />
        </Panel>
      </Grid>
      <Drawer open={Boolean(open)} onOpenChange={(o) => !o && setOpenId(null)} title={open?.name ?? ''} subtitle={open?.detail}>
        {open && (
          <div className="flex flex-col gap-5">
            <KeyValue
              items={[
                { label: 'Status', value: <Tag status={status[open.status]}>{open.status}</Tag> },
                { label: 'Kind', value: open.kind, mono: true },
                { label: 'Site', value: open.siteId ?? 'global', mono: true },
                { label: 'Latency', value: fmtDuration(open.latencyMs), mono: true },
                { label: 'Throughput', value: `${fmtNum(open.rate)} ${open.rateUnit}`, mono: true },
              ]}
            />
            <Panel title="Last 30 minutes">
              <TimeSeriesChart times={times} height={180} series={[{ id: 'l', label: 'latency', values: open.series, tone: 'signal', area: true }]} yFormat={(v) => fmtDuration(v)} />
            </Panel>
          </div>
        )}
      </Drawer>
    </>
  );
}
