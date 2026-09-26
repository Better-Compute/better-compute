'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { RiLayoutGridLine } from 'react-icons/ri';
import { DataTable, type Column } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { fmtMoney, fmtNum } from '@/lib/data/format';
import { poolById } from '@/lib/data/topology';
import type { FlavorRecord } from '@/lib/data/capacity';
import { usePoolRows } from '../data';
import { SourceNotice } from '../source-notice';

/** A horizontal bar for one dimension of a flavor, scaled to the largest in the list. */
function ShapeBar({ value, max, unit }: { value: number; max: number; unit: string }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 bg-background-secondary-default">
        <div className="h-full bg-text-secondary" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </div>
      <span className="w-16 text-right font-mono text-[12px] tabular-nums">
        {fmtNum(value)} <span className="text-text-tertiary">{unit}</span>
      </span>
    </div>
  );
}

/** Estimated list price per hour of a flavor: GPUs at the pool's GPU price, else vCPUs at the vCPU price. */
function hourly(flavor: FlavorRecord) {
  const pool = poolById(flavor.poolId);
  if (!pool) return 0;
  return flavor.gpus > 0 ? flavor.gpus * pool.price + flavor.vcpu * 0.018 : flavor.vcpu * (pool.kind === 'gpu' ? 0.018 : pool.price);
}

export function FlavorList({ poolId }: { poolId?: string }) {
  const { snapshot, rows } = usePoolRows();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const flavors = useMemo(
    () => snapshot.flavors.filter((flavor) => (poolId ? flavor.poolId === poolId : inScope.has(flavor.poolId))),
    [snapshot, poolId, inScope],
  );
  const max = useMemo(
    () => ({
      vcpu: Math.max(1, ...flavors.map((f) => f.vcpu)),
      memoryGiB: Math.max(1, ...flavors.map((f) => f.memoryGiB)),
      diskGiB: Math.max(1, ...flavors.map((f) => f.diskGiB)),
    }),
    [flavors],
  );
  const columns: Column<FlavorRecord>[] = [
    {
      id: 'name',
      header: 'Flavor',
      pinned: true,
      value: (f) => f.name,
      cell: (f) => (
        <span className="flex items-center gap-2">
          <Mono>{f.name}</Mono>
          {f.archived && <Tag status="off">archived</Tag>}
        </span>
      ),
      width: 180,
    },
    ...(poolId
      ? []
      : [
          {
            id: 'pool',
            header: 'Pool',
            value: (f: FlavorRecord) => f.poolId,
            cell: (f: FlavorRecord) => (
              <Link href={`/pools/${f.poolId}?tab=flavors`} className="font-mono text-[12px] hover:underline" onClick={(event) => event.stopPropagation()}>
                {f.poolId}
              </Link>
            ),
            width: 150,
          },
        ]),
    { id: 'vcpu', header: 'vCPU', align: 'right', value: (f) => f.vcpu, cell: (f) => <ShapeBar value={f.vcpu} max={max.vcpu} unit="" /> },
    { id: 'memory', header: 'Memory', align: 'right', value: (f) => f.memoryGiB, cell: (f) => <ShapeBar value={f.memoryGiB} max={max.memoryGiB} unit="GiB" /> },
    { id: 'disk', header: 'Disk', align: 'right', value: (f) => f.diskGiB, cell: (f) => <ShapeBar value={f.diskGiB} max={max.diskGiB} unit="GiB" /> },
    {
      id: 'gpus',
      header: 'GPUs',
      align: 'right',
      value: (f) => f.gpus,
      cell: (f) => (f.gpus ? <span className="font-mono text-[12px] tabular-nums">{f.gpus} × {poolById(f.poolId)?.short}</span> : <span className="text-text-tertiary">—</span>),
      width: 120,
    },
    {
      id: 'placement',
      header: 'Placement',
      value: (f) => Object.entries(f.placement ?? {}).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(' '),
      cell: (f) => (
        <span className="flex flex-wrap gap-1">
          {f.placement?.numaAffine && <Tag status="ok" led={false}>NUMA-affine</Tag>}
          {f.placement?.pinned && <Tag status="ok" led={false}>pinned vCPUs</Tag>}
          {f.placement?.hugepages && <Tag status="ok" led={false}>hugepages {f.placement.hugepages}</Tag>}
          {!f.placement && <span className="text-text-tertiary">—</span>}
        </span>
      ),
      width: 240,
    },
    { id: 'offer', header: 'Provider offer', value: (f) => f.offerId ?? '', cell: (f) => (f.offerId ? <Mono dim>{f.offerId}</Mono> : <span className="text-text-tertiary">—</span>), defaultHidden: !flavors.some((f) => f.offerId) },
    {
      id: 'price',
      header: 'List ≈/h',
      align: 'right',
      value: (f) => hourly(f),
      cell: (f) => <span className="font-mono text-[12px] tabular-nums">{fmtMoney(hourly(f), { cents: true })}</span>,
      width: 90,
    },
    { id: 'version', header: 'v', align: 'right', value: (f) => f.version, cell: (f) => <span className="font-mono text-[12px] text-text-tertiary">{f.version}</span>, width: 40 },
  ];
  return (
    <DataTable
      rows={flavors}
      columns={columns}
      rowId={(f) => f.id}
      facets={poolId ? [] : [{ id: 'pool', label: 'Pool', value: (f) => f.poolId }]}
      searchPlaceholder="Search flavors"
      initialSort={{ id: 'vcpu', dir: 'asc' }}
      exportName={poolId ? `flavors-${poolId}` : 'flavors'}
      viewKey={poolId ? 'capacity.pool-flavors' : 'capacity.flavors'}
    />
  );
}

/** Named instance shapes per VPS-host and provider pool (flavors.list). */
export function FlavorsPage() {
  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiLayoutGridLine}
        title="Flavors"
        description="Instance and sandbox shapes, per pool. Hosted pools place them as scalar claims (and GPU atoms); provider pools map each to a provider offer. A flavor still referenced by an instance is archived, not deleted."
      />
      <FlavorList />
    </>
  );
}
