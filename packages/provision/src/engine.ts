import {
  ComputeError,
  newId,
  stepStateTable,
  targets,
  workflowStateTable,
  type Json,
  type StepVerb,
  type WorkflowVerb,
  type ModuleContext,
  type NodeRef,
  type ProfileDocument,
  type SqlTx,
  type StepContext,
  type StepState,
  type WorkflowState,
} from '@better-compute/core';
import {
  driverInvokeKind,
  evaluateWhen,
  expandProfileOrThrow,
  type PlannedStep,
  type StepPhase,
  type StepRegistry,
} from './expand.js';
import { releaseImagePins } from './site-cache.js';
import { batchOf, plannedCommandKinds } from './batch.js';

// The workflow engine (PLAN.md §11.2).
//
// Every transition is one transaction that locks the workflow row, so the reconciler and the API
// verbs (abort, pause, resume, retry) serialize on it. A control-plane step is marked `running` in
// one transaction, runs outside any transaction, and is settled in another that first checks the
// step is still running with the same attempt; a crash in between re-runs it under the same
// idempotency key. Any other step is exactly one command, and the step waits on it (or, with
// `await: 'rejoin'`, on the agent coming back with a new boot or role).

/** The work-queue kind (and reconciler name) of workflows. Keys are node ids, else workflow ids. */
export const workflowWorkKind = 'workflow';
/** How often a waiting step is looked at again when nothing wakes it sooner. */
export const workflowPollMs = 10_000;

/** Thrown by a control-plane step that cannot finish yet; it is run again after `retryAfterMs`. */
export class StepNotReady extends Error {
  constructor(readonly retryAfterMs = 5_000) {
    super('The step is not ready yet');
    this.name = 'StepNotReady';
  }
}
/** A control-plane step's way of saying "not yet, look again later" (until its timeout). */
export const stepNotReady = (retryAfterMs?: number): StepNotReady => new StepNotReady(retryAfterMs);

/** Where profiles come from: stored ones first, then the ones modules ship. */
export interface ProfileSource {
  get(tx: SqlTx, tenantId: string, id: string, version: number): Promise<ProfileDocument | undefined>;
}

/** What the engine needs from the host. */
export type EngineContext = Pick<ModuleContext, 'work' | 'events' | 'commands'> & Partial<ModuleContext>;

export interface EngineOptions {
  steps: StepRegistry;
  profiles: ProfileSource;
}

// --- Rows ------------------------------------------------------------------------------------------

export interface WorkflowRow {
  id: string;
  tenant_id: string;
  node_id: string | null;
  instance_id: string | null;
  profile_id: string;
  profile_version: number;
  state: WorkflowState;
  outcome: 'failed' | 'cancelled' | null;
  step_id: string | null;
  error: Json | null;
  work_key: string;
  owner: string | null;
  /** (v1.0 §13) The batch its commands carry. */
  batch_id: string | null;
  version: number;
}

export interface StepRow {
  workflow_id: string;
  id: string;
  index: number;
  phase: StepPhase;
  parent_id: string | null;
  action: string;
  driver: string | null;
  runs_on: PlannedStep['runsOn'];
  command_kind: string | null;
  args: Record<string, Json>;
  state: StepState;
  attempt: number;
  retries: number;
  timeout_ms: number;
  await: 'rejoin' | null;
  on_failure: PlannedStep['onFailure'] | null;
  when_expr: string | null;
  idempotency_key: string;
  node_id: string | null;
  command_id: string | null;
  sent_boot_id: string | null;
  sent_role: string | null;
  started_at: Date | null;
  deadline: Date | null;
  finished_at: Date | null;
  result: Json | null;
  error: Json | null;
}

const activeStates: readonly WorkflowState[] = ['pending', 'running', 'paused'];
const startedStepStates: readonly StepState[] = ['running', 'waiting', 'succeeded', 'failed'];

function assertWorkflowVerb(from: WorkflowState, verb: WorkflowVerb): WorkflowState {
  const to = targets(workflowStateTable, from, verb)[0];
  if (!to) throw new ComputeError('INVALID_STATE', `A ${from} workflow cannot ${verb}`, undefined, { state: from, verb });
  return to;
}
function assertStepVerb(from: StepState, verb: StepVerb): StepState {
  const to = targets(stepStateTable, from, verb)[0];
  if (!to) throw new ComputeError('INVALID_STATE', `A ${from} step cannot ${verb}`);
  return to;
}

/** The command idempotency key of a step attempt: `wf:<id>:<step>`, then `#<n>` for retries. */
export function commandKey(step: Pick<StepRow, 'idempotency_key' | 'attempt'>): string {
  return step.attempt === 0 ? step.idempotency_key : `${step.idempotency_key}#${step.attempt}`;
}

/** A locked workflow row, with the transaction's clock and its node's reference read in the same statement. */
interface LockedWorkflow extends WorkflowRow {
  /** `compute_now()` at the lock (epoch ms). */
  lockedAt: number;
  node?: NodeRef;
}

