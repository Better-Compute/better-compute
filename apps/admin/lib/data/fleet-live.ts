// Live mode: the fleet snapshot built from the real API's answers instead of the simulation. Pure mapping only;
// components/fleet/live.ts fetches. Fields the list methods don't return (GPU telemetry, labels, rack placement)
// stay empty rather than invented, and the pages show "—" for them.

import type {
  CommandBatchView,
  ComputeEvent,
  FleetNode,
  FleetSnapshot,
  FleetStatus,
  Instance,
  NodeInfo,
  Rollout,
  RolloutNode,
  RolloutNodeState,
  Sandbox,
  SandboxTemplate,
  SandboxVolume,
} from './fleet';
import { fleetIncidents } from './fleet';
import type { NodeHealth } from './fleet-health';

export interface LiveParts {
  tenantId: string;
  nodes: NodeInfo[];
  instances?: Instance[];
  sandboxes?: Sandbox[];
  templates?: SandboxTemplate[];
  volumes?: SandboxVolume[];
  rollouts?: Rollout[];
  batches?: CommandBatchView[];
  drift?: FleetStatus;
  events?: ComputeEvent[];
}

const TRANSIT = new Set(['adopting', 'enrolling', 'inspecting', 'commissioning', 'deploying', 'releasing', 'retiring']);

export function liveHealth(node: NodeInfo): NodeHealth {
  if (node.connectivity === 'unreachable' || node.connectivity === 'lost') return 'offline';
  if (TRANSIT.has(node.provisionState)) return 'provisioning';
  if (node.connectivity === 'disconnected') return 'offline';
  const reasons = node.noScheduleReasons.filter((reason) => reason !== 'cordoned' && reason !== 'maintenance' && !reason.startsWith('taint:'));
  return reasons.length || node.provisionState === 'failed' ? 'degraded' : 'ready';
}

/** A list row as a FleetNode: conditions come from its NoSchedule reasons (the list carries no messages). */
export function liveNode(node: NodeInfo, now: number): FleetNode {
  const conditionTypes = node.noScheduleReasons.filter((reason) => reason !== 'cordoned' && reason !== 'maintenance' && !reason.startsWith('taint:'));
  return {
    ...node,
    labels: [],
    conditions: conditionTypes.map((type) => ({ type, status: 'true' as const, reason: 'NoSchedule', since: now })),
    hostname: node.id,
    rack: '—',
    unit: 0,
    heightU: 0,
    poolKind: 'gpu',
    health: liveHealth(node),
    power: 'unknown',
    daemonVersion: '—',
    gpus: [],
    cpu: { model: '—', vcpus: 0 },
    memoryGiB: 0,
    instanceCount: 0,
    sandboxCount: 0,
  };
}

const ROLLOUT_STATES: RolloutNodeState[] = ['pending', 'upgrading', 'succeeded', 'failed', 'skipped', 'rolling-back', 'rolled-back'];

export function liveSnapshot(parts: LiveParts, now: number): FleetSnapshot {
  const nodes = parts.nodes.map((node) => liveNode(node, now));
  const byNode = new Map<string, FleetNode>(nodes.map((node) => [node.id, node]));
  for (const instance of parts.instances ?? []) if (instance.nodeId && byNode.has(instance.nodeId)) byNode.get(instance.nodeId)!.instanceCount += 1;
  for (const sandbox of parts.sandboxes ?? []) if (sandbox.nodeId && byNode.has(sandbox.nodeId)) byNode.get(sandbox.nodeId)!.sandboxCount += 1;
  return {
    seed: 'live',
    now,
    simulated: false,
    tenantId: parts.tenantId,
    sites: [],
    pools: [],
    nodes,
    instances: parts.instances ?? [],
    sandboxes: parts.sandboxes ?? [],
    templates: parts.templates ?? [],
    volumes: parts.volumes ?? [],
    snapshots: (parts.sandboxes ?? []).flatMap((sandbox) => sandbox.snapshots ?? []),
    rollouts: (parts.rollouts ?? []).map((rollout) => ({
      ...rollout,
      nodes: { ...Object.fromEntries(ROLLOUT_STATES.map((state) => [state, 0])), ...rollout.nodes } as Rollout['nodes'],
      nodeList: (rollout as Rollout & { nodeList?: RolloutNode[] }).nodeList ?? [],
    })),
    batches: (parts.batches ?? []).map((batch) => ({ ...batch, members: (batch as CommandBatchView & { members?: FleetSnapshot['batches'][number]['members'] }).members ?? [] })),
    drift: parts.drift ?? { tenantId: parts.tenantId },
    discovered: [],
    workflows: [],
    incidents: fleetIncidents(nodes),
  };
}
