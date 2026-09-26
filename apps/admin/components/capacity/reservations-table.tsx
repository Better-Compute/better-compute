'use client';

import { RiCloseCircleLine, RiStopCircleLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Mono, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtNum, fmtRelative, fmtStamp } from '@/lib/data/format';
import { reservationGpus, type Reservation } from '@/lib/data/capacity';
import { useCapacity, useCapacityActions, useTenantName } from './data';
import { stateStyle } from './model';
import { StateTag } from './ui';

/** Reservations as a filterable, sortable, exportable table with bulk release/cancel. */
export function ReservationsTable({
  reservations,
  onOpen,
  activeId,
  hidePool,
  maxHeight = 640,
  pageSize = 50,
}: {
  reservations: Reservation[];
  onOpen(reservation: Reservation): void;
  activeId?: string;
  hidePool?: boolean;
  maxHeight?: number | string;
  pageSize?: number;
}) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const actions = useCapacityActions();
  const now = snapshot.now;

  const columns: Column<Reservation>[] = [
    { id: 'id', header: 'Reservation', pinned: true, value: (r) => r.id, cell: (r) => <Mono>{r.id}</Mono>, width: 130 },
    {
      id: 'state',
      header: 'State',
      value: (r) => stateStyle[r.state].order,
      cell: (r) => <StateTag state={r.state} />,
      width: 150,
    },
    { id: 'tenant', header: 'Tenant', value: (r) => tenantName(r.tenantId), cell: (r) => <span className="truncate">{tenantName(r.tenantId)}</span>, width: 150 },
    { id: 'project', header: 'Project', value: (r) => r.projectId ?? '', cell: (r) => <span className="font-mono text-[12px] text-text-secondary">{r.projectId}</span>, width: 120 },
    ...(hidePool ? [] : [{ id: 'pool', header: 'Pool', value: (r: Reservation) => r.poolId, cell: (r: Reservation) => <span className="font-mono text-[12px]">{r.poolId}</span>, width: 140 }]),
    {
      id: 'gpus',
      header: 'GPUs',
      align: 'right',
      value: (r) => reservationGpus(r),
      cell: (r) => (
        <span className="font-mono text-[12px] tabular-nums">
          {fmtNum(reservationGpus(r))}
          {r.request.gang && <span className="text-text-tertiary"> ×{r.request.gang.size}n</span>}
        </span>
      ),
      width: 80,
    },
    {
      id: 'start',
      header: 'Start (UTC)',
      value: (r) => r.during?.start ?? r.request.start ?? 0,
      cell: (r) => {
        const start = r.during?.start ?? r.request.start;
        return start ? (
          <span className="font-mono text-[12px] tabular-nums" title={fmtRelative(start, now)}>
            {fmtStamp(start)}
          </span>
        ) : (
          <span className="text-text-tertiary">—</span>
        );
      },
      width: 120,
    },
    {
      id: 'length',
      header: 'Length',
      align: 'right',
      value: (r) => (r.during ? r.during.end - r.during.start : 0),
      cell: (r) => <span className="font-mono text-[12px] tabular-nums">{r.during ? fmtDuration(r.during.end - r.during.start) : r.request.duration}</span>,
      width: 90,
    },
    {
      id: 'left',
      header: 'Time left',
      align: 'right',
      value: (r) => (r.during && r.during.end > now ? r.during.end - now : -1),
      cell: (r) =>
        r.during && r.during.end > now && (r.state === 'active' || r.state === 'binding') ? (
          <span className="font-mono text-[12px] tabular-nums">{fmtDuration(r.during.end - now)}</span>
        ) : (
          <span className="text-text-tertiary">—</span>
        ),
      width: 90,
    },
    {
      id: 'flags',
      header: 'Flags',
      value: (r) => [r.request.spot && 'spot', r.leaseExpiresAt && 'lease', r.agentId && 'agent'].filter(Boolean).join(' '),
      cell: (r) => (
        <span className="flex gap-1">
          {r.request.spot && <Tag status="ok" led={false}>spot</Tag>}
          {r.request.leaseSeconds && <Tag status="ok" led={false}>lease</Tag>}
          {r.agentId && <Tag status="ok" led={false}>agent</Tag>}
          {r.conditions.length > 0 && <Tag status={r.state === 'failed' ? 'crit' : 'warn'}>{r.conditions[0]!.type}</Tag>}
        </span>
      ),
      width: 170,
    },
    { id: 'binding', header: 'Binding', value: (r) => r.request.binding ?? 'hold', cell: (r) => <span className="font-mono text-[12px]">{r.request.binding ?? 'hold'}</span>, defaultHidden: true },
    { id: 'owner', header: 'Owner', value: (r) => r.ownerIdentityId, cell: (r) => <Mono dim>{r.ownerIdentityId}</Mono>, defaultHidden: true },
  ];

  return (
    <DataTable
      rows={reservations}
      columns={columns}
      rowId={(r) => r.id}
      onRowClick={onOpen}
      activeId={activeId}
      pageSize={pageSize}
      maxHeight={maxHeight}
      searchPlaceholder="Search id, tenant, project"
      initialSort={{ id: 'start', dir: 'desc' }}
      exportName="reservations"
      viewKey={hidePool ? 'capacity.pool-reservations' : 'capacity.reservations'}
      facets={[
        { id: 'state', label: 'State', value: (r) => r.state },
        ...(hidePool ? [] : [{ id: 'pool', label: 'Pool', value: (r: Reservation) => r.poolId }]),
        { id: 'tenant', label: 'Tenant', value: (r) => r.tenantId, labels: Object.fromEntries(snapshot.tenants.map((tenant) => [tenant.id, tenant.name])) },
        { id: 'binding', label: 'Binding', value: (r) => r.request.binding ?? 'hold' },
      ]}
      bulkActions={(selected, clear) => {
        const releasable = selected.filter((r) => r.state === 'active' || r.state === 'binding');
        const cancellable = selected.filter((r) => r.state === 'placed' || r.state === 'pending' || r.state === 'awaiting-confirmation');
        return (
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="secondary"
              leadingIcon={RiStopCircleLine}
              disabled={!releasable.length || actions.state.busy || !actions.live}
              onClick={async () => {
                await actions.bulk('release', releasable.map((r) => r.id));
                clear();
              }}
            >
              Release {releasable.length}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              leadingIcon={RiCloseCircleLine}
              disabled={!cancellable.length || actions.state.busy || !actions.live}
              onClick={async () => {
                await actions.bulk('cancel', cancellable.map((r) => r.id));
                clear();
              }}
            >
              Cancel {cancellable.length}
            </Button>
          </div>
        );
      }}
    />
  );
}
