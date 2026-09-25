import {
  ComputeError,
  isComputeError,
  type Json,
  type ModuleContext,
  type ProvisionState,
  type SqlTx,
} from '@better-compute/core';
import { stateProfile, workflowStates } from './profiles.js';
import { applyProvisionVerb, readMetalNode, setMetalWorkflow, type MetalNodeRow } from './store.js';
import { dueNodeLease, leaseEnded, markLeaseBound, newIdentityGeneration, tenantRootPolicy } from './tenant-root.js';

// The metal reconciler (key: node id). Level-triggered: for a node in a workflow-driven provision
// state it makes sure exactly that state's workflow runs, and when the workflow ends it applies
// `complete` or `fail` (§11.1). The workflow engine queues this reconciler when a workflow it owns
// finishes (`owner: 'metal'`); a slow poll covers anything missed.

export const metalWorkKind = 'metal';
/** How often an active workflow is looked at when nothing wakes the reconciler sooner. */
export const metalPollMs = 30_000;

export type MetalReconcileOutcome =
  | { action: 'idle'; state: ProvisionState }
  | { action: 'started'; state: ProvisionState; workflowId: string }
  | { action: 'waiting'; state: ProvisionState; workflowId: string }
  | { action: 'completed'; from: ProvisionState; to: ProvisionState }
  | { action: 'failed'; from: ProvisionState; error: Json }
  | { action: 'missing' };

type Context = Pick<ModuleContext, 'sql' | 'events' | 'work'> & Partial<Pick<ModuleContext, 'workflows'>>;

async function publish(context: Context, tx: SqlTx, node: MetalNodeRow, type: string, data: Record<string, Json>) {
  await context.events.publish(tx, { type, tenantId: node.tenant_id, subject: `node/${node.node_id}`, data: { nodeId: node.node_id, ...data } });
}

/** A release is complete only when its wipe step ran and its result is attested (§11.1 invariant). */
async function releaseVerified(tx: SqlTx, workflowId: string, mode: string): Promise<boolean> {
  if (mode === 'none') return true;
  const { rows } = await tx.query<{ result: { attested?: boolean } | null }>(
    `SELECT result FROM workflow_steps WHERE workflow_id = $1 AND action = 'disk.wipe' AND phase = 'main' AND state = 'succeeded'`,
    [workflowId],
  );
  return rows.length > 0 && rows.every((row) => row.result?.attested === true);
}

/**
 * Dedicated-root leases (tenant-root.ts). A ready node with a due node-binding allocation in a
 * `tenantRoot` pool starts its lease: tenant-controlled trust, the platform identity revoked, and the
 * lessee's profile deploying. A deployed tenant-root node whose lease ended starts its teardown.
 */
async function leaseTransition(context: Context, tx: SqlTx, node: MetalNodeRow): Promise<MetalReconcileOutcome | undefined> {
  const state = node.provision_state;
  if (state === 'ready' && !node.maintenance && !node.lease_allocation_id) {
    const lease = await dueNodeLease(tx, node.node_id);
    if (!lease || !tenantRootPolicy(node.pool_policy).allowed) return undefined;
    if (!lease.profileId || !Number.isInteger(lease.profileVersion) || lease.profileVersion < 1) {
      await publish(context, tx, node, 'node.tenant-root.refused', { allocationId: lease.allocationId, reason: 'the reservation names no metal profile' });
      return undefined;
    }
    await tx.query(
      `UPDATE metal_nodes SET lease_allocation_id = $2, tenant_root = true, deploy_profile_id = $3, deploy_profile_version = $4,
         release_wipe = 'secure-erase', updated_at = compute_now(), version = version + 1 WHERE node_id = $1`,
      [node.node_id, lease.allocationId, lease.profileId, lease.profileVersion],
    );
    // The next join is the lessee's OS: JoinService issues it a node-tenant certificate.
    await tx.query(`UPDATE nodes SET trust = 'tenant-controlled' WHERE id = $1`, [node.node_id]);
    await newIdentityGeneration(tx, node.node_id, 'tenant-root-lease');
    Object.assign(node, { lease_allocation_id: lease.allocationId, tenant_root: true, trust: 'tenant-controlled' });
    const to = await applyProvisionVerb(tx, node, 'deploy');
    await publish(context, tx, node, 'node.tenant-root.leased', {
      allocationId: lease.allocationId,
      reservationId: lease.reservationId,
      lesseeTenantId: lease.tenantId,
      profileId: lease.profileId,
      profileVersion: lease.profileVersion,
    });
    return { action: 'completed', from: state, to };
  }
  if (state === 'deployed' && node.tenant_root && node.lease_allocation_id && (await leaseEnded(tx, node.lease_allocation_id))) {
    const to = await applyProvisionVerb(tx, node, 'release');
    await publish(context, tx, node, 'node.tenant-root.ending', { allocationId: node.lease_allocation_id });
    return { action: 'completed', from: state, to };
  }
  return undefined;
}

