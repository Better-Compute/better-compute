A node's hardware and software inventory as the daemon reports it, kept as an append-only history of snapshots: a new snapshot is stored each time the node's reported section set changes. Every method decides `compute:nodes:read` on `compute-node/{nodeId}` and only answers for nodes the calling tenant owns. See [Inventory and health](/docs/guides/nodes/inventory-and-health).

## get

Returns the node's latest inventory snapshot: its hash, its sections and when it was collected.

`NOT_FOUND` when the node has no inventory yet or is not owned by the tenant.

## history

Lists the node's inventory snapshots newest first; returns a page with a cursor.

`limit` is at most 100 (20 by default). The cursor is the id of the last snapshot returned. `NOT_FOUND` when the node is not owned by the tenant.

## diff

Compares two of the node's snapshots, named by snapshot id or hash, and returns the changes between them with their stable device ids (GPU UUID, disk WWN or MAC).

- Without `to`, the latest snapshot is used; without `from`, the snapshot before `to`. A node with a single snapshot diffs against nothing: `from` is empty and there are no changes.
- Change types are `gpu.missing`, `gpu.added`, `disk.replaced`, `driver.changed` and `mig.layout.changed`, each with `before` and `after` values where they apply.
- `NOT_FOUND` when the node has no inventory, a named snapshot does not exist for the node, or the node is not owned by the tenant.