async function lockWorkflow(tx: SqlTx, id: string): Promise<LockedWorkflow | undefined> {
  const { rows } = await tx.query<WorkflowRow & { locked_at: Date; node_site_id: string | null; node_pool_id: string | null }>(
    `SELECT w.*, compute_now() AS locked_at, n.site_id AS node_site_id, n.pool_id AS node_pool_id
       FROM workflows w LEFT JOIN nodes n ON n.id = w.node_id WHERE w.id = $1 FOR UPDATE OF w`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  const { locked_at, node_site_id, node_pool_id, ...workflow } = row;
  return {
    ...workflow,
    profile_version: Number(row.profile_version),
    version: Number(row.version),
    lockedAt: locked_at.getTime(),
    ...(row.node_id && node_site_id ? { node: { id: row.node_id, siteId: node_site_id, ...(node_pool_id ? { poolId: node_pool_id } : {}) } } : {}),
  };
}

async function loadSteps(tx: SqlTx, workflowId: string): Promise<StepRow[]> {
  const { rows } = await tx.query<StepRow>(
    'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY index',
    [workflowId],
  );
  return rows.map((row) => ({ ...row, timeout_ms: Number(row.timeout_ms) }));
}

async function setWorkflow(
  tx: SqlTx,
  workflow: WorkflowRow,
  changes: { state?: WorkflowState; outcome?: WorkflowRow['outcome']; stepId?: string | null; error?: Json | null },
): Promise<void> {
  const state = changes.state ?? workflow.state;
  const outcome = changes.outcome === undefined ? workflow.outcome : changes.outcome;
  const stepId = changes.stepId === undefined ? workflow.step_id : changes.stepId;
  const error = changes.error === undefined ? workflow.error : changes.error;
  await tx.query(
    `UPDATE workflows SET state = $2, outcome = $3, step_id = $4, error = $5::jsonb, updated_at = compute_now(),
       finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN compute_now() ELSE NULL END,
       version = version + 1
     WHERE id = $1`,
    [workflow.id, state, outcome, stepId, error === null ? null : JSON.stringify(error)],
  );
  Object.assign(workflow, { state, outcome, step_id: stepId, error, version: workflow.version + 1 });
}

async function setStep(
  tx: SqlTx,
  step: StepRow,
  state: StepState,
  extra: Partial<Pick<StepRow, 'attempt' | 'command_id' | 'sent_boot_id' | 'sent_role' | 'result' | 'error'>> & {
    start?: boolean;
    finish?: boolean;
  } = {},
): Promise<void> {
  const attempt = extra.attempt ?? step.attempt;
  await tx.query(
    `UPDATE workflow_steps SET state = $3, attempt = $4,
       command_id = CASE WHEN $5::boolean THEN $6 ELSE command_id END,
       sent_boot_id = CASE WHEN $5::boolean THEN $7 ELSE sent_boot_id END,
       sent_role = CASE WHEN $5::boolean THEN $8 ELSE sent_role END,
       started_at = CASE WHEN $9::boolean THEN compute_now() ELSE started_at END,
       deadline = CASE WHEN $9::boolean THEN compute_now() + make_interval(secs => timeout_ms / 1000.0) ELSE deadline END,
       finished_at = CASE WHEN $10::boolean THEN compute_now() WHEN $3 = 'pending' THEN NULL ELSE finished_at END,
       result = CASE WHEN $11::boolean THEN $12::jsonb ELSE result END,
       error = CASE WHEN $13::boolean THEN $14::jsonb ELSE error END
     WHERE workflow_id = $1 AND id = $2`,
    [
      step.workflow_id,
      step.id,
      state,
      attempt,
      extra.command_id !== undefined,
      extra.command_id ?? null,
      extra.sent_boot_id ?? null,
      extra.sent_role ?? null,
      extra.start ?? false,
      extra.finish ?? false,
      extra.result !== undefined,
      extra.result === undefined || extra.result === null ? null : JSON.stringify(extra.result),
      extra.error !== undefined,
      extra.error === undefined || extra.error === null ? null : JSON.stringify(extra.error),
    ],
  );
  Object.assign(step, { state, attempt });
  if (extra.command_id !== undefined) step.command_id = extra.command_id;
}

async function publish(
  context: EngineContext,
  tx: SqlTx,
  workflow: WorkflowRow,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await context.events.publish(tx, {
    type,
    tenantId: workflow.tenant_id,
    subject: `workflow/${workflow.id}`,
    data: {
      workflowId: workflow.id,
      ...(workflow.node_id ? { nodeId: workflow.node_id } : {}),
      profileId: workflow.profile_id,
      profileVersion: workflow.profile_version,
      ...data,
    },
  });
}

// --- Start -----------------------------------------------------------------------------------------

export interface StartWorkflowInput {
  tenantId: string;
  profileId: string;
  profileVersion: number;
  nodeId?: string;
  instanceId?: string;
  /**
   * The module that owns the workflow: when it finishes, work of kind `owner` is queued under the
   * workflow's key (the node id), so the owner's reconciler reacts without polling.
   */
  owner?: string;
  /** (v1.0 §13) The destructive-command batch every command of the workflow carries. */
  batchId?: string;
}

/**
 * Starts a workflow in the caller's transaction: expands the pinned profile version, persists the
 * workflow and its steps, marks the profile version used (immutable from now on) and queues the
 * reconciler. `CONFLICT` when the node or instance already has an active workflow; `NOT_FOUND`
 * for an unknown profile or node; `INVALID_INPUT` when a step does not resolve.
 */
export async function startWorkflow(
  context: EngineContext,
  options: EngineOptions,
  tx: SqlTx,
  input: StartWorkflowInput,
): Promise<{ id: string }> {
  if (!input.nodeId && !input.instanceId)
    throw new ComputeError('INVALID_INPUT', 'A workflow needs a nodeId or an instanceId');
  const profile = await options.profiles.get(tx, input.tenantId, input.profileId, input.profileVersion);
  if (!profile)
    throw new ComputeError('NOT_FOUND', `Profile ${input.profileId}@${input.profileVersion} does not exist`);
  if (input.nodeId) {
    const node = await tx.query('SELECT 1 FROM nodes WHERE id = $1', [input.nodeId]);
    if (node.rowCount === 0) throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} does not exist`);
  }
  const steps = await expandProfileOrThrow(profile, options.steps);

  const id = newId('wf');
  const workKey = input.nodeId ?? id;
  const inserted = await tx.query(
    `INSERT INTO workflows (id, tenant_id, node_id, instance_id, profile_id, profile_version, state, work_key, owner,
       profile_document, batch_id, command_kinds)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb, $10, $11::text[]) ON CONFLICT DO NOTHING`,
    [
      id,
      input.tenantId,
      input.nodeId ?? null,
      input.instanceId ?? null,
      input.profileId,
      input.profileVersion,
      workKey,
      input.owner ?? null,
      JSON.stringify(profile),
      input.batchId ?? null,
      plannedCommandKinds(steps, options.steps),
    ],
  );
  if (inserted.rowCount === 0)
    throw new ComputeError(
      'CONFLICT',
      `${input.nodeId ? `Node ${input.nodeId}` : `Instance ${input.instanceId}`} already has an active workflow`,
    );
  for (const step of steps)
    await tx.query(
      `INSERT INTO workflow_steps (workflow_id, id, index, phase, parent_id, action, driver, runs_on, command_kind,
         args, state, retries, timeout_ms, await, on_failure, when_expr, idempotency_key, node_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, $12, $13, $14::jsonb, $15, $16, $17)`,
      [
        id,
        step.id,
        step.index,
        step.phase,
        step.parentId ?? null,
        step.action,
        step.driver ?? null,
        step.runsOn,
        step.commandKind ?? null,
        JSON.stringify(step.args),
        step.retries,
        step.timeoutMs,
        step.await ?? null,
        JSON.stringify(step.onFailure),
        step.when ?? null,
        `wf:${id}:${step.id}`,
        input.nodeId ?? null,
      ],
    );
  await tx.query(
    `UPDATE profiles SET used_at = COALESCE(used_at, compute_now())
      WHERE id = $1 AND profile_version = $2 AND (tenant_id = $3 OR visibility = 'public')`,
    [input.profileId, input.profileVersion, input.tenantId],
  );
  await context.work.enqueue(tx, workflowWorkKind, workKey);
  const workflow = (await lockWorkflow(tx, id))!;
  await publish(context, tx, workflow, 'workflow.created', { steps: steps.length });
  return { id };
}

// --- Operator verbs ----------------------------------------------------------------------------------

async function requireWorkflow(tx: SqlTx, id: string, tenantId?: string): Promise<WorkflowRow> {
  const workflow = await lockWorkflow(tx, id);
  if (!workflow || (tenantId !== undefined && workflow.tenant_id !== tenantId))
    throw new ComputeError('NOT_FOUND', `Workflow ${id} does not exist`);
  return workflow;
}

/**
 * Aborts a workflow: pending steps are cancelled, the in-flight step's command is cancelled, and
 * the cleanup phase still runs before the workflow ends `cancelled`. Aborting a finished workflow
 * is `INVALID_STATE`; aborting twice is a no-op.
 */
export async function abortWorkflow(
  context: EngineContext,
  tx: SqlTx,
  workflowId: string,
  options: { tenantId?: string; reason?: string } = {},
): Promise<void> {
  const workflow = await requireWorkflow(tx, workflowId, options.tenantId);
  if (workflow.outcome === 'cancelled' || workflow.state === 'cancelled') return;
  if (workflow.state === 'pending' || workflow.state === 'failed') {
    // Nothing is in flight: no cleanup can be owed for a workflow that never started, and a failed
    // one already ran its cleanup.
    await tx.query(
      `UPDATE workflow_steps SET state = 'cancelled', finished_at = compute_now()
        WHERE workflow_id = $1 AND state = 'pending'`,
      [workflow.id],
    );
    await setWorkflow(tx, workflow, {
      state: assertWorkflowVerb(workflow.state, 'cancel'),
      outcome: null,
      stepId: null,
      error: { code: 'CANCELLED', message: options.reason ?? 'aborted' },
    });
    await releaseImagePins(tx, context.desired, workflow.id);
    await publish(context, tx, workflow, 'workflow.cancelled');
    await notifyOwner(context, tx, workflow);
    return;
  }
  if (workflow.state === 'paused') await setWorkflow(tx, workflow, { state: assertWorkflowVerb('paused', 'resume') });
  assertWorkflowVerb(workflow.state, 'cancel');
  const steps = await loadSteps(tx, workflow.id);
  for (const step of steps) {
    if (step.phase === 'cleanup') continue;
    if (step.state === 'pending') await setStep(tx, step, 'cancelled', { finish: true });
    else if (step.state === 'running' || step.state === 'waiting') {
      if (step.command_id) await context.commands.cancel(tx, step.command_id);
      await setStep(tx, step, 'cancelled', { finish: true, error: { code: 'CANCELLED', message: 'aborted' } });
    }
  }
  await setWorkflow(tx, workflow, {
    outcome: 'cancelled',
    stepId: null,
    error: { code: 'CANCELLED', message: options.reason ?? 'aborted' },
  });
  await context.work.enqueue(tx, workflowWorkKind, workflow.work_key);
}

/** Pauses a running workflow: the step in flight finishes, but no further step starts. */
export async function pauseWorkflow(context: EngineContext, tx: SqlTx, workflowId: string, tenantId?: string): Promise<void> {
  const workflow = await requireWorkflow(tx, workflowId, tenantId);
  if (workflow.outcome) throw new ComputeError('INVALID_STATE', 'A workflow that is cleaning up cannot pause');
  await setWorkflow(tx, workflow, { state: assertWorkflowVerb(workflow.state, 'pause') });
  await publish(context, tx, workflow, 'workflow.paused');
}

/** Resumes a paused workflow. */
export async function resumeWorkflow(context: EngineContext, tx: SqlTx, workflowId: string, tenantId?: string): Promise<void> {
  const workflow = await requireWorkflow(tx, workflowId, tenantId);
  await setWorkflow(tx, workflow, { state: assertWorkflowVerb(workflow.state, 'resume') });
  await context.work.enqueue(tx, workflowWorkKind, workflow.work_key);
  await publish(context, tx, workflow, 'workflow.resumed');
}

/**
 * Retries a failed workflow from a step (default: the first main step that did not succeed). That
 * step and every later main step go back to `pending` with the next attempt number, on-failure and
 * cleanup steps are re-armed, and the workflow runs again. `CONFLICT` if the node has another
 * active workflow by now.
 */
export async function retryWorkflow(
  context: EngineContext,
  tx: SqlTx,
  workflowId: string,
  options: { tenantId?: string; fromStep?: string } = {},
): Promise<void> {
  const workflow = await requireWorkflow(tx, workflowId, options.tenantId);
  const next = assertWorkflowVerb(workflow.state, 'retry');
  const steps = await loadSteps(tx, workflow.id);
  const main = steps.filter((step) => step.phase === 'main');
  const from = options.fromStep
    ? main.find((step) => step.id === options.fromStep)
    : main.find((step) => step.state !== 'succeeded' && step.state !== 'skipped');
  if (!from)
    throw new ComputeError(
      'INVALID_INPUT',
      options.fromStep ? `Step ${options.fromStep} is not a main step of workflow ${workflow.id}` : 'Every main step succeeded; nothing to retry',
    );
  const active = await tx.query(
    `SELECT 1 FROM workflows WHERE node_id = $1 AND id <> $2 AND state IN ('pending', 'running', 'paused')`,
    [workflow.node_id, workflow.id],
  );
  if (workflow.node_id && active.rowCount) throw new ComputeError('CONFLICT', `Node ${workflow.node_id} has another active workflow`);
  for (const step of steps) {
    const reset = step.phase === 'main' ? step.index >= from.index : true;
    if (!reset || step.state === 'pending') continue;
    await tx.query(
      `UPDATE workflow_steps SET state = 'pending', attempt = attempt + 1, command_id = NULL, sent_boot_id = NULL,
         sent_role = NULL, started_at = NULL, deadline = NULL, finished_at = NULL, result = NULL, error = NULL
       WHERE workflow_id = $1 AND id = $2`,
      [workflow.id, step.id],
    );
  }
  await setWorkflow(tx, workflow, { state: next, outcome: null, stepId: null, error: null });
  await context.work.enqueue(tx, workflowWorkKind, workflow.work_key);
  await publish(context, tx, workflow, 'workflow.retried', { fromStep: from.id });
}

// --- Advancing -------------------------------------------------------------------------------------

type Transition =
  /** Something changed; look again right away. */
  | { kind: 'continue' }
  /** Nothing to do until `wakeAt` (epoch ms) or a wake-up. */
  | { kind: 'wait'; wakeAt?: number }
  /** A control-plane step to run outside the transaction. */
  | { kind: 'run'; step: StepRow; workflow: LockedWorkflow; deadline: number }
  | { kind: 'done' };

/**
 * The next step to start, or undefined when the workflow has no runnable step left. Steps are
 * ordered main < on-failure < cleanup and only one runs at a time, so a cleanup step is reached
 * only once every runnable main and on-failure step before it has settled.
 */
function nextStep(workflow: WorkflowRow, steps: StepRow[]): StepRow | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.state !== 'pending') continue;
    if (step.phase === 'main') {
      if (workflow.outcome) continue;
      return step;
    }
    if (step.phase === 'on-failure') {
      // Runs only when its parent failed for good; the workflow is then failing.
      if (byId.get(step.parent_id!)?.state === 'failed' && workflow.outcome === 'failed') return step;
      continue;
    }
    return step;
  }
  return undefined;
}

async function nodeLabels(tx: SqlTx, nodeId: string | null): Promise<Record<string, string>> {
  if (!nodeId) return {};
  const { rows } = await tx.query<{ key: string; value: string }>('SELECT key, value FROM node_labels WHERE node_id = $1', [nodeId]);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/**
 * A step failed (after its own attempt). Retries while attempts remain; otherwise applies
 * `onFailure`: `continue` moves on, `fail`/`rescue` make the workflow fail (after cleanup), and an
 * on-failure step runs first, then the workflow fails.
 */
async function failStep(
  context: EngineContext,
  tx: SqlTx,
  workflow: WorkflowRow,
  step: StepRow,
  error: { code: string; message: string },
): Promise<void> {
  await setStep(tx, step, assertStepVerb(step.state, 'fail'), { finish: true, error });
  if (step.attempt < step.retries) {
    await setStep(tx, step, assertStepVerb('failed', 'retry'), { attempt: step.attempt + 1, error });
    await publish(context, tx, workflow, 'workflow.step.retrying', { stepId: step.id, attempt: step.attempt, error });
    return;
  }
  await publish(context, tx, workflow, 'workflow.step.failed', { stepId: step.id, action: step.action, error });
  const mode = step.on_failure ?? 'fail';
  if (step.phase !== 'main' || mode === 'continue') return;
  await setWorkflow(tx, workflow, {
    outcome: 'failed',
    error: { code: error.code, message: `${step.id} (${step.action}): ${error.message}`, ...(mode === 'rescue' ? { rescue: true } : {}) },
  });
  // The rest of the main phase will not run.
  await tx.query(
    `UPDATE workflow_steps SET state = 'cancelled', finished_at = compute_now()
      WHERE workflow_id = $1 AND phase = 'main' AND state = 'pending'`,
    [workflow.id],
  );
}

async function completeStep(context: EngineContext, tx: SqlTx, workflow: WorkflowRow, step: StepRow, result: Json | null): Promise<void> {
  await setStep(tx, step, assertStepVerb(step.state, 'complete'), { finish: true, result });
  await publish(context, tx, workflow, 'workflow.step.succeeded', { stepId: step.id, action: step.action });
}

async function finish(context: EngineContext, tx: SqlTx, workflow: WorkflowRow): Promise<void> {
  await tx.query(
    `UPDATE workflow_steps SET state = 'skipped', finished_at = compute_now() WHERE workflow_id = $1 AND state = 'pending'`,
    [workflow.id],
  );
  const verb = workflow.outcome === 'failed' ? 'fail' : workflow.outcome === 'cancelled' ? 'cancel' : 'complete';
  const state = assertWorkflowVerb(workflow.state, verb);
  await setWorkflow(tx, workflow, { state, outcome: null, stepId: null });
  // Images the workflow pinned at a site (a deploy's) may be evicted again.
  await releaseImagePins(tx, context.desired, workflow.id);
  await publish(context, tx, workflow, `workflow.${state}`, workflow.error ? { error: workflow.error } : {});
  // A profile's hostConfig becomes the node's desired state once the workflow succeeded (§11.2).
  if (state === 'succeeded' && workflow.node_id && context.desired) {
    const { rows } = await tx.query<{ has: boolean }>(`SELECT profile_document ? 'hostConfig' AS has FROM workflows WHERE id = $1`, [workflow.id]);
    if (rows[0]?.has) await context.desired.invalidate(tx, workflow.node_id);
  }
  await notifyOwner(context, tx, workflow);
}

/** Queues the owning module's reconciler under the workflow's key. */
async function notifyOwner(context: EngineContext, tx: SqlTx, workflow: WorkflowRow): Promise<void> {
  if (workflow.owner) await context.work.enqueue(tx, workflow.owner, workflow.work_key);
}

async function startAgentStep(
  context: EngineContext,
  tx: SqlTx,
  workflow: WorkflowRow,
  step: StepRow,
): Promise<Transition> {
  if (step.state === 'pending') {
    await setStep(tx, step, assertStepVerb(step.state, 'start'), { start: true });
    await setWorkflow(tx, workflow, { stepId: step.id });
  }
  if (!workflow.node_id) {
    await failStep(context, tx, workflow, step, { code: 'INVALID_STATE', message: `step runs on ${step.runs_on} but the workflow has no node` });
    return { kind: 'continue' };
  }
  const { rows } = await tx.query<{ deadline: Date; now: Date }>(
    'SELECT deadline, compute_now() AS now FROM workflow_steps WHERE workflow_id = $1 AND id = $2',
    [workflow.id, step.id],
  );
  const deadline = rows[0]!.deadline.getTime();
  const now = rows[0]!.now.getTime();
  // Site steps go to the site's agent (the boot-lease holder first); the rest to the node itself.
  const target = step.runs_on === 'site' ? await siteAgentFor(tx, workflow.node_id) : workflow.node_id;
  if (!target) {
    if (now >= deadline) {
      await failStep(context, tx, workflow, step, { code: 'NO_SITE_AGENT', message: "no connected site agent serves the node's site" });
      return { kind: 'continue' };
    }
    return { kind: 'wait', wakeAt: Math.min(deadline, now + 5_000) };
  }
  const session = await tx.query<{ boot_id: string | null; role: string | null }>(
    'SELECT boot_id, role FROM node_sessions WHERE node_id = $1',
    [workflow.node_id],
  );
  const command = await context.commands.enqueue(tx, {
    nodeId: target,
    kind: step.command_kind ?? step.action,
    // A registered command kind takes its payload message in proto3 JSON: the step's args. Driver
    // operations (`driver.invoke`) carry the workflow envelope the driver host unpacks.
    payload: (step.command_kind === driverInvokeKind || !step.command_kind
      ? {
          workflowId: workflow.id,
          stepId: step.id,
          attempt: step.attempt,
          ...(target !== workflow.node_id ? { targetNodeId: workflow.node_id } : {}),
          args: step.args,
        }
      : step.args) as Json,
    idempotencyKey: commandKey(step),
    notAfter: deadline,
    ...batchOf({ batchId: workflow.batch_id ?? undefined, registry: context.registry }, step.command_kind ?? step.action),
  });
  await setStep(tx, step, assertStepVerb('running', 'wait'), {
    command_id: command.id,
    sent_boot_id: session.rows[0]?.boot_id ?? null,
    sent_role: session.rows[0]?.role ?? null,
  });
  await publish(context, tx, workflow, 'workflow.step.started', { stepId: step.id, action: step.action, commandId: command.id });
  return { kind: 'wait', wakeAt: Math.min(deadline, now + workflowPollMs) };
}

/**
 * The site agent that runs `site` steps for a node: a connected agent with role `site` in the
 * node's site, the holder of the `site:<id>:boot` lease first (§8.5). Undefined when none is up.
 */
export async function siteAgentFor(tx: SqlTx, nodeId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT agent.id FROM nodes target
       JOIN nodes agent ON agent.site_id = target.site_id AND agent.role = 'site'
       JOIN node_sessions s ON s.node_id = agent.id
       LEFT JOIN leases l ON l.name = 'site:' || target.site_id || ':boot' AND l.owner = agent.id
         AND l.expires_at > compute_now()
      WHERE target.id = $1 AND s.connected_at IS NOT NULL
        AND (s.disconnected_at IS NULL OR s.connected_at > s.disconnected_at)
      ORDER BY (l.name IS NOT NULL) DESC, agent.id LIMIT 1`,
    [nodeId],
  );
  return rows[0]?.id;
}

