Sandbox volumes are persistent disks on one host that a tenant's sandboxes attach across runs, so an agent keeps its memory, caches and checkouts. A volume is placed when it is created: its size is booked as `diskGiB` on one host of the pool, charged to the tenant's quota, and the host keeps it as a sparse raw file. A sandbox template names volumes with a mount path. Sandboxes of that template then run on the volume's host only, attach it as an extra virtio disk, and mount it by serial (`/dev/disk/by-id/virtio-<serial>`) from their user data. The first mount formats it as ext4, and no later one ever does. A volume takes any number of read-only attachments or one read-write attachment, never both. Volumes are metered as `vps.volume.gib.hours` from creation until the disk is released. See [Sandboxes](/docs/guides/vps/sandboxes).

## create

Books the volume's disk on one host of a hosted pool and puts it in that host's spec; returns the volume `ready`, with its `serial` and `nodeId`.

- `sizeGiB` runs from 1 to 16,384. The name is unique among the tenant's volumes that are not deleted (`CONFLICT` otherwise).
- `CAPACITY_UNAVAILABLE` when no host of the pool has the disk free (the reason is in the details), and `QUOTA_EXCEEDED` past the tenant's `diskGiB` quota.
- A provider pool is `INVALID_INPUT`: volumes live on hosted (`vps-host`) pools.
- Decided as `compute:sandboxes:manage` on the volume it would create (`compute-sandbox-volume`, under the pool), whose `sizeGiB` attribute is the requested size, so a policy can bound it. A refusal leaves nothing behind.

The volume id derives from the tenant, the caller and `idempotencyKey`. A retry with the same key returns the same volume; the same key with another pool, name or size is `CONFLICT`. Publishes `sandbox.volume.created` with the host.

## list

Returns the caller's own volumes, oldest first (`scope: 'mine'`, the default, as for snapshots), or with `scope: 'all'` every volume of the tenant. `poolId` narrows it to one pool, and `includeDeleted: true` adds deleted ones.

At most 500 volumes are returned. Decided as `compute:sandboxes:read` on the tenant.

## get

Returns one volume of the tenant: its size, serial, host and state (`ready`, `deleting` or `deleted`).

A volume of another tenant is `NOT_FOUND`. Decided as `compute:sandboxes:read` on the volume.

## resize

Grows a volume to `sizeGiB` on the host it lives on and returns it with the new size. A volume never shrinks.

- A size below the current one is `INVALID_INPUT`. The current size returns the volume unchanged.
- The growth is charged to the tenant's `diskGiB` quota first (`QUOTA_EXCEEDED` past it), then booked on the volume's host. When the host has no room it is `CAPACITY_UNAVAILABLE`: the quota charge is refunded and nothing changes.
- Only a `ready` volume grows (`INVALID_STATE` otherwise).

The host grows the file as soon as its spec carries the new size, even while a running sandbox has the volume attached: the guest's disk grows live. The filesystem on it grows when the next sandbox that attaches the volume boots, because its user data runs `resize2fs` on every writable volume. Inside a running guest, run `resize2fs /dev/disk/by-id/virtio-<serial>` to use the space at once. Publishes `sandbox.volume.resized`. Decided as `compute:sandboxes:manage` on the volume, with the new size as its pending `sizeGiB` (as `sandboxes.extend` decides a lifetime), so a policy bounds the size it grants; afterwards the volume's `sizeGiB` is the new size. One resize of a volume is decided at a time: another one meanwhile is `CONFLICT` (`details.reason: 'resize-in-flight'`), and a stalled one is taken over after 60 s.

## delete

Takes the volume out of its host's spec, and the host discards its file; the volume is `deleting` until the host has applied a spec without it, then `deleted`, and its disk booking and quota come back.

- `CONFLICT` while a sandbox that is not deleted attaches it, or while a template names it: delete those sandboxes, and update or delete the template, first.
- Deleting a volume that is already `deleting` or `deleted` returns it unchanged.

Publishes `sandbox.volume.deleting`, then `sandbox.volume.deleted`. Decided as `compute:sandboxes:manage` on the volume.
