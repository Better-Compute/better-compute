Instances are VMs in a VPS pool: hosted pools place them on a host through capacity, and provider pools create them through the pool's provider account. After `create`, every call only changes `desiredState`; the `vps.instances` reconciler converges the instance and publishes `instance.*` events as its `state` moves. Instances are also the sandbox primitive today. See [Instances](/docs/guides/vps/instances).

## create

Admits a VM from a pool, flavor and image after one IAM decision on the draft; returns the instance in `scheduling`, or in `provisioning` with a `nodeId` when a hosted pool placed it at once.

- **Idempotency.** `idempotencyKey` is required. The instance id derives from the tenant, the caller and the key: a retry of a finished request returns the same instance without a second decision, and a different request under the same key is `CONFLICT` with `details.instanceId`.
- **IAM.** `compute:instances:create` is decided on `compute-instance/` plus the draft id, whose attributes (`vcpu`, `memoryGiB`, `gpus`, `imageId`, `imageVerified`, `projectId`) policies can test. A refusal deletes the draft; a delegated session can get `CONFIRMATION_REQUIRED`.
- **Errors.** `NOT_FOUND` for a pool the tenant neither owns nor is offered, an archived pool, a missing or archived flavor, or an image a hosted pool cannot resolve. `INVALID_INPUT` for a pool that is not `vps-host` or `provider`. `QUOTA_EXCEEDED` when the shape does not fit the tenant's quota; `CAPACITY_UNAVAILABLE` when a hosted pool has no free IP address. `INVALID_STATE` for a provider pool without an account, `INVALID_CONFIG` for a hosted pool when `vps()` has no `images`.
- **Events.** `instance.created`, and `instance.scheduled` with the `nodeId` when a hosted instance is placed. When no host fits, the instance stays in `scheduling` with an `Unschedulable` condition and is retried every 30 seconds.

## list

Returns a page of the tenant's instances, newest first, with a `cursor` when more remain.

`scope` defaults to `mine`, the caller's own instances; `all` returns every instance of the tenant that the caller may read. `state` and `poolId` filter the list, and `limit` is 1 to 200 (default 50). Drafts are never listed.

## get

Returns one instance of the tenant, deleted instances included.

Drafts and instances of other tenants are `NOT_FOUND`.

## start

Sets `desiredState` to `running` and wakes the reconciler; returns the instance before anything has changed on the host or provider.

An instance in `error` that has a host or a provider machine moves to `starting` and is tried again. An instance being deleted is `INVALID_STATE`. Publishes `instance.starting`.

## stop

Sets `desiredState` to `stopped` and wakes the reconciler; returns the instance before anything has changed on the host or provider.

An instance being deleted is `INVALID_STATE`. Publishes `instance.stopping`.

## resize

Moves a stopped hosted instance to another flavor of its pool, in place on the same host; returns the instance `stopped` with the new flavor.

Growth is charged to quota first and shrinkage refunded after; if the host lacks room the charge is undone and the call is `CAPACITY_UNAVAILABLE` with `details.resource`. Other errors: `UNSUPPORTED` for a provider instance or a flavor with a different GPU count, `INVALID_STATE` when the instance is not stopped (both `state` and `desiredState`) or holds no allocation, `NOT_FOUND` for a missing or archived flavor, `QUOTA_EXCEEDED` when the growth does not fit. Publishes `instance.resized`.

## delete

Sets `desiredState` to `deleted` and wakes the reconciler, which releases the allocation, IP lease and quota; returns the instance at once.

The call is idempotent: an instance already `deleted` is returned unchanged, and stays readable through `get`. Publishes `instance.deleting`; `instance.deleted` follows when everything is released.

## attach

Makes a provider machine that already runs an instance of a tenant, without recreating it; returns the instance in `scheduling` with `origin: 'attached'`. The `vps.instances` reconciler then writes the provider's ownership label (`claim`) and follows the machine like any provider instance.

