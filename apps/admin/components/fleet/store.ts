'use client';

import { useSyncExternalStore } from 'react';
import type {
  BatchState,
  CommandBatchView,
  ComputeEvent,
  FleetNode,
  FleetSnapshot,
  RolloutState,
} from '@/lib/data/fleet';
import { isSchedulable } from '@/lib/data/fleet';

// Operator actions. In simulated mode the fleet is a pure function of the clock, so what an operator does
// (cordon, drain, label, pause a rollout, approve a batch…) is kept here and laid over every snapshot; each
// action also writes an audit entry the activity stream shows. The live adapter will send the same actions to
// the API (nodes.cordon, rollouts.pause, commandBatches.approve…) and drop this overlay.

export interface NodeOverride {
  /** When the operator last changed it: views of an earlier moment (time travel) don't show it. */
  at?: number;
  cordoned?: boolean;
  /** nodes.drain: cordoned plus workloads moving off, done after `drainMs`. */
  drainAt?: number;
  maintenance?: boolean;
  labels?: Record<string, string | null>;
  taints?: Record<string, boolean>;
  /** nodes.revokeIdentity: the identity generation moved on; the node must rejoin. */
  revokedAt?: number;
  /** Conditions an operator acknowledged (hidden from the attention list until they change). */
  acknowledged?: Record<string, number>;
}

export interface AuditEntry {
  id: string;
  at: number;
  /** The API method this maps to: `nodes.cordon`, `rollouts.pause`, … */
  method: string;
  subject: string;
  summary: string;
}

interface State {
  nodes: Record<string, NodeOverride>;
  rollouts: Record<string, { state: RolloutState; reason?: string; at: number }>;
  batches: Record<string, { approvals: CommandBatchView['approvals']; state?: BatchState }>;
  discovered: Record<string, { confirmedFor?: string; ignored?: boolean; at: number }>;
  sandboxes: Record<string, { deletedAt?: number; extendSeconds?: number; at: number }>;
  audit: AuditEntry[];
}

const DRAIN_MS = 90_000;
let state: State = { nodes: {}, rollouts: {}, batches: {}, discovered: {}, sandboxes: {}, audit: [] };
let version = 0;
const listeners = new Set<() => void>();