async function settleWaiting(
  context: EngineContext,
  tx: SqlTx,
  workflow: WorkflowRow,
  step: StepRow,
  now: number,
): Promise<Transition> {
  const deadline = step.deadline?.getTime() ?? now;
  const overdue = now >= deadline;
  if (step.await === 'rejoin') {
    // Completes when the agent is back with a new boot or role, whatever the command said: a
    // self-terminating command never reports success from the old boot. Only a timeout fails it.
    const session = await tx.query<{ boot_id: string | null; role: string | null; connected: boolean }>(
      `SELECT boot_id, role, (connected_at IS NOT NULL AND (disconnected_at IS NULL OR connected_at > disconnected_at)) AS connected
         FROM node_sessions WHERE node_id = $1`,
      [workflow.node_id],
    );
    const current = session.rows[0];
    if (current?.connected && (current.boot_id !== step.sent_boot_id || current.role !== step.sent_role)) {
      await completeStep(context, tx, workflow, step, { bootId: current.boot_id, role: current.role });
      return { kind: 'continue' };
    }
    if (overdue) {
      await failStep(context, tx, workflow, step, { code: 'REJOIN_TIMEOUT', message: 'the agent did not rejoin before the step timed out' });
      return { kind: 'continue' };
    }
    return { kind: 'wait', wakeAt: Math.min(deadline, now + workflowPollMs) };
  }
  const command = step.command_id
    ? (
        await tx.query<{ state: string; reason: string | null; result: Uint8Array | null }>(
          'SELECT state, reason, result FROM commands WHERE id = $1',
          [step.command_id],
        )
      ).rows[0]
    : undefined;
  if (!command) {
    await failStep(context, tx, workflow, step, { code: 'INTERNAL_ERROR', message: 'the step lost its command' });
    return { kind: 'continue' };
  }
  if (command.state === 'succeeded') {
    const result = command.result ? { resultBase64: Buffer.from(command.result).toString('base64') } : null;
    await completeStep(context, tx, workflow, step, result);
    return { kind: 'continue' };
  }
  if (['failed', 'rejected', 'expired', 'cancelled'].includes(command.state)) {
    await failStep(context, tx, workflow, step, {
      code: `COMMAND_${command.state.toUpperCase()}`,
      message: command.reason ?? `the command ${command.state}`,
    });
    return { kind: 'continue' };
  }
  if (overdue) {
    await context.commands.cancel(tx, step.command_id!);
    await failStep(context, tx, workflow, step, { code: 'TIMEOUT', message: `no result within ${step.timeout_ms} ms` });
    return { kind: 'continue' };
  }
  return { kind: 'wait', wakeAt: Math.min(deadline, now + workflowPollMs) };
}

