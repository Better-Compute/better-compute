Block volumes and shared volumes (network file shares) on a provider account (DigitalOcean Block Storage and Network File Storage first), next to the account's [instances](/docs/reference/api/instances). Every call records what the tenant wants and returns at once, usually `pending`; the `vps.provider-resources` reconciler then converges the provider through `ProviderImpl.volumes` without blocking on provider actions, and writes back what it saw (`state` is `pending`, `ready`, `updating`, `deleting`, `deleted` or `error`, with the provider's `message`). Reading takes `compute:volumes:read`, everything else `compute:volumes:manage`, on `provider-volume/{id}`. A volume books its `sizeGiB` on the tenant's `diskGiB` quota for the pool and bills from `ready` until deleted: a block volume `vps.volume.gib.hours`, a shared volume `vps.share.gib.hours`. Once created, a volume is only read: one deleted at the provider outside better-compute goes to `error` and is never created again (its data is gone; delete it). See the [provider volumes guide](/docs/guides/vps/provider-volumes).

## create

Records a volume in a pool on a provider account and returns it `pending`, booking its `sizeGiB` (1 to 16384) on `diskGiB`.

- `region` must be one the account uses (`INVALID_INPUT`); a pool whose provider offers no volumes is `UNSUPPORTED`. `filesystem` (`ext4`, `xfs` or `none`) formats it at create; it is never changed later.
- `kind` is `block` (the default: a disk on one instance at a time) or `shared` (a network file share many instances of one tenant network mount at once). A shared volume needs `networkId`, a network of the tenant on the same provider account, provisioned, not being deleted (`INVALID_STATE`), with a subnet in `region` (`INVALID_INPUT` without one, `INVALID_STATE` while it is not ready); `networkId` on a block volume is `INVALID_INPUT`. A shared volume takes no `filesystem` and no `deleteWithInstance: true` (`INVALID_INPUT`). A provider that makes no shared volumes is `UNSUPPORTED` (`details.reason` `sharedVolumes`).
- What the provider would refuse before any request is refused here, before quota is booked: for example a DigitalOcean share under 50 GiB is `INVALID_INPUT` (`details.reason` `size`).
- `instanceId` attaches it once both exist: the instance must be the tenant's (`ACCESS_DENIED`), on the same account and region (`INVALID_INPUT`), for a shared volume on its network (`INVALID_INPUT`), and not being deleted (`INVALID_STATE`). The caller also needs `compute:instances:update` on that instance, decided on its own credential.
- `deleteWithInstance: true` deletes the volume with the instance it is attached to (on DigitalOcean, the Droplet's selective destroy names it); otherwise deleting the instance only detaches it.
- The name is unique in the tenant among volumes that are not deleted (`CONFLICT`). A tenant without room on `diskGiB`, or without a `diskGiB` quota row, is `QUOTA_EXCEEDED` (fail closed). The same `idempotencyKey` with the same input returns the same volume; with other input it is `CONFLICT`.

Publishes `providerVolume.created`, then `providerVolume.ready` (with its `device`, the path the guest sees) or `providerVolume.error`. A create the provider refused (an account volume limit, a name taken by a volume that is not this deployment's) is `error` and is retried by the periodic pass; deleting it makes no provider call.

## list

Returns the tenant's volumes in the order they were made (at most 1000), optionally of one pool or project, with their attachment (a shared volume: every attachment, as `attachments`). Deleted ones only with `includeDeleted`.

## get

Returns one volume: its `kind`, state, observed size, `device`, and the attachment (`instanceId`, `state`, `desiredState`) when it has one. A shared volume shows its `networkId`, every attachment as `attachments`, and `mount` (`source`, the NFS source `<host>:<path>` a guest mounts, and `type` `nfs4`) once the provider reports one.

## attach

Attaches the volume to an instance of the tenant on the same provider account and region, and returns it with the attachment `pending`; the reconciler attaches it at the provider without a reboot and publishes `providerVolume.attached`. Attaching it again to the same instance returns it unchanged. A block volume on another instance is `CONFLICT` (detach it first), one being detached `INVALID_STATE`. A shared volume attaches to any number of instances, each at most once; the instance must be on the volume's network (`INVALID_INPUT`), and one it is being detached from is `INVALID_STATE` until that finishes. Also decided as `compute:instances:update` on the instance, with the caller's own credential.

## detach

Detaches the volume from an instance and returns it. `instanceId` names the instance: it is required for a shared volume (`INVALID_INPUT` without it); for a block volume, naming an instance it is not on changes nothing. Then the reconciler asks the provider even while an attach is still running there, and publishes `providerVolume.detached` once the provider has let it go. A volume not attached to that instance (or to anything) is returned as it is. A `deleteWithInstance` volume whose instance is being deleted is `INVALID_STATE`: it goes with the machine.

## resize

Grows the volume to `sizeGiB`, booking the difference on `diskGiB`, and returns it; the reconciler resizes it at the provider (`updating`, then `ready`) and publishes `providerVolume.resized`. A smaller size is `INVALID_INPUT`; the same size returns it unchanged. The filesystem is not grown: the guest does that.

## snapshot

Records a snapshot of the volume named `name` and returns it `pending` (a [provider snapshot](/docs/reference/api/provider-snapshots)); a retry with the same `idempotencyKey` returns the same snapshot. A volume has at most 25 snapshots that are not deleted (`QUOTA_EXCEEDED`); the name is unique among them (`CONFLICT`). Decided on the volume.

## delete

Marks the volume for deletion and returns it `deleting`; the reconciler deletes it at the provider, refunds its `diskGiB` and publishes `providerVolume.deleted`. A volume any instance still has attached is `INVALID_STATE` (detach it first; a shared volume from every instance). A volume never created at the provider, or whose create was refused, is finished without a provider call; one whose create answer was lost is looked up by name (never created to be deleted). Deleting a volume being deleted returns it.
