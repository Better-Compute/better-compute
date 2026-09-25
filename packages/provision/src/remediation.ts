import { field, manifest, type Json, type ModuleContext, type SqlTx, type StepDefinition } from '@better-compute/core';
import { clearNodeFaults, healthWorkKind, wakeStartedReservations, type NodeConditionType } from '@better-compute/inventory';
import { batchNodeWorkflow } from './batch.js';
import { awaitCommand } from './command-step.js';
import { defineProfile } from './profile.js';
import { defineStep } from './step.js';

// Remediation (PLAN.md §10.1, v0.2): node-level faults run as workflows that share the pool's
// disruption budget, wait for the node to drain, and stop for a pool whose nodes turn unhealthy
// too fast (the circuit breaker). A successful run clears the fault; a failed or exhausted one
// puts the node in maintenance for an operator.

export { healthWorkKind };
/** How often the health reconciler looks at a node it is waiting on. */
export const healthPollMs = 60_000;

/** The remediation each node-level fault gets. */
export const remediations: Readonly<Partial<Record<NodeConditionType, 'reboot' | 'gpu-reset'>>> = Object.freeze({
  Xid79: 'reboot',
  Xid95: 'reboot',
  RowRemapPending: 'gpu-reset',
});
const remediable = Object.keys(remediations) as NodeConditionType[];
/** Conditions that count toward the circuit breaker. */
const healthConditions: readonly NodeConditionType[] = [
  'Xid48',
  'Xid79',
  'Xid95',
  'RowRemapPending',
  'RowRemapFailed',
  'EccUncorrectable',
  'NvlinkDegraded',
  'PcieReplayHigh',
];

export interface RemediationPolicy {
  /**
   * Share of a pool's nodes that may be disrupted at once (default 5%, at least one node): nodes
   * with any active workflow or a rollout upgrading them. `pools.policy.disruptionBudget` wins.
   */
  disruptionBudget: number;
  /** Open the breaker when more than this share of a pool turned unhealthy within `breakerWindowMs`. */
  breakerThreshold: number;
  breakerWindowMs: number;
  /** Attempts per fault before the node is left to an operator. */
  maxAttempts: number;
}
export const defaultRemediationPolicy: RemediationPolicy = Object.freeze({
  disruptionBudget: 0.05,
  breakerThreshold: 0.1,
  breakerWindowMs: 10 * 60_000,
  maxAttempts: 2,
});

// --- Steps and profiles ------------------------------------------------------------------------------

/** `node.reboot` on the node's own agent; self-terminating, so it completes when the node rejoins. */
export const nodeRebootStep: StepDefinition = defineStep({
  id: 'node.reboot',
  runsOn: 'node',
  command: 'node.reboot',
  await: 'rejoin',
  timeout: '20m',
  retrySafe: true,
  input: manifest({ reason: field.string({ maxLength: 256 }).optional(), delayMs: field.int({ min: 0, max: 60_000 }).optional() }),
});

/** Resets the GPUs with a pending row remap, then has the node re-send its inventory. */
export const resetGpusStep: StepDefinition = defineStep({
  id: 'health.resetGpus',
  runsOn: 'control-plane',
  sends: ['gpu.reset', 'inventory.refresh'],
  relays: ['node'],
  timeout: '15m',
  retrySafe: false,
  input: manifest({}),
  async run(_input, context) {
    const nodeId = context.node?.id;
    if (!nodeId) return { reset: [] };
    const { rows } = await context.sql.query<{ device_id: string }>(
      `SELECT DISTINCT device_id FROM device_health WHERE node_id = $1 AND reason = 'RowRemapPending' ORDER BY device_id`,
      [nodeId],
    );
    const gpuUuids = rows.map((row) => row.device_id);
    if (gpuUuids.length > 0) await awaitCommand(context, { nodeId, kind: 'gpu.reset', key: 'reset', payload: { gpuUuids } });
    await awaitCommand(context, { nodeId, kind: 'inventory.refresh', key: 'refresh', payload: { sections: ['gpus'], rescan: true } });
    return { reset: gpuUuids };
  },
});