/** One transition of one workflow, in `tx`. */
async function transition(context: EngineContext, tx: SqlTx, workflowId: string): Promise<Transition> {
  const workflow = await lockWorkflow(tx, workflowId);
  if (!workflow || !activeStates.includes(workflow.state)) return { kind: 'done' };
  if (workflow.state === 'pending') {
    await setWorkflow(tx, workflow, { state: assertWorkflowVerb('pending', 'start') });
    await publish(context, tx, workflow, 'workflow.started');
    return { kind: 'continue' };
  }
  const now = workflow.lockedAt;
  const steps = await loadSteps(tx, workflow.id);
  const inFlight = steps.find((step) => step.state === 'running' || step.state === 'waiting');
  if (inFlight) {
    if (inFlight.state === 'waiting') return settleWaiting(context, tx, workflow, inFlight, now);
    if (inFlight.runs_on === 'control-plane') {
      const deadline = inFlight.deadline?.getTime() ?? now;
      if (now >= deadline) {
        await failStep(context, tx, workflow, inFlight, { code: 'TIMEOUT', message: `no result within ${inFlight.timeout_ms} ms` });
        return { kind: 'continue' };
      }
      return { kind: 'run', step: inFlight, workflow, deadline };
    }
    // An agent step that started but has no command yet: it is waiting for a site agent to come
    // up (or its deadline).
    return startAgentStep(context, tx, workflow, inFlight);
  }
  if (workflow.state === 'paused') return { kind: 'done' };
  const next = nextStep(workflow, steps);
  if (!next) {
    await finish(context, tx, workflow);
    return { kind: 'done' };
  }
  if (next.when_expr && !evaluateWhen(next.when_expr, await nodeLabels(tx, workflow.node_id))) {
    await setStep(tx, next, assertStepVerb('pending', 'skip'), { finish: true });
    await publish(context, tx, workflow, 'workflow.step.skipped', { stepId: next.id, when: next.when_expr });
    return { kind: 'continue' };
  }
  if (next.parent_id && next.phase === 'cleanup') {
    const parent = steps.find((step) => step.id === next.parent_id);
    if (!parent || !startedStepStates.includes(parent.state)) {
      await setStep(tx, next, assertStepVerb('pending', 'skip'), { finish: true });
      return { kind: 'continue' };
    }
  }
  if (next.runs_on !== 'control-plane') return startAgentStep(context, tx, workflow, next);
  await setStep(tx, next, assertStepVerb('pending', 'start'), { start: true });
  await setWorkflow(tx, workflow, { stepId: next.id });
  await publish(context, tx, workflow, 'workflow.step.started', { stepId: next.id, action: next.action });
  const { rows } = await tx.query<{ deadline: Date }>(
    'SELECT deadline FROM workflow_steps WHERE workflow_id = $1 AND id = $2',
    [workflow.id, next.id],
  );
  return { kind: 'run', step: { ...next, deadline: rows[0]!.deadline }, workflow, deadline: rows[0]!.deadline.getTime() };
}

