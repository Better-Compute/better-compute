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
