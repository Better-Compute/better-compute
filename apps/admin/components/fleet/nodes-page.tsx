'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import {
  RiCpuLine,
  RiFilter3Line,
  RiHandHeartLine,
  RiLayoutColumnLine,
  RiLockLine,
  RiLockUnlockLine,
  RiPlugLine,
  RiPriceTag3Line,
  RiServerLine,
  RiStackLine,
  RiTableLine,
} from 'react-icons/ri';
import { usePageCommands } from '@/components/shell/page-commands';
import { useWorkspace } from '@/components/shell/workspace';
import type { CommandDef } from '@/lib/modules';
import { StackedBar } from '@/components/ui/charts';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Drawer } from '@/components/ui/overlay';
import { PageHeader, Panel } from '@/components/ui/panel';
import { Mono } from '@/components/ui/signal';
import { connectivityStates, fleetTotals, nodeSeverity, provisionStates, type FleetNode } from '@/lib/data/fleet';
import { fmtRelative } from '@/lib/data/format';
import { poolById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { PRESETS, activeFilterCount, countBy, matches, readFilters, writeFilters, type NodeFilters, type PresetId } from './filters';
import { NodeDetail } from './node-detail';
import { useFleetCommands } from './commands';
import { RackView } from './rack-view';
import { ActionButton, ConditionSummary, CountChip, FacetMenu, GpuCells, NodeStatusTag, UtilBar, nodeStatus } from './ui';
import { useFleet } from './use-fleet';

type View = 'table' | 'racks';

function avgGpu(node: FleetNode): number | undefined {
  const live = node.gpus.filter((gpu) => gpu.telemetry);
  return live.length ? live.reduce((sum, gpu) => sum + gpu.telemetry!.utilization, 0) / live.length : undefined;
}

export function NodesPage() {
  const snapshot = useFleet();
  const { now } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const commands = useFleetCommands();

  const filters = useMemo(() => readFilters(new URLSearchParams(params.toString())), [params]);
  const view: View = params.get('view') === 'racks' ? 'racks' : 'table';
  const openId = params.get('node') ?? undefined;
  const query = params.get('q') ?? '';

  const navigate = useCallback(
    (mutate: (next: URLSearchParams) => URLSearchParams | void) => {
      const next = new URLSearchParams(params.toString());
      const result = mutate(next) ?? next;
      const text = result.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  const setFilters = (patch: Partial<NodeFilters>) => navigate((next) => writeFilters(next, { ...filters, ...patch }));
  const toggleHealth = (health: FleetNode['health']) => {
    const next = new Set(filters.health);
    if (next.has(health)) next.delete(health);
    else next.add(health);
    setFilters({ health: next });
  };

  const nodes = snapshot.nodes;
  const filtered = useMemo(() => nodes.filter((node) => matches(node, filters)), [nodes, filters]);
  const visibleIds = useMemo(() => new Set(filtered.map((node) => node.id)), [filtered]);
  const totals = fleetTotals(snapshot);
  const open = openId ? nodes.find((node) => node.id === openId) : undefined;
  const openNode = (node: FleetNode) => navigate((next) => void next.set('node', node.id));

  const facetOptions = useMemo(() => {
    const pools = countBy(nodes, (node) => node.poolId ?? '');
    const states = countBy(nodes, (node) => node.provisionState);
    const conn = countBy(nodes, (node) => node.connectivity);
    const models = countBy(nodes, (node) => node.gpuModel ?? 'CPU');
    return {
      pool: [...pools].map(([id, count]) => ({ id, label: poolById(id)?.name ?? id, count })),
      state: provisionStates.filter((state) => states.has(state)).map((state) => ({ id: state, label: state, count: states.get(state) })),
      connectivity: connectivityStates.map((state) => ({ id: state, label: state, count: conn.get(state) ?? 0 })),
      model: [...models].map(([id, count]) => ({ id, label: id, count })),
    };
  }, [nodes]);

  const bulk = (selected: FleetNode[], clear: () => void) => (
    <>
      <ActionButton icon={RiLockLine} onPress={() => commands.cordon(selected)}>
        Cordon
      </ActionButton>
      <ActionButton icon={RiLockUnlockLine} onPress={() => (commands.uncordon(selected), clear())}>
        Uncordon
      </ActionButton>
      <ActionButton icon={RiHandHeartLine} onPress={() => commands.drain(selected)}>
        Drain
      </ActionButton>
      <ActionButton icon={RiPriceTag3Line} onPress={() => commands.labelPrompt(selected)}>
        Label…
      </ActionButton>
    </>
  );

  usePageCommands(
    useMemo<CommandDef[]>(
      () => [
        ...(open
          ? [
              { id: 'node.cordon', label: `${open.cordoned ? 'Uncordon' : 'Cordon'} ${open.hostname}`, group: 'This page', icon: open.cordoned ? RiLockUnlockLine : RiLockLine, run: () => (open.cordoned ? commands.uncordon([open]) : commands.cordon([open])) },
              { id: 'node.drain', label: `Drain ${open.hostname}`, group: 'This page', icon: RiHandHeartLine, run: () => commands.drain([open]) },
              { id: 'node.label', label: `Label ${open.hostname}…`, group: 'This page', icon: RiPriceTag3Line, run: () => commands.labelPrompt([open]) },
            ]
          : []),
        { id: 'nodes.view', label: view === 'racks' ? 'Show the node table' : 'Show rack elevations', group: 'This page', icon: view === 'racks' ? RiTableLine : RiLayoutColumnLine, run: () => navigate((next) => (view === 'racks' ? next.delete('view') : next.set('view', 'racks'))) },
        ...(Object.keys(PRESETS) as PresetId[]).map((id) => ({ id: `nodes.preset.${id}`, label: `View: ${PRESETS[id].label}`, group: 'This page', icon: RiFilter3Line, run: () => setFilters({ preset: id }) })),
      ],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [open?.id, open?.cordoned, view, commands, params],
    ),
  );

  const columns: Column<FleetNode>[] = [
    {
      id: 'host',
      header: 'Node',
      pinned: true,
      width: 190,
      value: (node) => `${node.hostname} ${node.id}`,
      cell: (node) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-[12px] text-text-primary">{node.hostname}</span>
          <span className="truncate font-mono text-[10px] text-text-tertiary">{node.rack} · U{node.unit}</span>
        </span>
      ),
    },
    { id: 'status', header: 'Status', width: 120, value: (node) => nodeStatus(node), cell: (node) => <NodeStatusTag node={node} /> },
    { id: 'pool', header: 'Pool', width: 150, value: (node) => poolById(node.poolId ?? '')?.name ?? '', cell: (node) => <span className="truncate text-text-secondary">{poolById(node.poolId ?? '')?.name}</span> },
    {
      id: 'gpus',
      header: 'GPUs',
      width: 140,
      value: (node) => node.gpus.filter((gpu) => gpu.allocation).length,
      cell: (node) => (node.gpus.length ? <GpuCells gpus={node.gpus} size={9} /> : <span className="font-mono text-[11px] text-text-tertiary">{node.cpu.vcpus} vCPU</span>),
    },
    { id: 'load', header: 'Load', width: 120, value: (node) => avgGpu(node) ?? node.cpu.utilization ?? -1, cell: (node) => <UtilBar value={avgGpu(node) ?? node.cpu.utilization} /> },
    { id: 'conditions', header: 'Conditions', width: 170, value: (node) => (nodeSeverity(node) === 'critical' ? 3 : nodeSeverity(node) === 'warning' ? 2 : node.conditions.length ? 1 : 0), cell: (node) => <ConditionSummary node={node} /> },
    { id: 'state', header: 'Lifecycle', width: 110, value: (node) => node.provisionState, cell: (node) => <span className="font-mono text-[11px] text-text-secondary">{node.provisionState}</span> },
    { id: 'bcd', header: 'bcd', width: 70, value: (node) => node.daemonVersion, cell: (node) => <Mono dim={node.daemonVersion === '1.4.2'}>{node.daemonVersion}</Mono> },
    {
      id: 'gen',
      header: 'Gen',
      width: 70,
      align: 'right',
      defaultHidden: true,
      value: (node) => node.generation - node.observedGeneration,
      cell: (node) => <Mono className={cx(node.observedGeneration < node.generation && 'text-signal')}>{node.observedGeneration}/{node.generation}</Mono>,
    },
    { id: 'seen', header: 'Last seen', width: 90, value: (node) => -(node.session?.lastSeen ?? 0), cell: (node) => <span className="font-mono text-[11px] text-text-tertiary">{fmtRelative(node.session?.lastSeen ?? now, now)}</span> },
    { id: 'work', header: 'Workloads', width: 90, align: 'right', defaultHidden: true, value: (node) => node.instanceCount + node.sandboxCount, cell: (node) => <Mono dim>{node.instanceCount + node.sandboxCount}</Mono> },
    { id: 'id', header: 'Id', width: 160, defaultHidden: true, value: (node) => node.id, cell: (node) => <Mono dim>{node.id}</Mono> },
  ];

  const healthParts = [
    { key: 'ready' as const, label: 'ready', tone: 'neutral' as const, count: totals.health.ready },
    { key: 'degraded' as const, label: 'degraded', tone: 'signal' as const, count: totals.health.degraded },
    { key: 'provisioning' as const, label: 'provisioning', tone: 'hatch' as const, count: totals.health.provisioning },
    { key: 'offline' as const, label: 'offline', tone: 'crit' as const, count: totals.health.offline },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Nodes"
        icon={RiServerLine}
        description="Every machine that runs bcd: health, GPUs, lifecycle and placement. Select rows for bulk actions; press Enter or click to open one."
        actions={
          <div className="flex border border-separator-border" role="group" aria-label="View">
            {(
              [
                ['table', 'Table', RiTableLine],
                ['racks', 'Racks', RiLayoutColumnLine],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => navigate((next) => (id === 'table' ? next.delete('view') : next.set('view', id)))}
                className={cx('inline-flex h-8 items-center gap-1.5 px-3 text-body-2-medium', view === id ? 'bg-signal-soft text-text-primary' : 'text-text-secondary hover:bg-background-secondary-default')}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <StackedBar
            height={6}
            parts={healthParts.map((part) => ({ label: part.label, value: part.count, tone: part.tone }))}
            title={healthParts.map((part) => `${part.count} ${part.label}`).join(', ')}
          />
          <div className="flex flex-wrap items-center gap-2">
            <CountChip status="ok" count={totals.health.ready} label="ready" active={filters.health.has('ready')} onPress={() => toggleHealth('ready')} />
            <CountChip status="warn" count={totals.health.degraded} label="degraded" active={filters.health.has('degraded')} onPress={() => toggleHealth('degraded')} />
            <CountChip status="pending" count={totals.health.provisioning} label="provisioning" active={filters.health.has('provisioning')} onPress={() => toggleHealth('provisioning')} />
            <CountChip status="crit" count={totals.health.offline} label="offline" active={filters.health.has('offline')} onPress={() => toggleHealth('offline')} />
            <span className="mx-1 h-5 w-px bg-separator-border" />
            <CountChip status="off" count={totals.cordoned} label="cordoned" />
            <CountChip status="live" count={totals.gpusAllocated} label={`of ${totals.gpus} GPUs booked`} />
            <CountChip status={totals.incidents.critical ? 'crit' : 'ok'} count={totals.incidents.critical} label="critical" active={filters.preset === 'attention'} onPress={() => setFilters({ preset: filters.preset === 'attention' ? 'all' : 'attention' })} />
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap border border-separator-border" role="tablist" aria-label="Saved views">
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filters.preset === id}
              onClick={() => setFilters({ preset: id })}
              className={cx(
                'h-8 border-r border-separator-border px-2.5 text-body-2-regular last:border-r-0',
                filters.preset === id ? 'bg-signal-soft text-text-primary shadow-[inset_0_-2px_0_var(--color-signal-fill)]' : 'text-text-secondary hover:bg-background-secondary-default hover:text-text-primary',
              )}
            >
              {PRESETS[id].label}
              <span className="ml-1.5 font-mono text-[10px] text-text-tertiary">{nodes.filter(PRESETS[id].test).length}</span>
            </button>
          ))}
        </div>
        <FacetMenu label="Pool" icon={RiStackLine} options={facetOptions.pool} selected={filters.pool} onChange={(pool) => setFilters({ pool })} />
        <FacetMenu label="GPU" icon={RiCpuLine} options={facetOptions.model} selected={filters.model} onChange={(model) => setFilters({ model })} />
        <FacetMenu label="Lifecycle" icon={RiFilter3Line} options={facetOptions.state} selected={filters.state} onChange={(state) => setFilters({ state })} />
        <FacetMenu label="Connectivity" icon={RiPlugLine} options={facetOptions.connectivity} selected={filters.connectivity} onChange={(connectivity) => setFilters({ connectivity })} />
        {activeFilterCount(filters) > 0 && (
          <button
            type="button"
            onClick={() => navigate((next) => writeFilters(next, { preset: 'all', health: new Set(), pool: new Set(), state: new Set(), connectivity: new Set(), model: new Set() }))}
            className="font-mono text-[11px] text-text-tertiary underline-offset-2 hover:text-text-primary hover:underline"
          >
            reset · {filtered.length} of {nodes.length}
          </button>
        )}
      </div>

      {view === 'table' ? (
        <Panel flush>
          <DataTable
            rows={filtered}
            columns={columns}
            rowId={(node) => node.id}
            onRowClick={openNode}
            activeId={openId}
            bulkActions={bulk}
            query={query}
            onQueryChange={(q) => navigate((next) => (q ? next.set('q', q) : next.delete('q')))}
            searchPlaceholder="Filter by host, rack, pool, id…"
            rowTone={(node) => {
              const status = nodeStatus(node);
              return status === 'crit' ? 'crit' : status === 'warn' ? 'warn' : undefined;
            }}
            initialSort={{ id: 'conditions', dir: 'desc' }}
            exportName="nodes"
            viewKey="nodes"
            pageSize={100}
            maxHeight="calc(100dvh - 330px)"
          />
        </Panel>
      ) : (
        <Panel flush bodyClassName="p-4">
          <RackView nodes={nodes} visible={visibleIds} activeId={openId} onOpen={openNode} />
        </Panel>
      )}

      <Drawer
        open={Boolean(open)}
        onOpenChange={(isOpen) => !isOpen && navigate((next) => void next.delete('node'))}
        title={open?.hostname ?? ''}
        subtitle={open ? `${poolById(open.poolId ?? '')?.name ?? ''} · ${open.rack} · ${open.id}` : undefined}
        width={760}
      >
        {open && <NodeDetail node={open} snapshot={snapshot} compact />}
      </Drawer>
    </div>
  );
}