export interface AdvanceOptions extends EngineOptions {
  /** The module context control-plane steps receive (with the reconciler's signal). */
  stepContext?: Omit<StepContext, 'workflowId' | 'stepId' | 'attempt' | 'idempotencyKey' | 'node' | 'signal' | 'emit'>;
  signal?: AbortSignal;
  /** Upper bound on transitions per call, so one key cannot monopolize a worker. */
  maxTransitions?: number;
}

/** What `advanceWorkflow` left behind. */
export interface AdvanceResult {
  transitions: number;
  /** When the workflow wants to be looked at again (epoch ms), if it is waiting. */
  wakeAt?: number;
  /** The workflow is no longer active (or does not exist). */
  done: boolean;
}

async function runControlPlaneStep(
  context: EngineContext & Pick<ModuleContext, 'sql'>,
  options: AdvanceOptions,
  workflow: LockedWorkflow,
  step: StepRow,
  deadline: number,
  now: () => number,
): Promise<{ outcome: 'succeeded'; result: Json | null } | { outcome: 'failed'; error: { code: string; message: string } } | { outcome: 'not-ready'; retryAfterMs: number }> {
  const definition = options.steps.get(step.action);
  if (!definition?.run) return { outcome: 'failed', error: { code: 'INVALID_CONFIG', message: `step ${step.action} is not registered in this worker` } };
  const parsed = await definition.input['~standard'].validate(step.args);
  if ('issues' in parsed && parsed.issues)
    return { outcome: 'failed', error: { code: 'INVALID_INPUT', message: parsed.issues.map((issue) => issue.message).join('; ') } };
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ComputeError('INTERNAL_ERROR', 'step timed out')), Math.max(0, deadline - now()));
  // Read with the workflow's lock; a node row deleted meanwhile has none.
  const node: NodeRef | undefined = workflow.node;
  // A step that declares what it relays (`sends`) may enqueue only those kinds: a batch's scope,
  // computed from the declarations, then covers everything the workflow can send.
  const sends = definition.sends;
  const commands =
    sends && context.commands
      ? {
          ...context.commands,
          enqueue: (tx: SqlTx, command: Parameters<typeof context.commands.enqueue>[1]) => {
            if (!sends.includes(command.kind))
              throw new ComputeError('INVALID_CONFIG', `Step ${step.action} sends ${command.kind}, which it does not declare in sends`);
            return context.commands.enqueue(tx, command);
          },
        }
      : context.commands;
  const stepContext = {
    ...(options.stepContext ?? {}),
    ...context,
    commands,
    workflowId: workflow.id,
    ...(workflow.batch_id ? { batchId: workflow.batch_id } : {}),
    stepId: step.id,
    attempt: step.attempt,
    idempotencyKey: step.idempotency_key,
    ...(node ? { node } : {}),
    signal: controller.signal,
    emit: () => {},
  } as unknown as StepContext;
  try {
    const result = await Promise.race([
      definition.run((parsed as { value: unknown }).value, stepContext),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
      ),
    ]);
    return { outcome: 'succeeded', result: (result ?? null) as Json | null };
  } catch (error) {
    if (error instanceof StepNotReady) return { outcome: 'not-ready', retryAfterMs: error.retryAfterMs };
    if (controller.signal.aborted && !options.signal?.aborted)
      return { outcome: 'failed', error: { code: 'TIMEOUT', message: `no result within ${step.timeout_ms} ms` } };
    if (options.signal?.aborted) throw error;
    const code = error instanceof ComputeError ? error.code : 'STEP_ERROR';
    return { outcome: 'failed', error: { code, message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Advances one workflow as far as it can go now: transitions until it waits, finishes or reaches
 * `maxTransitions`. Control-plane steps run between transactions. Returns when to look again.
 */
export async function advanceWorkflow(
  context: EngineContext & Pick<ModuleContext, 'sql'>,
  options: AdvanceOptions,
  workflowId: string,
): Promise<AdvanceResult> {
  const max = options.maxTransitions ?? 64;
  let transitions = 0;
  const clock = () => (context.clock ? context.clock.now() : Date.now());
  while (transitions < max) {
    if (options.signal?.aborted) return { transitions, done: false };
    const step = await context.sql.transaction((tx) => transition(context, tx, workflowId));
    transitions++;
    if (step.kind === 'continue') continue;
    if (step.kind === 'done') return { transitions, done: true };
    if (step.kind === 'wait') return step.wakeAt === undefined ? { transitions, done: false } : { transitions, done: false, wakeAt: step.wakeAt };
    const outcome = await runControlPlaneStep(context, options, step.workflow, step.step, step.deadline, clock);
    const wake = await context.sql.transaction(async (tx) => {
      const workflow = await lockWorkflow(tx, workflowId);
      if (!workflow) return undefined;
      const { rows } = await tx.query<StepRow>(
        'SELECT * FROM workflow_steps WHERE workflow_id = $1 AND id = $2 FOR UPDATE',
        [workflowId, step.step.id],
      );
      const current = rows[0];
      // Aborted, retried or settled by someone else meanwhile: this run's outcome is stale.
      if (!current || current.state !== 'running' || current.attempt !== step.step.attempt) return undefined;
      if (outcome.outcome === 'succeeded') await completeStep(context, tx, workflow, current, outcome.result);
      else if (outcome.outcome === 'failed') await failStep(context, tx, workflow, current, outcome.error);
      else return Math.min(step.deadline, workflow.lockedAt + outcome.retryAfterMs);
      return undefined;
    });
    transitions++;
    if (wake !== undefined) return { transitions, done: false, wakeAt: wake };
  }
  return { transitions, done: false, wakeAt: clock() };
}

/**
 * The Workflow reconciler body for one key (a node id, or a workflow id for workflows without a
 * node): advances every active workflow under the key, and queues the next wake-up.
 */
export async function reconcileWorkflows(
  context: EngineContext & Pick<ModuleContext, 'sql'>,
  options: AdvanceOptions,
  key: string,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT id FROM workflows WHERE work_key = $1 AND state IN ('pending', 'running', 'paused') ORDER BY created_at`,
    [key],
  );
  let wakeAt: number | undefined;
  for (const { id } of rows) {
    const result = await advanceWorkflow(context, options, id);
    if (result.wakeAt !== undefined) wakeAt = wakeAt === undefined ? result.wakeAt : Math.min(wakeAt, result.wakeAt);
  }
  if (wakeAt !== undefined) {
    const at = wakeAt;
    await context.sql.transaction((tx) => context.work.enqueue(tx, workflowWorkKind, key, { notBefore: at }));
  }
  return 'DONE';
}
