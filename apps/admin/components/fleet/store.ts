'use client';

import { useSyncExternalStore } from 'react';
import type { ComputeEvent, FleetNode, FleetSnapshot } from '@/lib/data/fleet';
import { isSchedulable } from '@/lib/data/fleet';
import { DRAIN_MS, storeState, subscribeFleetActions, type AuditEntry, type FleetActionState, type NodeOverride } from '@/lib/data/fleet-actions';

// The React side of operator actions: the hook over lib/data/fleet-actions.ts, and the overlay of those actions
// on a fleet snapshot (labels, taints, drains, rollout and batch changes, sandbox deletes, acknowledgements).

export { actionsVersion, fleetActions, storeState, type AuditEntry, type NodeOverride } from '@/lib/data/fleet-actions';
type State = FleetActionState;


/** The action overlay; re-renders when an action lands. */
export function useFleetActions(): State {
  return useSyncExternalStore(subscribeFleetActions, storeState, storeState);
}
/** The snapshot with the operator's actions applied. Pure; memoize on (snapshot, actions). */
export function applyActions(snapshot: FleetSnapshot, all: State): FleetSnapshot {
  // Time travel: a view of an earlier moment shows only what operators had done by then.
  const t = snapshot.now;
  const upTo = <V extends { at?: number }>(record: Record<string, V>) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => (value.at ?? 0) <= t)) as Record<string, V>;
  const actions: State = {
    nodes: upTo(all.nodes),
    rollouts: upTo(all.rollouts),
    batches: Object.fromEntries(
      Object.entries(all.batches)
        .map(([id, batch]) => [id, { ...batch, approvals: batch.approvals.filter((approval) => approval.at <= t) }] as const)
        .filter(([, batch]) => batch.approvals.length > 0),
    ),
    discovered: upTo(all.discovered),
    sandboxes: upTo(all.sandboxes),
    audit: all.audit.filter((entry) => entry.at <= t),
  };
  const touched = Object.keys(actions.nodes).length > 0;
  const nodes = touched
    ? snapshot.nodes.map((node) => {
        const override = actions.nodes[node.id];
        return override ? applyNode(node, override, snapshot.now) : node;
      })
    : snapshot.nodes;
  const acknowledged = (nodeId: string, type: string) => actions.nodes[nodeId]?.acknowledged?.[type] !== undefined;
  return {
    ...snapshot,
    nodes,
    incidents: snapshot.incidents.filter((incident) => !acknowledged(incident.nodeId, incident.condition.type)),
    rollouts: snapshot.rollouts.map((rollout) => {
      const override = actions.rollouts[rollout.id];
      if (!override || rollout.state === 'completed') return rollout;
      return { ...rollout, state: override.state, ...(override.reason ? { reason: override.reason } : {}), updatedAt: override.at };
    }),
    batches: snapshot.batches.map((batch) => {
      const override = actions.batches[batch.batchId];
      if (!override) return batch;
      const approved = override.state === 'approved';
      const members = batch.members.map((member) => {
          if (override.state === 'cancelled') return { ...member, state: 'cancelled', awaitingApproval: undefined } as typeof member;
          if (approved) {
            const done = snapshot.now - override.approvals.at(-1)!.at > 20_000;
            const { awaitingApproval: _awaiting, ...rest } = member;
            return { ...rest, state: done ? 'succeeded' : 'running' };
          }
          return member;
        });
      const commands: Record<string, number> = {};
      for (const member of members) commands[member.state] = (commands[member.state] ?? 0) + 1;
      return {
        ...batch,
        approvals: override.approvals,
        ...(override.state ? { state: override.state } : {}),
        ...(approved ? { approvedAt: override.approvals.at(-1)!.at } : {}),
        members,
        commands,
      };
    }),
    discovered: snapshot.discovered
      .filter((machine) => !actions.discovered[machine.mac]?.ignored)
      .map((machine) => {
        const confirmed = actions.discovered[machine.mac]?.confirmedFor;
        return confirmed ? { ...machine, nodeId: confirmed, candidateFor: undefined } : machine;
      }),
    sandboxes: snapshot.sandboxes
      .filter((sandbox) => {
        const deletedAt = actions.sandboxes[sandbox.id]?.deletedAt;
        return deletedAt === undefined || snapshot.now - deletedAt < 15_000;
      })
      .map((sandbox) => {
        const override = actions.sandboxes[sandbox.id];
        if (!override) return sandbox;
        if (override.deletedAt !== undefined) return { ...sandbox, state: 'deleting' as const, instanceState: 'deleting' as const };
        const extend = (override.extendSeconds ?? 0) * 1000;
        return { ...sandbox, expiresAt: sandbox.expiresAt + extend, ttlSeconds: sandbox.ttlSeconds + (override.extendSeconds ?? 0) };
      }),
  };
}

