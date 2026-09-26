import { describeCondition, nodeSeverity, simulateFleet, type FleetSnapshot } from '@/lib/data/fleet';
import { liveSnapshot } from '@/lib/data/fleet-live';
import { fmtDuration } from '@/lib/data/format';
import type { AttentionContext, WatchState } from '@/lib/modules';
import { currentLiveParts } from './live';
import { applyActions, storeState } from './store';

// Watch-list describers: one line of state per watched node, sandbox, rollout or batch, from the same snapshot the
// fleet pages show (simulation plus operator actions, or the live poller's last answer). Pure in (id, now, source);
// a status change raises the shell's toast while live.

function snapshotAt(now: number, context: AttentionContext): FleetSnapshot | undefined {
  const at = Math.floor(now / 10_000) * 10_000;
  if (context.source === 'live') {
    const parts = currentLiveParts();
    return parts ? liveSnapshot(parts, at) : undefined;
  }
  return applyActions(simulateFleet(at), storeState());
}

export function watchNode(id: string, now: number, context: AttentionContext): WatchState | null {
  const node = snapshotAt(now, context)?.nodes.find((each) => each.id === id);
  if (!node) return null;
  const booked = node.gpus.filter((gpu) => gpu.allocation).length;
  const worst = node.conditions.find((condition) => condition.status === 'true' && describeCondition(condition.type).severity !== 'info');
  const severity = nodeSeverity(node);
  const offline = node.connectivity === 'unreachable' || node.connectivity === 'lost' || node.health === 'offline';
  const draining = node.conditions.some((condition) => condition.type === 'Draining');
  const status: WatchState['status'] = offline || severity === 'critical' || node.provisionState === 'failed'
    ? 'crit'
    : severity === 'warning' || node.cordoned || draining || node.maintenance
      ? 'warn'
      : node.health === 'provisioning'
        ? 'pending'
        : 'ok';
  const state = offline ? node.connectivity : draining ? 'draining' : worst ? `degraded: ${describeCondition(worst.type).label}` : node.cordoned ? 'cordoned' : node.health === 'provisioning' ? node.provisionState : 'ready';
  const parts = [state];
  if (node.gpus.length) parts.push(`${booked}/${node.gpus.length} GPUs booked`);
  if (node.daemonVersion !== '—') parts.push(`bcd ${node.daemonVersion}`);
  return { label: node.hostname, status, summary: parts.join(' · '), href: `/nodes/${node.id}` };
}

export function watchSandbox(id: string, now: number, context: AttentionContext): WatchState | null {
  const sandbox = snapshotAt(now, context)?.sandboxes.find((each) => each.id === id);
  if (!sandbox) return { label: id, status: 'off', summary: 'deleted or expired', href: '/sandboxes' };
  const left = sandbox.expiresAt - now;
  const status: WatchState['status'] =
    sandbox.state === 'failed' ? 'crit' : sandbox.state === 'starting' ? 'pending' : sandbox.state === 'ready' ? (left < 5 * 60_000 ? 'warn' : 'live') : 'off';
  return {
    label: id,
    status,
    summary: sandbox.state === 'ready' ? `ready · expires in ${fmtDuration(Math.max(0, left))}` : sandbox.state,
    href: `/sandboxes?sandbox=${id}`,
  };
}

export function watchRollout(id: string, now: number, context: AttentionContext): WatchState | null {
  const rollout = snapshotAt(now, context)?.rollouts.find((each) => each.id === id);
  if (!rollout) return null;
  const total = rollout.nodeList.length || Object.values(rollout.nodes).reduce((sum, count) => sum + count, 0);
  const status: WatchState['status'] =
    rollout.state === 'aborted' || rollout.nodes.failed > 0 ? 'crit' : rollout.state === 'paused' ? 'warn' : rollout.state === 'running' ? 'live' : 'ok';
  const summary =
    rollout.state === 'completed'
      ? `completed · ${rollout.nodes.succeeded} upgraded`
      : `${rollout.state} · wave ${rollout.wave + 1}/${rollout.waves.length} · ${rollout.nodes.succeeded}/${total} upgraded${rollout.nodes.failed ? ` · ${rollout.nodes.failed} failed` : ''}`;
  return { label: `bcd ${rollout.version}`, status, summary, href: '/rollouts' };
}

export function watchBatch(id: string, now: number, context: AttentionContext): WatchState | null {
  const batch = snapshotAt(now, context)?.batches.find((each) => each.batchId === id);
  if (!batch) return null;
  const status: WatchState['status'] = batch.state === 'pending' ? 'pending' : batch.state === 'approved' ? 'live' : 'off';
  const summary =
    batch.state === 'pending'
      ? `awaiting signatures · ${batch.approvals.length}/${batch.requiredApprovals} · expires in ${fmtDuration(Math.max(0, batch.notAfter - now))}`
      : batch.state === 'approved'
        ? `approved · ${batch.commands.succeeded ?? 0}/${batch.scopeSize} done`
        : batch.state;
  return { label: batch.reason, status, summary, href: '/batches' };
}
