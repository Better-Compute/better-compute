import { describeCondition, scopeFleet, simulateFleet } from '@/lib/data/fleet';
import { fmtDuration } from '@/lib/data/format';
import type { AttentionItem } from '@/lib/data/platform';
import { poolById, siteById } from '@/lib/data/topology';

// The fleet's entries in the operator's attention queue, from the same snapshot the fleet pages show: node
// incidents (XID and device faults, unreachable nodes, failed acceptance), a paused or failing rollout, batches
// waiting for signatures and unknown machines on PXE. Pure in (now, scope), so time travel works; called every
// 10 s, so the snapshot is bucketed to 10 s (memoized in simulateFleet).

const MAX_NODE_ITEMS = 10;

export function fleetAttention(now: number, scope: { siteId?: string } = {}): AttentionItem[] {
  const at = Math.floor(now / 10_000) * 10_000;
  const snapshot = scopeFleet(simulateFleet(at), scope.siteId);
  const items: AttentionItem[] = [];

  // One item per node: its worst condition, with how many more it has. Critical first, then warnings.
  const seen = new Set<string>();
  for (const incident of snapshot.incidents) {
    if (incident.severity === 'info' || seen.has(incident.nodeId)) continue;
    seen.add(incident.nodeId);
    if (seen.size > MAX_NODE_ITEMS) break;
    const node = snapshot.nodes.find((each) => each.id === incident.nodeId);
    const more = node ? node.conditions.filter((c) => c.status === 'true' && c.type !== incident.condition.type && describeCondition(c.type).severity !== 'info').length : 0;
    const pool = incident.poolId ? poolById(incident.poolId) : undefined;
    const booked = node?.gpus.filter((gpu) => gpu.allocation).length ?? 0;
    items.push({
      id: `fleet:${incident.id}`,
      severity: incident.severity,
      title: `${describeCondition(incident.condition.type).label} on ${incident.hostname}`,
      detail: [
        incident.condition.message,
        pool ? `${pool.short} · ${siteById(incident.siteId)?.name ?? incident.siteId}` : undefined,
        booked ? `${booked} booked GPU${booked === 1 ? '' : 's'}` : undefined,
        more ? `+${more} more condition${more === 1 ? '' : 's'}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      source: 'fleet',
      href: `/nodes/${incident.nodeId}`,
      at: incident.condition.since,
      subject: `node/${incident.nodeId}`,
    });
  }
  const hidden = new Set(snapshot.incidents.filter((i) => i.severity !== 'info').map((i) => i.nodeId)).size - Math.min(seen.size, MAX_NODE_ITEMS);
  if (hidden > 0)
    items.push({
      id: 'fleet:more-nodes',
      severity: 'warning',
      title: `${hidden} more nodes need attention`,
      detail: 'The rest of the node incidents, worst first.',
      source: 'fleet',
      href: '/nodes?preset=attention',
      at,
      subject: 'nodes',
    });

  const rollout = snapshot.rollouts.find((each) => each.state === 'running' || each.state === 'paused');
  if (rollout && (rollout.state === 'paused' || rollout.nodes.failed > 0)) {
    const done = rollout.nodes.succeeded + rollout.nodes.failed;
    const ratio = done ? rollout.nodes.failed / done : 0;
    items.push({
      id: `fleet:rollout:${rollout.id}`,
      severity: ratio >= rollout.maxFailureRatio ? 'critical' : 'warning',
      title: rollout.state === 'paused' ? `Rollout of bcd ${rollout.version} paused at wave ${rollout.wave + 1}` : `bcd ${rollout.version}: ${rollout.nodes.failed} node${rollout.nodes.failed === 1 ? '' : 's'} failed to upgrade`,
      detail: rollout.reason ?? `${(ratio * 100).toFixed(1)}% failed of a ${(rollout.maxFailureRatio * 100).toFixed(0)}% gate; ${rollout.nodes.pending} nodes still to go.`,
      source: 'fleet',
      href: '/rollouts',
      at: rollout.updatedAt,
      subject: `rollout/${rollout.id}`,
    });
  }

  for (const batch of snapshot.batches.filter((each) => each.state === 'pending'))
    items.push({
      id: `fleet:batch:${batch.batchId}`,
      severity: batch.notAfter - at < 30 * 60_000 ? 'critical' : 'warning',
      title: `Batch awaiting approval: ${batch.members[0]?.kind ?? 'commands'} × ${batch.scopeSize}`,
      detail: `${batch.reason} · ${batch.approvals.length}/${batch.requiredApprovals} signed · expires in ${fmtDuration(Math.max(0, batch.notAfter - at))}${batch.createdByAgent ? ` · proposed by ${batch.createdByAgent}` : ''}`,
      source: 'fleet',
      href: '/batches',
      at: batch.createdAt,
      subject: `commandBatch/${batch.batchId}`,
    });

  const unknown = snapshot.discovered.filter((machine) => !machine.nodeId);
  if (unknown.length)
    items.push({
      id: 'fleet:pxe',
      severity: 'info',
      title: `${unknown.length} unknown machine${unknown.length === 1 ? '' : 's'} PXE booting`,
      detail: [...new Set(unknown.map((machine) => siteById(machine.siteId)?.name ?? machine.siteId))].join(', ') + ' · confirm a MAC or ignore them',
      source: 'fleet',
      href: '/metal',
      at: Math.max(...unknown.map((machine) => (machine.firstSeen ? Date.parse(machine.firstSeen) : at))),
      subject: 'metal/discovered',
    });

  return items;
}
