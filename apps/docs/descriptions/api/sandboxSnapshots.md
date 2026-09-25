Sandbox snapshots are their own resource, so a snapshot kept with `keep: true` outlives the sandbox it came from. `sandboxes.snapshot` takes them and `sandboxes.create` restores from them with `fromSnapshot`. These methods list, read and delete them. Snapshots stay private to their tenant and are never promoted to shared images. See [Sandboxes](/docs/guides/vps/sandboxes).

## list

Returns a page of the tenant's snapshots, newest first, including kept snapshots of deleted sandboxes.

`scope` defaults to `mine`, the caller's own snapshots; `all` lists the tenant's. `sandboxId` keeps one sandbox's snapshots. `limit` is 1 to 200 (default 50), and `cursor`, the last snapshot id of the previous page, is set while more remain. Deleted snapshots are never listed. Decided as `compute:sandboxes:read` on the tenant.

## get

Returns one snapshot of the tenant with its state (`pending`, `ready` or `failed`), and once ready its sha256, size, runtime and CPU model.

A deleted snapshot, or one of another tenant, is `NOT_FOUND`. Decided as `compute:sandboxes:read` on the snapshot.

## delete

Deletes a snapshot at once for reads and restores; the stored object is removed by the next `vps.sandboxes` pass (after its upload settled, for a pending one), so no network call runs in the request.

Idempotent: deleting a deleted snapshot answers `{ deleted: true }` again; an unknown one is `NOT_FOUND`. Publishes `sandbox.snapshot.deleted`. Decided as `compute:sandboxes:delete` on the snapshot.
