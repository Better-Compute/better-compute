# @better-compute/provision

Provisioning for better-compute: workflow steps, profiles, and the workflow engine that expands a
profile into persisted steps for one node or instance (PLAN.md §11.2). It depends on
`@better-compute/core`, `@better-compute/protocol` and `@better-compute/inventory`.

**Status: P0 stub.**

- `defineStep` and `defineProfile` are implemented.
- `provisionModule()` throws `NOT_IMPLEMENTED` ("workflow engine arrives in v0.2").
- Arriving in v0.2: the workflow engine, the `profiles`, `images` and `workflows` API groups,
  config units, renderers and the image catalog.

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
