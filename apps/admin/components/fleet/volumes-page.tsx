'use client';

import { RiHardDrive2Line } from 'react-icons/ri';
import { EntityLink } from '@/components/shell/peek';
import { useNow } from '@/components/shell/workspace';
import { DataTable, type Column, type Facet } from '@/components/ui/data-table';
import { PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import type { SandboxVolume } from '@/lib/data/fleet';
import { fmtGiB, fmtNum, fmtRelative } from '@/lib/data/format';
import { poolById, tenantById } from '@/lib/data/topology';
import { LiveNotice } from './live-notice';
import { useFleet } from './use-fleet';

// Sandbox volumes (vps sandboxVolumes): persistent disks agents keep across sandboxes ("agent memory"),
// pinned to the node that holds them, with one writer at a time.

export function VolumesPage() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const volumes = snapshot.volumes;
  const mounted = new Map<string, string[]>();
  for (const template of snapshot.templates) for (const mount of template.volumes) mounted.set(mount.volumeId, [...(mounted.get(mount.volumeId) ?? []), `${template.name}:${mount.mountPath}`]);
  const total = volumes.reduce((sum, volume) => sum + volume.sizeGiB, 0);
  const nodeName = (id?: string) => snapshot.nodes.find((node) => node.id === id)?.hostname;

  const columns: Column<SandboxVolume>[] = [
    { id: 'name', header: 'Volume', pinned: true, width: 180, value: (v) => `${v.name} ${v.id}`, cell: (v) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[12px] text-text-primary">{v.name}</span>
        <span className="truncate font-mono text-[10px] text-text-tertiary">{v.id}</span>
      </span>
    ) },
    { id: 'state', header: 'State', width: 100, value: (v) => v.state, cell: (v) => <Tag status={v.state === 'ready' ? 'ok' : 'pending'}>{v.state}</Tag> },
    { id: 'size', header: 'Size', width: 90, align: 'right', value: (v) => v.sizeGiB, cell: (v) => <Mono>{fmtGiB(v.sizeGiB)}</Mono> },
    { id: 'tenant', header: 'Tenant', width: 150, value: (v) => tenantById(v.tenantId)?.name ?? v.tenantId, cell: (v) => <span className="text-text-secondary">{tenantById(v.tenantId)?.name}</span> },
    { id: 'node', header: 'Held on', width: 150, value: (v) => nodeName(v.nodeId) ?? '', cell: (v) => (v.nodeId ? <EntityLink kind="node" id={v.nodeId}>{nodeName(v.nodeId) ?? v.nodeId}</EntityLink> : <span className="text-text-tertiary">unplaced</span>) },
    { id: 'mounts', header: 'Mounted by', width: 200, value: (v) => (mounted.get(v.id) ?? []).join(' '), cell: (v) => <Mono dim className="truncate">{(mounted.get(v.id) ?? []).join(', ') || '—'}</Mono> },
    { id: 'serial', header: 'Serial', width: 170, defaultHidden: true, value: (v) => v.serial, cell: (v) => <Mono dim>{v.serial}</Mono> },
    { id: 'created', header: 'Created', width: 90, value: (v) => -v.createdAt, cell: (v) => <span className="font-mono text-[11px] text-text-tertiary">{fmtRelative(v.createdAt, now)}</span> },
  ];
  const facets: Facet<SandboxVolume>[] = [
    { id: 'tenant', label: 'Tenant', value: (v) => tenantById(v.tenantId)?.name ?? v.tenantId },
    { id: 'pool', label: 'Pool', value: (v) => poolById(v.poolId)?.name ?? v.poolId },
  ];

  return (
    <div className="flex flex-col gap-4">
      <LiveNotice />
      <PageHeader title="Volumes" icon={RiHardDrive2Line} description="Persistent sandbox volumes (agent memory): pinned to the node that holds them, attached to one writer at a time, metered by size." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Panel>
          <Stat label="Volumes" value={fmtNum(volumes.length)} />
        </Panel>
        <Panel>
          <Stat label="Provisioned" value={fmtGiB(total)} />
        </Panel>
        <Panel>
          <Stat label="Unplaced" value={fmtNum(volumes.filter((v) => !v.nodeId).length)} hint="placed on first attach" />
        </Panel>
        <Panel>
          <Stat label="Deleting" value={fmtNum(volumes.filter((v) => v.state === 'deleting').length)} />
        </Panel>
      </div>
      <Panel flush>
        <DataTable rows={volumes} columns={columns} facets={facets} rowId={(v) => v.id} searchPlaceholder="Filter by name, id, tenant…" exportName="volumes" viewKey="volumes" initialSort={{ id: 'size', dir: 'desc' }} />
      </Panel>
    </div>
  );
}