- **Input.** `poolId` is a `provider` pool owned by or offered to `tenantId` and backed by the machine's provider account. `externalId` is the machine as `providerAccounts.machines` lists it, which discovery must have seen and which must be free. `ownerIdentityId` defaults to the caller, so an operator can hand the instance to a person of the tenant (it then shows in their `scope: 'mine'` list). `onDelete` is `detach` (the default: deleting releases the machine, which keeps running) or `delete` (deleting deletes the machine).
- **Shape.** The flavor is the machine's own: its machine type, vCPU, memory and GPU count, with no disk. It is charged to the tenant's quota on the pool, as a create on a provider pool is.
- **Idempotency.** `idempotencyKey` is required. The instance id derives from the tenant, the caller and the key: a retry returns the same instance, and a different request under the same key is `CONFLICT` with `details.instanceId`.
- **IAM.** `compute:instances:attach` is decided on `compute-instance/` plus the instance id, whose attributes (`vcpu`, `memoryGiB`, `gpus`) policies can test. Only the platform (root callers) attaches machines of an account its own tenant does not own; a tenant attaches only from its own accounts (`ACCESS_DENIED` otherwise).
- **Errors.** `NOT_FOUND` for a pool the tenant neither owns nor is offered, or a machine discovery has not seen or marked gone (run `providerAccounts.discover`). `CONFLICT` with `details.instanceId` when another instance holds the machine, with `details.claimedBy` when discovery saw its ownership label name another instance, and when the pool is backed by a different provider account than the machine's. `INVALID_INPUT` for a pool that is not a provider pool, `QUOTA_EXCEEDED` when the machine does not fit the quota; nothing is written then.
- **Events.** `instance.attached` with `instanceId`, `accountId`, `externalId`, `poolId` and `onDelete`.
- **Ownership.** Once claimed, every read of the machine must show this instance's label. A machine whose label is gone or names another instance is never adopted, recovered or acted on again: the instance gets an `OwnershipLost` condition (an `AttachConflict` one when the first claim was refused), `start`, `stop` and `reboot` are `INVALID_STATE`, and deleting it finishes as a detach without any provider call.

## detach

Deletes an attached instance without deleting its machine; returns the instance in `deleting`. The reconciler removes the provider's ownership label (`release`), refunds the quota and drops the instance's access, and the machine keeps running in the provider account, free to be attached again.

- **Semantics.** `onDelete` becomes `detach`, whatever the attach chose. `delete` on an attached instance does the same when its `onDelete` is `detach` (the default for attach); with `onDelete: 'delete'` the reconciler first marks the machine as managed by better-compute and then deletes it. A machine whose label names another instance is never deleted: the instance fails with an `AttachConflict` condition.
- **Errors.** `INVALID_STATE` for an instance better-compute created (`origin: 'created'`): detaching it would leave a machine running that no one is billed for, so delete it instead. Instances of other tenants, or none, are `NOT_FOUND`. A `deleted` instance is returned unchanged.
- **IAM.** Decided as `compute:instances:delete` on the instance.
- **Events.** `instance.deleting`; `instance.detached` (not `instance.deleted`) follows when the label is released.

## reboot

Asks for a restart of a running provider instance's machine; returns the instance, still `running`. The `vps.instances` reconciler restarts the machine once, gracefully (`graceful-restart`) or, with `hard: true`, by a reset, and publishes `instance.rebooted` with `hard`.

- **Semantics.** A second reboot asked for while the first is pending is one restart; one asked for after it restarts the machine again. A provider without power control drops the request and records a `ProviderError` condition.
- **Errors.** `INVALID_STATE` when the instance is not running, or is being stopped or deleted. `UNSUPPORTED` for instances of hosted pools, for now. Instances of other tenants, or none, are `NOT_FOUND`.
- **IAM.** Decided as `compute:instances:update` on the instance.
