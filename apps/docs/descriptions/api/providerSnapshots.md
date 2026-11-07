Snapshots of [provider volumes](/docs/reference/api/provider-volumes), made with `providerVolumes.snapshot` and converged by the `vps.provider-resources` reconciler. Reading takes `compute:volumes:read`, deleting and restoring `compute:volumes:manage`, on `provider-snapshot/{id}`. A snapshot books no quota and bills `vps.snapshot.gib.hours` (the GiB the provider reports) from `ready` until deleted.

## list

Returns the tenant's snapshots in the order they were made (at most 1000), optionally of one volume. Deleted ones only with `includeDeleted`.

## get

Returns one snapshot: its volume, name, region, size and state.

## delete

Marks the snapshot for deletion and returns it `deleting`; the reconciler deletes it at the provider and publishes `providerVolume.snapshot.deleted`. Deleting a snapshot being deleted returns it. A volume restored from it is not affected.

## restore

Creates a new volume from a `ready` snapshot (`INVALID_STATE` otherwise), in the snapshot's pool and region, and returns it `pending`, as [`providerVolumes.create`](/docs/reference/api/provider-volumes) does: `sizeGiB` is at least the snapshot's (`INVALID_INPUT`; absent, the snapshot's size) and books `diskGiB`, the name is unique in the tenant, and the same `idempotencyKey` returns the same volume. The volume keeps the snapshot's filesystem: `filesystem` is `INVALID_INPUT` (a format could wipe the restored data). Only a volume snapshot this deployment made restores (the provider refuses any other, `INVALID_STATE`). A snapshot of a shared volume does not restore yet: `UNSUPPORTED` (`details.reason` `sharedRestore`). Decided on the snapshot.
