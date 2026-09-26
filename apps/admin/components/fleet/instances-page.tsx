'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { RiInstanceLine } from 'react-icons/ri';
import { EntityLink } from '@/components/shell/peek';
import { useWorkspace } from '@/components/shell/workspace';
import { StackedBar } from '@/components/ui/charts';
import { DataTable, type Column, type Facet } from '@/components/ui/data-table';
import { Drawer } from '@/components/ui/overlay';
import { KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import type { FleetSnapshot, Instance, InstanceState } from '@/lib/data/fleet';
import { fmtNum, fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById, tenantById } from '@/lib/data/topology';
import { countBy } from './filters';
import { CountChip, SectionLabel, instanceStatus } from './ui';
import { useFleet } from './use-fleet';

// VPS instances (vps module): long-lived VMs on host pools. The page is the population by state, flavor and
// tenant; the drawer is one instance with its conditions and last operation.

const ORDER: InstanceState[] = ['running', 'provisioning', 'starting', 'stopped', 'paused', 'error', 'lost'];

export function InstancesPage() {
  const snapshot = useFleet();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get('instance') ?? undefined;
  const state = params.get('state') ?? undefined;
  const set = (key: string, value?: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };
  const counts = useMemo(() => countBy(snapshot.instances, (instance) => instance.state), [snapshot.instances]);
  const rows = state ? snapshot.instances.filter((instance) => instance.state === state) : snapshot.instances;
  const open = openId ? snapshot.instances.find((instance) => instance.id === openId) : undefined;
  const nodeName = (id?: string) => snapshot.nodes.find((node) => node.id === id)?.hostname ?? id?.replace(/^n-/, '');

  const columns: Column<Instance>[] = [
    { id: 'id', header: 'Instance', pinned: true, width: 190, value: (i) => i.id, cell: (i) => <Mono>{i.id}</Mono> },
    { id: 'state', header: 'State', width: 120, value: (i) => i.state, cell: (i) => <Tag status={instanceStatus[i.state]}>{i.state}</Tag> },
    { id: 'flavor', header: 'Flavor', width: 90, value: (i) => i.flavor, cell: (i) => <Mono dim>{i.flavor}</Mono> },
    { id: 'tenant', header: 'Tenant', width: 150, value: (i) => tenantById(i.tenantId)?.name ?? i.tenantId, cell: (i) => <span className="text-text-secondary">{tenantById(i.tenantId)?.name}</span> },
    { id: 'node', header: 'Host', width: 150, value: (i) => nodeName(i.nodeId) ?? '', cell: (i) => (i.nodeId ? <EntityLink kind="node" id={i.nodeId}>{nodeName(i.nodeId)}</EntityLink> : '—') },
    { id: 'address', header: 'Address', width: 130, value: (i) => i.addresses[0] ?? '', cell: (i) => <Mono dim>{i.addresses[0]}</Mono> },
    { id: 'pool', header: 'Pool', width: 130, defaultHidden: true, value: (i) => poolById(i.poolId)?.name ?? '', cell: (i) => <span className="text-text-secondary">{poolById(i.poolId)?.name}</span> },
    {
      id: 'condition',
      header: 'Condition',
      width: 220,
      value: (i) => i.conditions[0]?.type ?? '',
      cell: (i) => (i.conditions[0] ? <span className="truncate text-caption-1-regular text-text-secondary" title={i.conditions[0].message}>{i.conditions[0].type}: {i.conditions[0].message}</span> : <span className="text-text-tertiary">—</span>),
    },
  ];
  const facets: Facet<Instance>[] = [
    { id: 'flavor', label: 'Flavor', value: (i) => i.flavor },
    { id: 'tenant', label: 'Tenant', value: (i) => tenantById(i.tenantId)?.name ?? i.tenantId },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Instances" icon={RiInstanceLine} description="VPS instances on host pools: long-lived VMs placed by capacity and run by bcd's libvirt or cloud-hypervisor runtime.">
        <div className="flex flex-col gap-2">
          <StackedBar
            height={6}
            parts={ORDER.map((each) => ({ label: each, value: counts.get(each) ?? 0, tone: each === 'running' ? 'signal' : each === 'error' || each === 'lost' ? 'crit' : each === 'stopped' || each === 'paused' ? 'hatch' : 'muted' }))}
          />
          <div className="flex flex-wrap gap-2">
            {ORDER.map((each) => (
              <CountChip key={each} status={instanceStatus[each]} count={counts.get(each) ?? 0} label={each} active={state === each} onPress={() => set('state', state === each ? undefined : each)} />
            ))}
            <span className="ml-1 self-center font-mono text-[11px] text-text-tertiary">{fmtNum(snapshot.instances.length)} total</span>
          </div>
        </div>
      </PageHeader>
      <Panel flush>
        <DataTable
          rows={rows}
          columns={columns}
          facets={facets}
          rowId={(i) => i.id}
          onRowClick={(i) => set('instance', i.id)}
          activeId={openId}
          rowTone={(i) => (i.state === 'error' || i.state === 'lost' ? 'crit' : undefined)}
          searchPlaceholder="Filter by id, tenant, host, address…"
          exportName="instances"
          viewKey="instances"
          maxHeight="calc(100dvh - 330px)"
        />
      </Panel>
      <Drawer open={Boolean(open)} onOpenChange={(isOpen) => !isOpen && set('instance')} title={open?.id ?? ''} subtitle={open ? `${open.flavor} · ${tenantById(open.tenantId)?.name}` : undefined} width={560}>
        {open && <InstanceDetail instance={open} snapshot={snapshot} />}
      </Drawer>
    </div>
  );
}

export function InstanceDetail({ instance, snapshot }: { instance: Instance; snapshot: FleetSnapshot }) {
  const { now } = useWorkspace();
  const node = snapshot.nodes.find((each) => each.id === instance.nodeId);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        <Tag status={instanceStatus[instance.state]}>{instance.state}</Tag>
        <Tag status="ok" led={false}>
          desired {instance.desiredState}
        </Tag>
      </div>
      <div>
        <SectionLabel>Placement</SectionLabel>
        <KeyValue
          items={[
            { label: 'Host', value: node ? <EntityLink kind="node" id={node.id}>{node.hostname}</EntityLink> : '—' },
            { label: 'Pool', value: poolById(instance.poolId)?.name ?? instance.poolId },
            { label: 'Flavor', value: instance.flavor, mono: true },
            { label: 'Image', value: instance.imageId, mono: true },
            { label: 'Addresses', value: instance.addresses.join(', '), mono: true },
            { label: 'Allocation', value: instance.allocationId ?? '—', mono: true },
            { label: 'Tenant', value: tenantById(instance.tenantId)?.name ?? instance.tenantId },
            { label: 'Project', value: instance.projectId ?? '—', mono: true },
            { label: 'Owner', value: instance.ownerIdentityId, mono: true },
            { label: 'Version', value: instance.version, mono: true },
          ]}
        />
      </div>
      <div>
        <SectionLabel>Conditions</SectionLabel>
        {instance.conditions.length === 0 ? (
          <p className="text-body-2-regular text-text-tertiary">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {instance.conditions.map((condition) => (
              <li key={condition.type} className="flex items-start gap-2 border border-separator-border p-2">
                <SeverityIcon severity="critical" />
                <div className="min-w-0">
                  <div className="font-mono text-[12px] text-text-primary">{condition.type}</div>
                  <div className="text-body-2-regular text-text-secondary">{condition.message}</div>
                  <div className="font-mono text-[10px] text-text-tertiary">
                    since {fmtStamp(condition.since)} · {fmtRelative(condition.since, now)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