function applyNode(node: FleetNode, override: NodeOverride, now: number): FleetNode {
  const cordoned = override.cordoned ?? node.cordoned;
  const maintenance = override.maintenance ?? node.maintenance;
  const draining = override.drainAt !== undefined && now - override.drainAt < DRAIN_MS;
  const drained = override.drainAt !== undefined && now - override.drainAt >= DRAIN_MS;
  const labels = node.labels
    .filter((label) => !(label.source === 'operator' && override.labels && override.labels[label.key] === null))
    .map((label) => (label.source === 'operator' && typeof override.labels?.[label.key] === 'string' ? { ...label, value: override.labels[label.key]! } : label));
  for (const [key, value] of Object.entries(override.labels ?? {}))
    if (value !== null && !labels.some((label) => label.key === key)) labels.push({ key, value, source: 'operator' });
  const taints = new Set(node.noScheduleReasons.filter((reason) => reason.startsWith('taint:')).map((reason) => reason.slice(6)));
  for (const [key, on] of Object.entries(override.taints ?? {})) {
    if (on) taints.add(key);
    else taints.delete(key);
  }
  const reasons = [
    ...(cordoned ? ['cordoned'] : []),
    ...(maintenance ? ['maintenance'] : []),
    ...node.noScheduleReasons.filter((reason) => reason !== 'cordoned' && reason !== 'maintenance' && !reason.startsWith('taint:')),
    ...[...taints].map((key) => `taint:${key}`),
  ];
  const revoked = override.revokedAt !== undefined;
  const conditions = [
    ...node.conditions,
    ...(draining ? [{ type: 'Draining', status: 'true' as const, reason: 'nodes.drain', message: 'Moving reservations and instances off this node', since: override.drainAt! }] : []),
  ];
  return {
    ...node,
    cordoned,
    maintenance,
    labels,
    noScheduleReasons: reasons,
    conditions,
    ...(drained ? { gpus: node.gpus.map(({ allocation: _a, ...gpu }) => ({ ...gpu, ...(gpu.telemetry ? { telemetry: { ...gpu.telemetry, utilization: 0, powerW: Math.round(gpu.telemetry.powerLimitW * 0.1) } } : {}) })), instanceCount: 0, sandboxCount: 0 } : {}),
    ...(revoked
      ? {
          identityGeneration: node.identityGeneration + 1,
          connectivity: 'disconnected' as const,
          health: 'offline' as const,
          session: { ...node.session, epoch: node.session?.epoch ?? 0, disconnectedAt: override.revokedAt },
        }
      : {}),
    version: node.version + 1,
  };
}

/** Operator actions as events, for the activity stream. */
export function auditEvents(entries: readonly AuditEntry[]): ComputeEvent[] {
  return entries.map((entry) => ({
    id: entry.id,
    type: `operator.${entry.method}`,
    tenantId: 'ten_root',
    subject: entry.subject,
    time: new Date(entry.at).toISOString(),
    sequence: `op-${entry.at}`,
    data: { summary: entry.summary, actor: 'you' },
  }));
}

export { isSchedulable };
