'use client';

import { RiBox3Line, RiServerLine } from 'react-icons/ri';
import { EmptyState } from '@/components/ui/panel';
import { simulateFleet, type FleetSnapshot } from '@/lib/data/fleet';
import type { SearchResult } from '@/lib/modules';
import { NodeDetail } from './node-detail';
import { SandboxDetail } from './sandboxes-page';
import { useFleet } from './use-fleet';

// Peeks: a node or a sandbox in the shell's side sheet, from any page (<EntityLink kind="node" id>), and the
// fleet's entries in ⌘K search.

export function NodePeek({ id }: { id: string }) {
  const snapshot = useFleet({ scoped: false });
  const node = snapshot.nodes.find((each) => each.id === id);
  if (!node) return <EmptyState icon={RiServerLine} title="No such node">{id} is not in this fleet.</EmptyState>;
  return <NodeDetail node={node} snapshot={snapshot} compact />;
}

export function SandboxPeek({ id }: { id: string }) {
  const snapshot = useFleet({ scoped: false });
  const sandbox = snapshot.sandboxes.find((each) => each.id === id);
  if (!sandbox) return <EmptyState icon={RiBox3Line} title="Sandbox gone">{id} has expired or was deleted.</EmptyState>;
  return <SandboxDetail sandbox={sandbox} snapshot={snapshot} />;
}

const score = (text: string, query: string) => {
  const index = text.toLowerCase().indexOf(query);
  return index < 0 ? -1 : index === 0 ? 2 : 1;
};

/** Nodes by host, id, rack or label; sandboxes and instances by id; batches by reason; rollouts by version. */
export function searchFleet(query: string, context: { now: number; siteId?: string }): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const snapshot: FleetSnapshot = simulateFleet(Math.floor(context.now / 10_000) * 10_000);
  const inSite = (siteId: string) => !context.siteId || siteId === context.siteId;
  const nodes = snapshot.nodes
    .filter((node) => inSite(node.siteId))
    .map((node) => ({
      node,
      rank: Math.max(score(node.hostname, q), score(node.id, q), score(node.rack, q), ...node.labels.map((label) => score(`${label.key}=${label.value}`, q) - 0.5)),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.node.hostname.localeCompare(b.node.hostname))
    .slice(0, 6)
    .map<SearchResult>(({ node }) => ({
      id: `node:${node.id}`,
      label: node.hostname,
      group: 'Nodes',
      hint: `${node.rack} · ${node.provisionState} · ${node.connectivity}`,
      icon: RiServerLine,
      href: `/nodes/${node.id}`,
      peek: { kind: 'node', id: node.id },
    }));
  const sandboxes = snapshot.sandboxes
    .filter((sandbox) => sandbox.id.toLowerCase().includes(q))
    .slice(0, 3)
    .map<SearchResult>((sandbox) => ({
      id: `sandbox:${sandbox.id}`,
      label: sandbox.id,
      group: 'Sandboxes',
      hint: sandbox.state,
      icon: RiBox3Line,
      href: `/sandboxes?sandbox=${sandbox.id}`,
      peek: { kind: 'sandbox', id: sandbox.id },
    }));
  const instances = snapshot.instances
    .filter((instance) => instance.id.toLowerCase().includes(q))
    .slice(0, 3)
    .map<SearchResult>((instance) => ({ id: `instance:${instance.id}`, label: instance.id, group: 'Instances', hint: `${instance.flavor} · ${instance.state}`, href: `/instances?instance=${instance.id}` }));
  const batches = snapshot.batches
    .filter((batch) => batch.reason.toLowerCase().includes(q) || batch.batchId.includes(q))
    .slice(0, 2)
    .map<SearchResult>((batch) => ({ id: `batch:${batch.batchId}`, label: batch.reason, group: 'Batches', hint: batch.state, href: '/batches' }));
  const rollouts = snapshot.rollouts
    .filter((rollout) => rollout.version.includes(q))
    .slice(0, 2)
    .map<SearchResult>((rollout) => ({ id: `rollout:${rollout.id}`, label: `bcd ${rollout.version}`, group: 'Rollouts', hint: rollout.state, href: '/rollouts' }));
  return [...nodes, ...sandboxes, ...instances, ...batches, ...rollouts].slice(0, 8);
}
