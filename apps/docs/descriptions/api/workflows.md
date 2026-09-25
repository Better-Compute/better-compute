The workflows group reads the provisioning workflows of a node and lets an operator abort, retry, pause or resume one. Workflows are started by other modules, such as metal for each workflow-driven provision state, not through this group. Every method is decided on the node (`compute-node`): reads as `compute:workflows:read`, the others as `compute:workflows:manage`. See [Provisioning workflows](/docs/guides/bare-metal/workflows).

## get

Returns one workflow of the node with all its steps, including each step's phase, state, attempt, command, deadline, result and error.

`NOT_FOUND` unless the workflow belongs to the tenant and the node.

## list

Returns a page of the node's workflows with their steps, newest first.

`limit` defaults to 20 and is at most 100; pass the returned `cursor` to read the next page.

## abort

Cancels a workflow: pending steps are cancelled, the in-flight step's command is cancelled, and the cleanup phase runs before the workflow ends `cancelled`.

- A `pending` or `failed` workflow is cancelled at once, with no cleanup, and publishes `workflow.cancelled`.
- Aborting a workflow that is already cancelled or cancelling does nothing; aborting a succeeded one is `INVALID_STATE`.
- The optional `reason` (at most 512 characters) is recorded in the workflow's error.

Aborting a workflow that metal owns fails the node; steer metal nodes with `metal.abort` and `metal.recover` instead.

## retry

Runs a failed workflow again from `fromStep`, by default the first main step that did not succeed; that step and every later main step return to `pending` with the next attempt number, and on-failure and cleanup steps are re-armed.

- `INVALID_STATE` unless the workflow is `failed`.
- `INVALID_INPUT` when `fromStep` is not a main step, or when every main step succeeded.
- `CONFLICT` when the node has another active workflow.

Publishes `workflow.retried` with the `fromStep`.

## pause

Pauses a running workflow: the step in flight finishes, but no further step starts until `resume`.

`INVALID_STATE` when the workflow is not `running`, or when it is in its cleanup phase after a failure or abort. Publishes `workflow.paused`.

## resume

Puts a paused workflow back to `running` and queues it to continue with its next step.

`INVALID_STATE` when the workflow is not `paused`. Publishes `workflow.resumed`.
