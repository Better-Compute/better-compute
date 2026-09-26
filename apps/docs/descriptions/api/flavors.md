Flavors are the named instance shapes of a VPS pool: vCPU, memory, disk and GPU count, plus the provider offer a provider pool creates. The pool's owner manages them, and tenants the pool is offered to can list them. An instance keeps the shape it was admitted with, so changing or deleting a flavor never changes a live instance. See [Flavors](/docs/guides/vps/flavors).

## list

Returns the pool's flavors that are not archived, sorted by name.

The pool must be owned by or offered to the tenant; otherwise the call is `NOT_FOUND`.

## create

Adds a flavor to a `vps-host` or `provider` pool the tenant owns and returns it at version 1.

- `gpus` defaults to 0. A flavor of a provider pool needs `offerId`, the provider offer it creates; without it the call is `INVALID_INPUT`.
- `placement` (hosted pools only; `INVALID_INPUT` on a provider pool) says where the guest lives on its host, and sandbox templates on the flavor inherit it:
  - `hugepages: '2Mi' | '1Gi'` backs guest memory with hugepages. These are booked from the host's hugepage pools instead of its memory, still charged to quota as `memoryGiB`, and never ballooned.
  - `numaAffine` keeps the vCPUs and memory on one NUMA node: the GPUs' node, or otherwise the least-loaded node with room for the memory.
  - `pinned` gives each vCPU a host CPU that no other pinned guest on the host has.
  - A host that cannot honour `numaAffine` or `pinned` still runs the guest, floating, and the instance carries a `PlacementDegraded` condition with the reason (`NoNumaTopology`, `NoNumaNodeFits`, `GpuNumaUnknown`, `NumaMemoryTooSmall` or `NotEnoughFreeCpus`).
  - Resizing to a flavor with a different `placement` is `UNSUPPORTED`.
- `NOT_FOUND` when the tenant does not own the pool; `INVALID_STATE` when the pool is of another class.
- `CONFLICT` when the pool already has a flavor with that name, archived ones included.

## update

Replaces the shape of the named flavor and increments its version; an archived flavor becomes active again.

The input is the full shape, as for `create`. An omitted `offerId` keeps the stored one. Instances already admitted keep their old shape; only new instances and resizes use the new one. The call is `NOT_FOUND` when the tenant does not own the pool or the flavor does not exist.

## delete

Deletes the named flavor, or archives it when any instance, deleted ones included, still references it; returns `deleted` and `archived` to say which.

An archived flavor disappears from `list` and can no longer be used to create or resize instances. `update` makes it active again. The call is `NOT_FOUND` when the tenant does not own the pool or the flavor does not exist.
