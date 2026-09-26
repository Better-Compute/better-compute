// Operator actions, outside React so every module reads one truth: fleet-health.ts (and through it capacity's
// placement, previews and insights) sees cordons, drains and maintenance; the fleet pages lay the rest over their
// snapshot (components/fleet/store.ts). In simulated mode the fleet is a pure function of the clock, so what an
// operator does is kept here, stamped with when it happened (time travel shows only what had been done by then),
// and each action writes an audit entry the activity stream shows. Live mode sends actions to the API instead.

import type { BatchState, CommandBatchView, RolloutState } from './fleet';
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

export interface FleetActionState {
  nodes: Record<string, NodeOverride>;
  rollouts: Record<string, { state: RolloutState; reason?: string; at: number }>;
  batches: Record<string, { approvals: CommandBatchView['approvals']; state?: BatchState }>;
  discovered: Record<string, { confirmedFor?: string; ignored?: boolean; at: number }>;
  sandboxes: Record<string, { deletedAt?: number; extendSeconds?: number; at: number }>;
  audit: AuditEntry[];
}

/** A drain moves work off within this long; the node stays cordoned afterwards. */
export const DRAIN_MS = 90_000;
let state: FleetActionState = { nodes: {}, rollouts: {}, batches: {}, discovered: {}, sandboxes: {}, audit: [] };
let version = 0;
const listeners = new Set<() => void>();

function commit(next: FleetActionState) {
  state = next;
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to changes (useSyncExternalStore in components/fleet/store.ts). */
export { subscribe as subscribeFleetActions };
export const actionsVersion = () => version;
/** The overlay outside React (tests, pure callers). */
export const storeState = () => state;

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

