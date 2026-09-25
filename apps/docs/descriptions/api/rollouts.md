Rollouts take a registered bcd release to the nodes of the tenant's pools in waves, within each pool's disruption budget. A controller settles nodes as they report the new version, pauses the rollout when a wave's failure ratio exceeds its limit, and soaks between waves. Every method decides `compute:fleet:admin` on the fleet scope. See [Rollouts](/docs/guides/rollouts).

## create

Plans a rollout of a registered release to every node that runs bcd in the tenant's pools, or in `poolIds`, and starts it; returns the rollout in `running`.

- **Plan.** Nodes are shuffled by a hash of the rollout id and assigned to `waves`, cumulative percentages that must increase and end at 100 (default 1, 10, 50, 100). The other gates default to `maxFailureRatio` 0.05, `soakSeconds` 600 and `upgradeTimeoutSeconds` 900. Nodes that already report the version start as `succeeded`.
- **Idempotency.** `idempotencyKey` is optional. With a key, the rollout id derives from the tenant, the caller and the key: a repeat for the same version returns the existing rollout, and another version under the key is `CONFLICT`.
- **Errors.** `NOT_FOUND` when the version is not registered or a listed pool is not an unarchived pool of the tenant. `INVALID_STATE` when no node in scope runs bcd yet. `CONFLICT` with `details.rolloutId` when a node in scope is in another running or paused rollout. `INVALID_INPUT` for gates out of range.
- **Events.** `rollout.started`; the controller later publishes `rollout.wave`, `rollout.paused` and `rollout.completed`.

## list

Returns the tenant's 100 most recent rollouts, newest first, each with its node counts by state.

## get

Returns one rollout of the tenant with `nodeList`, each node's wave, state, previous version, timings and error, in rollout order.

A rollout of another tenant, or none, is `NOT_FOUND`.

## pause

Stops a running or paused rollout from starting more nodes and records `reason` (default "paused by an operator"); returns the rollout in `paused`.

Nodes already upgrading still settle. A completed or aborted rollout is `INVALID_STATE`. Publishes `rollout.paused`.

## resume

Sets a running or paused rollout back to `running`, clears its reason and wakes the controller; returns the rollout.

A rollout paused by the failure gate resumes the same way. A completed or aborted rollout is `INVALID_STATE`. Publishes `rollout.resumed`.

## abort

Ends a running or paused rollout: nodes not yet started are skipped, and with `rollback: true` upgrades not yet confirmed go back to the version they ran before; returns the rollout in `aborted`.

- With `rollback`, nodes still `upgrading` whose previous version is a registered release move to `rolling-back`, and the controller settles them. Nodes that `succeeded` keep the release: once a node confirmed it, bcd refuses every older binary, the one in its other slot included. Undo a bad release by publishing a newer one (a higher sequence) and rolling it out. Without `rollback`, nodes still upgrading are marked `failed`.
- `reason` defaults to "aborted by an operator". A completed or aborted rollout is `INVALID_STATE`. Publishes `rollout.aborted`.
