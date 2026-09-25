import type { ProfileDocument } from '@better-compute/core';
import { expandProfileOrThrow, type StepRegistry } from './expand.js';

// Batches of destructive work (PLAN.md §13, the v1.0 quorum): a batch is approved for a scope of
// (subject, kind) leaves before anything runs, so the command kinds a workflow can send must be
// known from its profile alone. They are the `command` of agent steps and the `sends` of
// control-plane steps, every phase included (main, on-failure, cleanup). A step that declares no
// `sends` contributes nothing: in a batch, whatever it sends falls outside the scope and is refused
// at enqueue.

/** Every command kind a workflow of `profile` can send, sorted. */
export async function profileCommandKinds(profile: ProfileDocument, steps: StepRegistry): Promise<string[]> {
  const kinds = new Set<string>();
  for (const step of await expandProfileOrThrow(profile, steps)) {
    if (step.commandKind) kinds.add(step.commandKind);
    else for (const kind of steps.get(step.action)?.sends ?? []) kinds.add(kind);
  }
  return [...kinds].sort();
}