function commit(next: State) {
  state = next;
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The action overlay; re-renders when an action lands. */
export function useFleetActions(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
export const actionsVersion = () => version;

let sequence = 0;
function audit(entry: Omit<AuditEntry, 'id'>): AuditEntry {
  return { ...entry, id: `op_${(++sequence).toString(36)}_${entry.at.toString(36)}` };
}

function patchNodes(ids: readonly string[], now: number, method: string, summary: (count: number) => string, patch: (current: NodeOverride) => NodeOverride) {
  const nodes = { ...state.nodes };
  for (const id of ids) nodes[id] = { ...patch(nodes[id] ?? {}), at: now };
  commit({
    ...state,
    nodes,
    audit: [audit({ at: now, method, subject: ids.length === 1 ? `node/${ids[0]}` : `${ids.length} nodes`, summary: summary(ids.length) }), ...state.audit].slice(0, 500),
  });
}

const nodeWord = (n: number) => (n === 1 ? 'node' : `${n} nodes`);

export const fleetActions = {
  cordon(ids: readonly string[], now: number, reason?: string) {
    patchNodes(ids, now, 'nodes.cordon', (n) => `Cordoned ${nodeWord(n)}${reason ? `: ${reason}` : ''}`, (o) => ({ ...o, cordoned: true }));
  },
  uncordon(ids: readonly string[], now: number) {
    patchNodes(ids, now, 'nodes.uncordon', (n) => `Uncordoned ${nodeWord(n)}`, (o) => {
      const { drainAt: _drain, ...rest } = o;
      return { ...rest, cordoned: false };
    });
  },
  drain(ids: readonly string[], now: number, reason?: string) {
    patchNodes(ids, now, 'nodes.drain', (n) => `Drain started on ${nodeWord(n)}${reason ? `: ${reason}` : ''}`, (o) => ({ ...o, cordoned: true, drainAt: now }));
  },
  maintenance(ids: readonly string[], on: boolean, now: number) {
    patchNodes(ids, now, on ? 'metal.manage' : 'metal.provide', (n) => `${on ? 'Entered' : 'Left'} maintenance on ${nodeWord(n)}`, (o) => ({ ...o, maintenance: on }));
  },
  label(ids: readonly string[], set: Record<string, string>, remove: readonly string[], now: number) {
    const parts = [...Object.entries(set).map(([k, v]) => `${k}=${v}`), ...remove.map((k) => `-${k}`)];
    patchNodes(ids, now, 'nodes.label', (n) => `Labels ${parts.join(', ')} on ${nodeWord(n)}`, (o) => ({
      ...o,
      labels: { ...o.labels, ...set, ...Object.fromEntries(remove.map((key) => [key, null])) },
    }));
  },
  taint(ids: readonly string[], add: readonly string[], remove: readonly string[], now: number) {
    const parts = [...add.map((k) => `+${k}`), ...remove.map((k) => `-${k}`)];
    patchNodes(ids, now, 'nodes.taint', (n) => `Taints ${parts.join(', ')} on ${nodeWord(n)}`, (o) => ({
      ...o,
      taints: { ...o.taints, ...Object.fromEntries(add.map((k) => [k, true])), ...Object.fromEntries(remove.map((k) => [k, false])) },
    }));
  },
  revokeIdentity(id: string, now: number) {
    patchNodes([id], now, 'nodes.revokeIdentity', () => 'Revoked the node identity; certificates of earlier generations are refused', (o) => ({ ...o, revokedAt: now }));
  },
  acknowledge(nodeId: string, conditionType: string, now: number) {
    patchNodes([nodeId], now, 'incident.acknowledge', () => `Acknowledged ${conditionType}`, (o) => ({ ...o, acknowledged: { ...o.acknowledged, [conditionType]: now } }));
  },
  rollout(id: string, next: RolloutState, now: number, reason?: string) {
    const method = next === 'paused' ? 'rollouts.pause' : next === 'running' ? 'rollouts.resume' : 'rollouts.abort';
    commit({
      ...state,
      rollouts: { ...state.rollouts, [id]: { state: next, at: now, ...(reason ? { reason } : {}) } },
      audit: [audit({ at: now, method, subject: `rollout/${id}`, summary: `${method.split('.')[1]![0]!.toUpperCase()}${method.split('.')[1]!.slice(1)}d rollout${reason ? `: ${reason}` : ''}` }), ...state.audit],
    });
  },
  approveBatch(batch: CommandBatchView, now: number, approver = 'you@legionedge.ai') {
    const current = state.batches[batch.batchId]?.approvals ?? batch.approvals;
    if (current.some((approval) => approval.approvedBy === approver)) return;
    const approvals = [...current, { kid: 'approver-you', at: now, approvedBy: approver }];
    commit({
      ...state,
      batches: { ...state.batches, [batch.batchId]: { approvals, ...(approvals.length >= batch.requiredApprovals ? { state: 'approved' as const } : {}) } },
      audit: [audit({ at: now, method: 'commandBatches.approve', subject: `commandBatch/${batch.batchId}`, summary: `Approved batch (${approvals.length}/${batch.requiredApprovals}): ${batch.reason}` }), ...state.audit],
    });
  },
  cancelBatch(batch: CommandBatchView, now: number) {
    commit({
      ...state,
      batches: { ...state.batches, [batch.batchId]: { approvals: state.batches[batch.batchId]?.approvals ?? batch.approvals, state: 'cancelled' } },
      audit: [audit({ at: now, method: 'commandBatches.cancel', subject: `commandBatch/${batch.batchId}`, summary: `Cancelled batch: ${batch.reason}` }), ...state.audit],
    });
  },
  confirmMac(mac: string, nodeId: string, now: number) {
    commit({
      ...state,
      discovered: { ...state.discovered, [mac]: { confirmedFor: nodeId, at: now } },
      audit: [audit({ at: now, method: 'metal.confirmMac', subject: `node/${nodeId}`, summary: `Confirmed PXE MAC ${mac}` }), ...state.audit],
    });
  },
  ignoreMac(mac: string, now: number) {
    commit({
      ...state,
      discovered: { ...state.discovered, [mac]: { ignored: true, at: now } },
      audit: [audit({ at: now, method: 'metal.discovered', subject: `mac/${mac}`, summary: `Ignored unknown machine ${mac}` }), ...state.audit],
    });
  },
  deleteSandboxes(ids: readonly string[], now: number) {
    const sandboxes = { ...state.sandboxes };
    for (const id of ids) sandboxes[id] = { ...sandboxes[id], deletedAt: now, at: now };
    commit({
      ...state,
      sandboxes,
      audit: [audit({ at: now, method: 'sandboxes.delete', subject: ids.length === 1 ? `sandbox/${ids[0]}` : `${ids.length} sandboxes`, summary: `Deleted ${ids.length === 1 ? 'sandbox' : `${ids.length} sandboxes`}` }), ...state.audit],
    });
  },
  extendSandboxes(ids: readonly string[], seconds: number, now: number) {
    const sandboxes = { ...state.sandboxes };
    for (const id of ids) sandboxes[id] = { ...sandboxes[id], extendSeconds: (sandboxes[id]?.extendSeconds ?? 0) + seconds, at: now };
    commit({
      ...state,
      sandboxes,
      audit: [audit({ at: now, method: 'sandboxes.extend', subject: ids.length === 1 ? `sandbox/${ids[0]}` : `${ids.length} sandboxes`, summary: `Extended TTL by ${Math.round(seconds / 60)} min` }), ...state.audit],
    });
  },
};

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