export const rebootProfile = defineProfile({
  id: 'remediate-reboot',
  version: 1,
  target: 'metal',
  description: 'Reboot a node after a GPU fault (XID 79/95)',
  steps: [{ use: 'node.reboot', with: { reason: 'health remediation', delayMs: 1000 } }, { use: 'wait.agentJoined', with: { role: 'node' } }],
});
export const gpuResetProfile = defineProfile({
  id: 'remediate-gpu-reset',
  version: 1,
  target: 'metal',
  description: 'Reset GPUs with a pending row remap',
  steps: [{ use: 'health.resetGpus' }],
});

export const remediationSteps: readonly StepDefinition[] = Object.freeze([nodeRebootStep, resetGpusStep]);
export const remediationProfiles = Object.freeze([rebootProfile, gpuResetProfile]);

// --- The health reconciler ---------------------------------------------------------------------------

export type HealthOutcome =
  | { action: 'healthy' }
  | { action: 'waiting'; reason: 'remediating' | 'busy' | 'draining' | 'budget' | 'breaker' }
  | { action: 'started'; workflowId: string; remediation: 'reboot' | 'gpu-reset' }
  | { action: 'cleared'; conditions: NodeConditionType[] }
  | { action: 'escalated'; reason: string };

type Context = Pick<ModuleContext, 'sql' | 'events' | 'work'> & Partial<Pick<ModuleContext, 'workflows' | 'commands' | 'registry'>>;

async function publish(context: Context, tx: SqlTx, tenantId: string, nodeId: string, type: string, data: Record<string, Json>) {
  await context.events.publish(tx, { type, tenantId, subject: `node/${nodeId}`, data: { nodeId, ...data } });
}

/**
 * One pass for one node: decides whether its node-level faults can be remediated now and starts
 * the workflow, or settles the last one. Everything happens in one transaction with the node row
 * locked.
 */
