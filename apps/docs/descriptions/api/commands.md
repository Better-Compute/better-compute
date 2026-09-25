One-shot actions on one node, queued as durable rows in the node's command queue and delivered in order over its session. Every method is decided on `compute-node/{nodeId}`: `run` and `cancel` with `compute:nodes:exec`, `get` and `list` with `compute:nodes:read`. See [Commands](/docs/guides/nodes/commands).

## run

Queues a command of an allowlisted kind (`diag.nvml`, `inventory.refresh`, `logs.collect`, `node.reboot`) on a node the tenant can see; returns the command, `pending` when first queued.

- Idempotent per tenant, caller identity and `idempotencyKey`: a retry with the same key returns the command already queued. The same key with a different `kind` is `CONFLICT`.
- `notAfterSeconds` (10 to 3600, default 600) sets how long the command may wait for the node before it expires.
- Any other kind is `UNSUPPORTED`; a payload that does not match the kind's schema is `INVALID_INPUT`; a node outside the tenant's view is `NOT_FOUND`.
- For `logs.collect`, when the server has `supportBundles` with a presigning blob store, the daemon receives a presigned upload URL and the response carries the bundle's `bundleKey`.
- Emits `node.command.queued` when the command is first queued, not on a replay.

## get

Returns one command of a node by id, with its state, deadlines and safety flags.

`NOT_FOUND` when the command is not on that node or the node is outside the tenant's view.

## list

Lists a node's commands newest first (by queue sequence), optionally filtered by `state`; returns a page with a cursor.

`limit` is at most 200 (100 by default). The cursor is the sequence of the last command returned.

## cancel

Cancels a command: a `pending` one becomes `cancelled` and never runs, an in-flight one (`dispatched`, `acked`, `running`) is asked to stop through its gateway; returns the command as it stands after the request.

- A command already in a terminal state (`succeeded`, `failed`, `rejected`, `expired`, `cancelled`) is returned unchanged and no event is emitted.
- An in-flight command keeps its state until the node reports; the request is recorded on the row.
- Emits `node.command.cancel-requested`. `NOT_FOUND` when the command is not on that node or the node is outside the tenant's view.
