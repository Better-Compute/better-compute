'use client';

import Link from 'next/link';
import { RiArrowLeftLine, RiServerLine } from 'react-icons/ri';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { poolById, siteById } from '@/lib/data/topology';
import { NodeDetail } from './node-detail';
import { useFleet } from './use-fleet';

/** One node on its own page (deep links from events, incidents and the palette). */
export function NodePage({ nodeId }: { nodeId: string }) {
  // Unscoped: a link to a node in another site still opens it.
  const snapshot = useFleet({ scoped: false });
  const node = snapshot.nodes.find((each) => each.id === nodeId);
  if (!node)
    return (
      <EmptyState
        icon={RiServerLine}
        title="No such node"
        action={
          <Link href="/nodes" className="font-mono text-[12px] text-signal hover:underline">
            Back to nodes
          </Link>
        }
      >
        {nodeId} is not in this fleet. It may have been deleted or retired.
      </EmptyState>
    );
  const pool = poolById(node.poolId ?? '');
  return (
    <div className="flex flex-col gap-2">
      <Link href="/nodes" className="inline-flex items-center gap-1 self-start font-mono text-[11px] text-text-tertiary hover:text-text-primary">
        <RiArrowLeftLine className="size-3.5" aria-hidden /> Nodes
      </Link>
      <PageHeader
        title={node.hostname}
        icon={RiServerLine}
        description={`${pool?.name ?? ''} · ${siteById(node.siteId)?.name ?? node.siteId} · ${node.rack} U${node.unit}`}
      />
      <Panel bodyClassName="p-4">
        <NodeDetail node={node} snapshot={snapshot} />
      </Panel>
    </div>
  );
}
