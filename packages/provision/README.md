# @better-compute/provision

Provisioning for better-compute: workflow steps, profiles, and the workflow engine that expands a
profile into persisted steps for one node or instance (PLAN.md §11.2). It depends on
`@better-compute/core`, `@better-compute/protocol` and `@better-compute/inventory`.

**Status: v0.2 workflow engine.**

- Implemented: `defineStep`, `defineProfile`, `provisionModule()` (the workflow engine, its
  tables, the Workflow reconciler), `ctx.workflows`, and the `profiles` and `workflows` API
  groups.
- Still to come: the `images` group, config units, renderers and the image catalog.

## The workflow engine (PLAN.md §11.2)

```ts
import { provisionModule } from 'better-compute/provision';

const provision = provisionModule({ steps: [dcgm, renderIso], profiles: [ubuntuGpuHost] });
// The host sets ModuleContext.workflows = provision.workflowEngine(context); modules then start
// workflows in their own transaction:
await context.workflows!.start(tx, { tenantId, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1, nodeId });
```

- **Expansion.** `start` pins the profile version, expands it (`expandProfile`) and persists the
  workflow with every step. Each `use:` resolves to a registered step or, when the profile says
  `on:`, to a driver operation `<concern>.<operation>` sent as a `driver.invoke` command.
  `fallback:` is used when `use:` does not resolve. Acceptance steps follow the main steps, and
  on-failure and cleanup steps are their own rows. A profile version is immutable once used.
- **Persistence.** The `provision/0001_workflows` migration creates `profiles`, `workflows` and
  `workflow_steps`. Partial unique indexes allow one active workflow and one in-flight step per
  node, so the worker that next owns the node's shard resumes a crashed workflow.
- **Execution.** The `workflow` reconciler (sharded by node) runs one transition per transaction,
  with the workflow row locked.
  - A `control-plane` step runs in the worker between two transactions, with idempotency key
    `wf:<id>:<stepId>`. A crash re-runs it. It may throw `stepNotReady(ms)` to be run again later.
  - Every other step is exactly one command. Its key is `wf:<id>:<stepId>`, then `#<attempt>` for
    retries.
  - An `await: 'rejoin'` step completes when the agent is back with a new `boot_id` or role. Its
    command's own fate is ignored, and only its timeout fails it.
- **Options.**
  - `timeout` cancels the command and fails the step.
  - `retries` re-runs the step with the next attempt.
  - `onFailure` takes one of: `fail` (the default: the rest of the main phase is cancelled,
    cleanup runs, and the workflow ends `failed`), `rescue` (the same, with `error.rescue`),
    `continue`, or a step that runs before the workflow fails.
  - `when:` is a small expression over the node's labels, e.g. `nvswitch && gpu.model=H100` or
    `!mig.capable`. A false one skips the step.
- **Verbs.**
  - `abortWorkflow` cancels the in-flight command and pending steps, runs cleanup, and ends
    `cancelled`.
  - `pauseWorkflow` lets the in-flight step finish but starts nothing new, and `resumeWorkflow`
    continues.
  - `retryWorkflow` re-arms a failed workflow from a step with the next attempt numbers.
- **Events.** It emits `workflow.created|started|succeeded|failed|cancelled|paused|resumed|retried`
  and `workflow.step.started|succeeded|failed|retrying|skipped`.
- **Built-in steps.** `wait.agentJoined` (optionally for a `role`) and `wait.generationObserved`.

API (§9.2, v0.2 rows):

- `profiles.create|get|validate|render|list|update|delete`. `validate` lists every unresolved
  `use:` and rejected `with:`, and `render` returns the expanded steps.
- `workflows.get|list|abort|retry`. These are decided on the node.

```ts
import { field, manifest } from 'better-compute/core';
import { defineProfile, defineStep } from 'better-compute/provision';

export const dcgm = defineStep({
  id: 'diag.dcgm',
  runsOn: 'ramdisk',
  timeout: '30m',
  retrySafe: true,
  input: manifest({ level: field.int({ min: 1, max: 4 }) }),
  command: 'diag.dcgm',
});

export const adopt = defineProfile({
  id: 'adopt-existing',
  version: 1,
  target: 'metal',
  entry: 'adopt',
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 }, fallback: 'diag.nvml' }],
  hostConfig: { 'container-toolkit': { cdi: true } },
});
```

## `defineStep`

`defineStep(step)` returns a frozen `StepDefinition` stamped with `extension: 'step'`.

- A `control-plane` step needs `run(input, context)` and sends no command.
- A step that runs on a `site`, `node` or `ramdisk` agent is exactly one `command`, for example
  `driver.invoke` for driver operations. It may also set `await: 'rejoin'`.
- `input` may be any Standard Schema.
- Step ids are dotted, for example `power.setPower`.

## `defineProfile`

`defineProfile(document)` returns a deeply frozen copy. It rejects:

- unknown fields;
- malformed steps, durations or ids;
- values that are not JSON;
- fields that belong to the other target;
- an image, user data or steps on an `adopt` profile.

The `profiles.validate` method (v0.2) checks that every `use:` resolves to a registered step.

## Errors and re-exports

Errors are `ComputeError('INVALID_CONFIG')`. `details.path` names the first field that failed, for
example `steps[2].timeout`.

The contracts are declared in `@better-compute/core` and re-exported here as types:
`StepDefinition`, `StepInput`, `StepContext`, `ProfileDocument`, `ProfileStep`, `Workflow`,
`WorkflowStep`, `WorkflowEngine`, `WorkflowState` and `StepState`.

License: Apache-2.0.