/** One reconcile transition, in one transaction. */
async function step(context: Context, nodeId: string): Promise<MetalReconcileOutcome> {
  return context.sql.transaction(async (tx) => {
    let node: MetalNodeRow;
    try {
      node = await readMetalNode(tx, nodeId, { lock: true });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return { action: 'missing' };
      throw error;
    }
    const leased = await leaseTransition(context, tx, node);
    if (leased) return leased;
    const state = node.provision_state;
    if (!workflowStates.includes(state)) return { action: 'idle', state };

    if (node.workflow_id && node.phase === state) {
      const { rows } = await tx.query<{ state: string; error: Json | null; profile_document: { role?: string } | null }>(
        'SELECT state, error, profile_document FROM workflows WHERE id = $1',
        [node.workflow_id],
      );
      const workflow = rows[0];
      if (workflow && ['pending', 'running', 'paused'].includes(workflow.state))
        return { action: 'waiting', state, workflowId: node.workflow_id };
      if (workflow?.state === 'succeeded') {
        if (state === 'rescue') return { action: 'idle', state };
        const unverifiedOk = node.pool_agent === 'none' && node.pool_policy?.allowUnverifiedRelease === true;
        if (state === 'releasing' && unverifiedOk)
          await publish(context, tx, node, 'node.release.unverified', { workflowId: node.workflow_id, reason: 'agentless pool; allowUnverifiedRelease' });
        else if (state === 'releasing' && !(await releaseVerified(tx, node.workflow_id, node.release_wipe))) {
          const error = { code: 'UNVERIFIED_WIPE', message: 'the release wipe is not attested; the node does not return to ready' };
          await applyProvisionVerb(tx, node, 'fail', { error });
          await setMetalWorkflow(tx, nodeId, null, null);
          await publish(context, tx, node, 'node.provision.failed', { from: state, error });
          return { action: 'failed', from: state, error };
        }
        const role = state === 'deploying' ? (workflow.profile_document?.role ?? 'host') : undefined;
        const to = await applyProvisionVerb(tx, node, 'complete', role ? { role } : {});
        await setMetalWorkflow(tx, nodeId, null, null);
        // A dedicated-root lease is bound once its deploy is done; capacity takes it from there.
        if (state === 'deploying' && node.lease_allocation_id && (await markLeaseBound(tx, context.work, node.lease_allocation_id)))
          await publish(context, tx, node, 'node.tenant-root.bound', { allocationId: node.lease_allocation_id });
        await publish(context, tx, node, `node.provision.${to}`, { from: state, workflowId: node.workflow_id });
        return { action: 'completed', from: state, to };
      }
      // Failed or cancelled (an abort already moved the node; a stray cancel fails it now).
      const error = (workflow?.error ?? { code: 'WORKFLOW_LOST', message: `workflow ${node.workflow_id} is gone` }) as Json;
      await applyProvisionVerb(tx, node, 'fail', { error });
      await setMetalWorkflow(tx, nodeId, null, null);
      await publish(context, tx, node, 'node.provision.failed', { from: state, error });
      return { action: 'failed', from: state, error };
    }

    if (!context.workflows)
      throw new ComputeError('INVALID_CONFIG', 'metal() needs the provision module: ModuleContext.workflows is not set');
    let profileId: string;
    let profileVersion: number;
    let tenantId = node.tenant_id;
    if (state === 'deploying') {
      if (!node.deploy_profile_id || !node.deploy_profile_version)
        throw new ComputeError('INVALID_STATE', `Node ${nodeId} is deploying without a profile`);
      profileId = node.deploy_profile_id;
      profileVersion = node.deploy_profile_version;
      // A leased node deploys the lessee's profile, resolved in the lessee's tenant.
      if (node.lease_allocation_id) {
        const { rows } = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM allocations WHERE id = $1', [node.lease_allocation_id]);
        if (rows[0]) tenantId = rows[0].tenant_id;
      }
    } else {
      const profile = stateProfile(state, node.pool_agent, { tenantRoot: node.tenant_root });
      if (!profile) {
        // Rescue boots a ramdisk, which an agentless machine never runs.
        const error = { code: 'UNSUPPORTED', message: `${state} needs an agent; pool ${node.pool_id} has agent 'none'` };
        await applyProvisionVerb(tx, node, 'fail', { error });
        await publish(context, tx, node, 'node.provision.failed', { from: state, error });
        return { action: 'failed', from: state, error };
      }
      profileId = profile.id;
      profileVersion = profile.version;
    }
    // `owner` is provision's addition to the core input: the engine wakes this reconciler on finish.
    const input = { tenantId, profileId, profileVersion, nodeId, owner: metalWorkKind };
    const { id } = await context.workflows.start(tx, input);
    await setMetalWorkflow(tx, nodeId, state, id);
    await publish(context, tx, node, 'node.provision.workflow', { state, workflowId: id, profileId, profileVersion });
    return { action: 'started', state, workflowId: id };
  });
}

/**
 * Reconciles one node until it waits or rests: starts the current state's workflow, and settles
 * finished ones (chaining enrolling → inspecting → commissioning → ready without a caller).
 */
export async function reconcileMetalNode(context: Context, nodeId: string): Promise<MetalReconcileOutcome[]> {
  const outcomes: MetalReconcileOutcome[] = [];
  for (let i = 0; i < 8; i++) {
    let outcome: MetalReconcileOutcome;
    try {
      outcome = await step(context, nodeId);
    } catch (error) {
      // Another workflow still holds the node (an abort's cleanup): try again later.
      if (isComputeError(error, 'CONFLICT')) {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
          await context.work.enqueue(tx, metalWorkKind, nodeId, { notBefore: rows[0]!.now.getTime() + 5_000 });
        });
        break;
      }
      throw error;
    }
    outcomes.push(outcome);
    if (outcome.action === 'waiting' || outcome.action === 'started') {
      await context.sql.transaction(async (tx) => {
        const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
        await context.work.enqueue(tx, metalWorkKind, nodeId, { notBefore: rows[0]!.now.getTime() + metalPollMs });
      });
      break;
    }
    if (outcome.action !== 'completed') break;
  }
  return outcomes;
}
