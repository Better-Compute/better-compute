'use client';

import { useMemo } from 'react';
import { RiCpuLine } from 'react-icons/ri';
import { EntityLink } from '@/components/shell/peek';
import { Meter } from '@/components/ui/charts';
import { DataTable, type Column, type Facet } from '@/components/ui/data-table';
import { PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import type { FleetGpu, FleetNode } from '@/lib/data/fleet';
import { fmtNum, fmtPct } from '@/lib/data/format';
import { tenantById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { UtilBar } from './ui';
import { GpuWallWidget } from './widgets';
import { useFleet } from './use-fleet';

// Devices: every GPU in scope as inventory (model, PCI, MIG) plus bcd's live readings and capacity's holder.

interface Row {
  gpu: FleetGpu;
  node: FleetNode;
}

const stateOf = (gpu: FleetGpu) => (!gpu.healthy ? 'unhealthy' : gpu.allocation ? 'booked' : gpu.telemetry ? 'free' : 'no telemetry');

export function DevicesPage() {
  const snapshot = useFleet();
  const rows = useMemo<Row[]>(() => snapshot.nodes.flatMap((node) => node.gpus.map((gpu) => ({ gpu, node }))), [snapshot.nodes]);
  const live = rows.filter((row) => row.gpu.telemetry);
  const avg = (pick: (gpu: FleetGpu) => number) => (live.length ? live.reduce((sum, row) => sum + pick(row.gpu), 0) / live.length : 0);
  const models = useMemo(() => {
    const out = new Map<string, { total: number; healthy: number; booked: number; util: number; live: number }>();
    for (const { gpu } of rows) {
      const entry = out.get(gpu.model) ?? { total: 0, healthy: 0, booked: 0, util: 0, live: 0 };
      entry.total += 1;
      if (gpu.healthy) entry.healthy += 1;
      if (gpu.allocation) entry.booked += 1;
      if (gpu.telemetry) {
        entry.util += gpu.telemetry.utilization;
        entry.live += 1;
      }
      out.set(gpu.model, entry);
    }
    return [...out].sort((a, b) => b[1].total - a[1].total);
  }, [rows]);
  const hottest = [...live].sort((a, b) => b.gpu.telemetry!.temperatureC - a.gpu.telemetry!.temperatureC).slice(0, 8);

  const columns: Column<Row>[] = [
    { id: 'node', header: 'Node', pinned: true, width: 150, value: (r) => r.node.hostname, cell: (r) => <EntityLink kind="node" id={r.node.id}>{r.node.hostname}</EntityLink> },
    { id: 'index', header: 'GPU', width: 60, align: 'right', value: (r) => r.gpu.index, cell: (r) => <Mono>#{r.gpu.index}</Mono> },
    { id: 'model', header: 'Model', width: 100, value: (r) => r.gpu.model, cell: (r) => <span className="text-text-secondary">{r.gpu.model}</span> },
    { id: 'state', header: 'State', width: 120, value: (r) => stateOf(r.gpu), cell: (r) => <Tag status={!r.gpu.healthy ? 'crit' : r.gpu.allocation ? 'live' : 'ok'}>{!r.gpu.healthy && r.gpu.xid ? `XID ${r.gpu.xid.code}` : stateOf(r.gpu)}</Tag> },
    { id: 'util', header: 'Util', width: 120, value: (r) => r.gpu.telemetry?.utilization ?? -1, cell: (r) => <UtilBar value={r.gpu.telemetry?.utilization} /> },
    { id: 'temp', header: 'Temp', width: 70, align: 'right', value: (r) => r.gpu.telemetry?.temperatureC ?? -1, cell: (r) => <Mono className={cx((r.gpu.telemetry?.temperatureC ?? 0) >= 80 && 'text-signal')}>{r.gpu.telemetry ? `${r.gpu.telemetry.temperatureC}°` : '—'}</Mono> },
    { id: 'power', header: 'Power', width: 80, align: 'right', value: (r) => r.gpu.telemetry?.powerW ?? -1, cell: (r) => <Mono dim>{r.gpu.telemetry ? `${r.gpu.telemetry.powerW} W` : '—'}</Mono> },
    { id: 'holder', header: 'Held by', width: 150, value: (r) => (r.gpu.allocation ? tenantById(r.gpu.allocation.tenantId)?.name ?? r.gpu.allocation.tenantId : ''), cell: (r) => (r.gpu.allocation ? <span className="text-text-secondary">{tenantById(r.gpu.allocation.tenantId)?.name}</span> : <span className="text-text-tertiary">—</span>) },
    { id: 'pci', header: 'PCI', width: 120, defaultHidden: true, value: (r) => String(r.gpu.attributes.pciBusId), cell: (r) => <Mono dim>{String(r.gpu.attributes.pciBusId)}</Mono> },
    { id: 'uuid', header: 'UUID', width: 220, defaultHidden: true, value: (r) => r.gpu.uuid, cell: (r) => <Mono dim>{r.gpu.uuid}</Mono> },
  ];
  const facets: Facet<Row>[] = [
    { id: 'model', label: 'Model', value: (r) => r.gpu.model },
    { id: 'state', label: 'State', value: (r) => stateOf(r.gpu) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="GPUs" icon={RiCpuLine} description="Every GPU: inventory from bcd, live readings (OTLP samples from nvidia-smi / NVML), health from XID and ECC policy, and the reservation holding it." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Panel>
          <Stat label="GPUs" value={fmtNum(rows.length)} hint={`${rows.filter((r) => !r.gpu.healthy).length} unhealthy`} />
        </Panel>
        <Panel>
          <Stat label="Booked" value={fmtPct(rows.filter((r) => r.gpu.allocation).length / (rows.length || 1), 0)} hint={`${fmtNum(rows.filter((r) => r.gpu.allocation).length)} GPUs`} />
        </Panel>
        <Panel>
          <Stat label="Utilization" value={fmtPct(avg((gpu) => gpu.telemetry!.utilization), 0)} hint="mean of reporting GPUs" />
        </Panel>
        <Panel>
          <Stat label="Temperature" value={`${Math.round(avg((gpu) => gpu.telemetry!.temperatureC))}°C`} hint="mean" />
        </Panel>
        <Panel>
          <Stat label="GPU power" value={`${(live.reduce((sum, r) => sum + r.gpu.telemetry!.powerW, 0) / 1000).toFixed(0)} kW`} />
        </Panel>
      </div>
      <div className="grid grid-cols-12 gap-3">
        <Panel title="Wall" meta="click a node to peek" className="col-span-12 xl:col-span-6" bodyClassName="h-64 p-3">
          <GpuWallWidget size={{ w: 6, h: 3 }} editing={false} settings={{ color: 'util', unhealthyOnly: false }} />
        </Panel>
        <Panel title="By model" className="col-span-12 md:col-span-6 xl:col-span-3">
          <ul className="flex flex-col gap-3">
            {models.map(([model, entry]) => (
              <li key={model}>
                <Meter value={entry.booked} max={entry.total} warnAt={0.95} label={<Mono>{model}</Mono>} detail={`${entry.booked}/${entry.total} booked · ${fmtPct(entry.live ? entry.util / entry.live : 0, 0)} util${entry.total - entry.healthy ? ` · ${entry.total - entry.healthy} bad` : ''}`} />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Hottest" className="col-span-12 md:col-span-6 xl:col-span-3">
          <ul className="flex flex-col gap-1.5">
            {hottest.map(({ gpu, node }) => (
              <li key={gpu.id} className="flex items-center gap-2">
                <EntityLink kind="node" id={node.id} className="truncate">
                  {node.hostname}
                </EntityLink>
                <Mono dim>#{gpu.index}</Mono>
                <span className={cx('ml-auto font-mono text-[12px] tabular-nums', gpu.telemetry!.temperatureC >= 80 ? 'text-signal' : 'text-text-secondary')}>{gpu.telemetry!.temperatureC}°C</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel flush>
        <DataTable
          rows={rows}
          columns={columns}
          facets={facets}
          rowId={(r) => r.gpu.id}
          rowTone={(r) => (!r.gpu.healthy ? 'crit' : (r.gpu.telemetry?.temperatureC ?? 0) >= 85 ? 'warn' : undefined)}
          searchPlaceholder="Filter by node, model, tenant…"
          exportName="gpus"
          viewKey="gpus"
          pageSize={100}
          maxHeight="70dvh"
        />
      </Panel>
    </div>
  );
}