export async function reconcileHealth(
  context: Context,
  nodeId: string,
  policy: RemediationPolicy = defaultRemediationPolicy,
): Promise<HealthOutcome> {
  const outcome = await context.sql.transaction(async (tx): Promise<HealthOutcome> => {
    const nodes = await tx.query<{ pool_id: string | null; owner_tenant_id: string; now: Date; budget: number | null }>(
      `SELECT n.pool_id, n.owner_tenant_id, compute_now() AS now, (p.policy->>'disruptionBudget')::float8 AS budget
         FROM nodes n LEFT JOIN pools p ON p.id = n.pool_id WHERE n.id = $1 FOR UPDATE OF n`,
      [nodeId],
    );
    const node = nodes.rows[0];
    if (!node) return { action: 'healthy' };
    // Health edges (an XID, a finding, a remediation clearing faults) change atom health: the node's
    // started reservations re-derive their Degraded/AtomUnhealthy conditions now.
    await wakeStartedReservations(tx, context.work, nodeId);
    const now = node.now.getTime();
    const faults = await tx.query<{ type: NodeConditionType; since: Date }>(
      `SELECT type, since FROM node_conditions WHERE node_id = $1 AND status = 'true' AND type = ANY($2) ORDER BY type`,
      [nodeId, remediable],
    );
    if (faults.rows.length === 0) return { action: 'healthy' };
    const since = Math.min(...faults.rows.map((row) => row.since.getTime()));

    const runs = await tx.query<{ id: string; state: string; profile_id: string; finished_at: Date | null }>(
      `SELECT id, state, profile_id, finished_at FROM workflows
        WHERE node_id = $1 AND owner = $2 AND created_at >= to_timestamp($3 / 1000.0) ORDER BY created_at DESC, id DESC`,
      [nodeId, healthWorkKind, since],
    );
    const last = runs.rows[0];
    if (last && ['pending', 'running', 'paused'].includes(last.state)) return { action: 'waiting', reason: 'remediating' };
    if (last?.state === 'succeeded') {
      // A reboot clears XID faults; a GPU reset is confirmed by the next inventory (row remap no
      // longer pending), so its condition clears there, and a still-pending one is tried again.
      const cleared = faults.rows.map((row) => row.type).filter((type) => type !== 'RowRemapPending');
      if (cleared.length > 0) {
        await clearNodeFaults(tx, nodeId, cleared);
        await publish(context, tx, node.owner_tenant_id, nodeId, 'node.remediation.succeeded', { conditions: cleared, workflowId: last.id });
        return { action: 'cleared', conditions: cleared };
      }
    }
    if (last?.state === 'failed' || last?.state === 'cancelled' || runs.rows.length >= policy.maxAttempts) {
      const reason = last?.state === 'failed' || last?.state === 'cancelled' ? `remediation ${last.state}` : `${runs.rows.length} attempts did not clear the fault`;
      await tx.query('UPDATE nodes SET maintenance = true, version = version + 1 WHERE id = $1 AND NOT maintenance', [nodeId]);
      await publish(context, tx, node.owner_tenant_id, nodeId, 'node.remediation.escalated', { reason, conditions: faults.rows.map((r) => r.type) });
      return { action: 'escalated', reason };
    }

    const busy = await tx.query(`SELECT 1 FROM workflows WHERE node_id = $1 AND state IN ('pending', 'running', 'paused')`, [nodeId]);
    if (busy.rowCount) return { action: 'waiting', reason: 'busy' };
    // Drain: NoSchedule already keeps new work away; remediation waits for live allocations to end.
    const live = await tx.query(
      `SELECT 1 FROM allocations WHERE node_id = $1 AND released_at IS NULL AND (upper_inf(during) OR upper(during) > compute_now()) LIMIT 1`,
      [nodeId],
    );
    if (live.rowCount) return { action: 'waiting', reason: 'draining' };

    // The pool's disruption budget is shared with rollouts (§10.1): a node is disrupted while any
    // workflow runs on it (deploys disrupt too) or while a rollout upgrades or rolls it back.
    const rollouts = await tx.query<{ present: boolean }>(`SELECT to_regclass('rollout_nodes') IS NOT NULL AS present`);
    const rolloutClause = rollouts.rows[0]?.present
      ? `OR EXISTS (SELECT 1 FROM rollout_nodes r WHERE r.node_id = n.id AND r.state IN ('upgrading', 'rolling-back'))`
      : '';
    const pool = await tx.query<{ nodes: number; remediating: number; unhealthy: number }>(
      `SELECT count(*)::int AS nodes,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM workflows w WHERE w.node_id = n.id AND $3::text IS NOT NULL
                                              AND w.state IN ('pending', 'running', 'paused')) ${rolloutClause})::int AS remediating,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM node_conditions c WHERE c.node_id = n.id AND c.status = 'true'
                                              AND c.type = ANY($4) AND c.since > compute_now() - make_interval(secs => $5 / 1000.0)))::int AS unhealthy
         FROM nodes n WHERE (n.pool_id = $1) OR ($1::text IS NULL AND n.id = $2)`,
      [node.pool_id, nodeId, healthWorkKind, healthConditions, policy.breakerWindowMs],
    );
    const stats = pool.rows[0]!;
    // The pool's own `policy.disruptionBudget` wins over the module default (§10.1).
    const budget = node.budget !== null && node.budget >= 0 && node.budget <= 1 ? node.budget : policy.disruptionBudget;
    const allowed = Math.max(1, Math.floor(stats.nodes * budget));
    if (stats.remediating >= allowed) return { action: 'waiting', reason: 'budget' };
    if (stats.nodes > 1 && stats.unhealthy / stats.nodes > policy.breakerThreshold) {
      await publish(context, tx, node.owner_tenant_id, nodeId, 'pool.remediation.paused', {
        poolId: node.pool_id,
        unhealthy: stats.unhealthy,
        nodes: stats.nodes,
      });
      return { action: 'waiting', reason: 'breaker' };
    }

    if (!context.workflows) return { action: 'waiting', reason: 'busy' };
    const kind = faults.rows.some((row) => remediations[row.type] === 'reboot') ? 'reboot' : 'gpu-reset';
    const profile = kind === 'reboot' ? rebootProfile : gpuResetProfile;
    const input = { tenantId: node.owner_tenant_id, profileId: profile.id, profileVersion: profile.version, nodeId, owner: healthWorkKind };
    const { id } = await context.workflows.start(tx, input);
    // Reboots and GPU resets are destructive: with a quorum, they run under a batch of their own (§13).
    await batchNodeWorkflow(context, tx, id, { tenantId: node.owner_tenant_id, nodeId, reason: `remediation ${kind} ${nodeId}` });
    await publish(context, tx, node.owner_tenant_id, nodeId, 'node.remediation.started', { workflowId: id, remediation: kind });
    return { action: 'started', workflowId: id, remediation: kind };
  });
  if (outcome.action === 'waiting' || outcome.action === 'started')
    await context.sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
      await context.work.enqueue(tx, healthWorkKind, nodeId, { notBefore: rows[0]!.now.getTime() + healthPollMs });
    });
  return outcome;
}
