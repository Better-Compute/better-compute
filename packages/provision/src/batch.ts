import { ComputeError, type CommandQueue, type ProfileDocument, type RegistryView, type SqlTx } from '@better-compute/core';
import { expandProfileOrThrow, type PlannedStep, type StepRegistry } from './expand.js';

// Batches of destructive work (PLAN.md §13, the v1.0 quorum): a batch is approved for a scope of
// (subject, kind) leaves before anything runs, so the command kinds a workflow can send must be
// known from its profile alone. They are the `command` of agent steps and the `sends` of
// control-plane steps, every phase included (main, on-failure, cleanup). A step that declares no
// `sends` contributes nothing: in a batch, whatever it sends falls outside the scope and is refused
// at enqueue.

/**
 * The batch a workflow's command carries: set for its destructive commands only, since the batch's
 * scope holds nothing else (the quorum gates destructive work; the rest runs as ever).
 */
export function batchOf(
  context: { batchId?: string | undefined; registry?: Pick<RegistryView, 'commandKind'> | undefined },
  kind: string,
): { batchId?: string } {
  return context.batchId && context.registry?.commandKind(kind)?.destructive ? { batchId: context.batchId } : {};
}

/**
 * Puts a just-started workflow on `nodeId` under a destructive-command batch of its own (§13), for
 * workflows whose destructive kinds all run on the node itself (node.reboot, gpu.reset): each leaf's
 * subject is the node. Kinds another agent relays (bmc.*, site.httpProxy) need their owner's scope
 * (metal builds its own) and are refused. Nothing without `createBatch` or anything destructive, or
 * when the workflow already has a batch. Returns the batch id, if one was made.
 */
export async function batchNodeWorkflow(
  context: { commands?: Pick<CommandQueue, 'createBatch'>; registry?: Pick<RegistryView, 'commandKind'> },
  tx: SqlTx,
  workflowId: string,
  input: { tenantId: string; nodeId: string; reason: string },
): Promise<string | undefined> {
  if (!context.commands?.createBatch || !context.registry) return undefined;
  const { rows } = await tx.query<{ command_kinds: string[]; batch_id: string | null }>(
    'SELECT command_kinds, batch_id FROM workflows WHERE id = $1',
    [workflowId],
  );
  const row = rows[0];
  if (!row || row.batch_id) return row?.batch_id ?? undefined;
  const kinds = row.command_kinds.filter((kind) => context.registry!.commandKind(kind)?.destructive === true);
  if (kinds.length === 0) return undefined;
  const relayed = kinds.filter((kind) => kind.startsWith('bmc.') || kind === 'site.httpProxy');
  if (relayed.length > 0)
    throw new ComputeError('INVALID_STATE', `Workflow ${workflowId} relays ${relayed.join(', ')}: its owner must scope its batch`);
  const batch = await context.commands.createBatch(tx, {
    tenantId: input.tenantId,
    scope: kinds.map((kind) => ({ subject: input.nodeId, kind })),
    reason: input.reason,
  });
  await tx.query('UPDATE workflows SET batch_id = $2 WHERE id = $1', [workflowId, batch.batchId]);
  return batch.batchId;
}

/** Every command kind a workflow of `profile` can send, sorted. */
export async function profileCommandKinds(profile: ProfileDocument, steps: StepRegistry): Promise<string[]> {
  return plannedCommandKinds(await expandProfileOrThrow(profile, steps), steps);
}

/** The same for an expanded profile (the engine records it as `workflows.command_kinds`). */
export function plannedCommandKinds(planned: readonly PlannedStep[], steps: StepRegistry): string[] {
  const kinds = new Set<string>();
  for (const step of planned) {
    if (step.commandKind) kinds.add(step.commandKind);
    else for (const kind of steps.get(step.action)?.sends ?? []) kinds.add(kind);
  }
  return [...kinds].sort();
}
