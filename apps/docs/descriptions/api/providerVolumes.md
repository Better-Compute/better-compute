Block volumes on a provider account (DigitalOcean Block Storage first), next to the account's [instances](/docs/reference/api/instances). Every call records what the tenant wants and returns at once, usually `pending`; the `vps.provider-resources` reconciler then converges the provider through `ProviderImpl.volumes` without blocking on provider actions, and writes back what it saw (`state` is `pending`, `ready`, `updating`, `deleting`, `deleted` or `error`, with the provider's `message`). Reading takes `compute:volumes:read`, everything else `compute:volumes:manage`, on `provider-volume/{id}`. A volume books its `sizeGiB` on the tenant's `diskGiB` quota for the pool and bills `vps.volume.gib.hours` from `ready` until deleted. See the [provider volumes guide](/docs/guides/vps/provider-volumes).

## create

Records a volume in a pool on a provider account and returns it `pending`, booking its `sizeGiB` (1 to 16384) on `diskGiB`.

- `region` must be one the account uses (`INVALID_INPUT`); a pool whose provider offers no volumes is `UNSUPPORTED`. `filesystem` (`ext4`, `xfs` or `none`) formats it at create; it is never changed later.
- `instanceId` attaches it once both exist: the instance must be the tenant's (`ACCESS_DENIED`), on the same account and region (`INVALID_INPUT`) and not being deleted (`INVALID_STATE`). The caller also needs `compute:instances:update` on that instance, decided on its own credential.
- `deleteWithInstance: true` deletes the volume with the instance it is attached to (on DigitalOcean, the Droplet's selective destroy names it); otherwise deleting the instance only detaches it.
- The name is unique in the tenant among volumes that are not deleted (`CONFLICT`). A tenant without room on `diskGiB`, or without a `diskGiB` quota row, is `QUOTA_EXCEEDED` (fail closed). The same `idempotencyKey` with the same input returns the same volume; with other input it is `CONFLICT`.

Publishes `providerVolume.created`, then `providerVolume.ready` (with its `device`, the path the guest sees) or `providerVolume.error`. A create the provider refused (an account volume limit, a name taken by a volume that is not this deployment's) is `error` and is retried by the periodic pass; deleting it makes no provider call.

## list

Returns the tenant's volumes in the order they were made (at most 1000), optionally of one pool or project, with their attachment. Deleted ones only with `includeDeleted`.

## get

Returns one volume: its state, observed size, `device`, and the attachment (`instanceId`, `state`, `desiredState`) when it has one.

## attach

Attaches the volume to an instance of the tenant on the same provider account and region, and returns it with the attachment `pending`; the reconciler attaches it at the provider without a reboot and publishes `providerVolume.attached`. Attaching it again to the same instance returns it unchanged. A volume on another instance is `CONFLICT` (detach it first), one being detached `INVALID_STATE`. Also decided as `compute:instances:update` on the instance, with the caller's own credential.

## detach

Detaches the volume from its instance and returns it; the reconciler asks the provider even while an attach is still running there, and publishes `providerVolume.detached` once the provider has let it go. A volume attached to nothing is returned as it is. A `deleteWithInstance` volume whose instance is being deleted is `INVALID_STATE`: it goes with the machine.

## resize

Grows the volume to `sizeGiB`, booking the difference on `diskGiB`, and returns it; the reconciler resizes it at the provider (`updating`, then `ready`) and publishes `providerVolume.resized`. A smaller size is `INVALID_INPUT`; the same size returns it unchanged. The filesystem is not grown: the guest does that.

## snapshot

Records a snapshot of the volume named `name` and returns it `pending` (a [provider snapshot](/docs/reference/api/provider-snapshots)); a retry with the same `idempotencyKey` returns the same snapshot. A volume has at most 25 snapshots that are not deleted (`QUOTA_EXCEEDED`); the name is unique among them (`CONFLICT`). Decided on the volume.

## delete

Marks the volume for deletion and returns it `deleting`; the reconciler deletes it at the provider, refunds its `diskGiB` and publishes `providerVolume.deleted`. An attached volume is `INVALID_STATE` (detach it first). A volume never created at the provider, or whose create was refused, is finished without a provider call; one whose create answer was lost is looked up by name (never created to be deleted). Deleting a volume being deleted returns it.
