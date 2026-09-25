import type { ProfileDocument, RegistryView } from '@better-compute/core';
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
