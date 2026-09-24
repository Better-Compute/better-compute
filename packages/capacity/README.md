# @better-compute/capacity

Capacity for better-compute (PLAN.md §10.2–§10.6). This package covers:

- device selectors and schedulability;
- the placement pipeline and the v0.1 `inlinePlacer`;
- quotas, allocation release and extend, and pool capacity rollups.

It depends on `@better-compute/core` and `@better-compute/inventory`. The server registers it
before any injected module. Most apps reach it through `better-compute/capacity`.

**Status: v0.1.** Working now:

- the placement pipeline, the InlinePlacer, quotas, bookings and rollups;
- `capacityModule`, which serves the §9.2 `pools`, `capacity`, `reservations` and `quotas` groups.
  Reservation creates and extends run on the server's admission hook.

Still to come:

- `pools.update` and `pools.archive`, `capacity.timeline` and `quotas.set`, in v0.2;
- shared GPUs and cross-node gangs, in v0.5.

## capacityModule

```ts
import { capacityModule, createCapacityPort } from 'better-compute/capacity';

const capacity = capacityModule({ plugins: [], weights: { spread: 0.5 }, topN: 5 });
// The server registers it after inventoryModule. createCapacityPort(context) backs ctx.capacity.
```

- **`reservations.create`**
  - Transaction 1 (`admission.prepare`) looks up the idempotency key per tenant and caller
    identity. The same request replays. A different request under the same key is `CONFLICT`. A
    refused key stays `ACCESS_DENIED`.
  - It then writes the deterministic draft (`draftId('rsv', …)`) and its authz row. The row's
    attributes are `gpuModel`, `gpuCount`, `durationHours`, `region`, `binding`, `spot`,
    `renewable` and `projectId`.
  - Transaction 2 charges quota, then places the reservation. The result is `placed`, or
    `pending` with `Unschedulable`.
- **`reservations.extend`** writes the pending change (`durationHours` after the change, for
  `BoundedExtend`) before the decision. It then raises every allocation's end all-or-nothing. On a
  conflict it answers `{ extended: false, availableUntil }`.
- **`reservations.renew`** moves the lease deadline.
- **`release`** ends a reservation at `compute_now()`.
- **`cancel`** withdraws a reservation that has not started.
- **The `capacity.reservations` reconciler** walks each reservation through placed → binding
  (node spec invalidated) → active (after `markAllocationBound`) → released at its end or when
  its lease lapses.
  - A pending reservation retries every 30 s until `policy.maxPending` (default 24 h).
  - A bind timeout (5 min) re-places the reservation twice, then fails it.
- **`capacity.rollup`** rebuilds every pool's rollup every 5 minutes.
- **`nodeSpec`** puts the CDI assignments of started reservations in the node's `devices`
  section.
- **`pools.offer`** enforces the offering validator. A pool with tenant-owned nodes, or a
  `timeslice`/`mps` pool, goes only to its owner.
- **`capacity.preview`** dry-runs a request without booking it.

```ts
import { inlinePlacer, parseSelector } from 'better-compute/capacity';

const placer = inlinePlacer();
await sql.transaction((tx) =>
  placer.place(
    tx,
    {
      tenantId: 'acme',
      poolId: 'pool_…',
      reservationId: 'rsv_…',
      devices: [{ class: 'gpu', count: 4, selector: parseSelector('vramGiB >= 80') }],
      topology: 'nvlink-all',
      during: { start: Date.now(), end: Date.now() + 3_600_000 },
    },
    context, // clock, random, plugins, weights, topN
  ),
);
// → { status: 'placed', allocations: [...] } or { status: 'pending', reason: 'no node fits …' }
```

## Selectors

Selectors are structured `matchExpressions` over device attributes, then node labels. The ops
are `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Gte`, `Lt` and `Lte`.

- `parseSelector` reads the CLI shorthand, for example
  `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80, mig.capable, !fabric.domain`.
- `formatSelector` prints a selector back in the same shorthand.
- `assertSelector` validates a selector's shape.
- Comparisons are numeric. `In` and `NotIn` compare as strings.

## Schedulability (§10.2)

A node is schedulable when all of the following hold:

- its role is `host`;
- it is not in maintenance and not cordoned;
- its provision state is `adopted` or `deployed`;
- it is `connected`;
- it has no `NoSchedule` reason;
- it is `platform`, or it is `tenant-owned` and sits in its owner's pool.

`nodeBucket` reports where capacity counts: `schedulable`, `provisioning`, `unhealthy`,
`maintenance`, `unreachable` or `excluded`. `schedulableSql` is the SQL twin that placers lock
with. A test keeps the two in agreement.

## Placement (§10.3)

`planPlacement(request, nodeViews, pool, { plugins, weights })` is pure. It runs these steps:

1. **Filters.** Eligibility, `excludeNodes`, scalar room (`floor(allocatable × ratio) − allocated`),
   plugin filters, then device fit with selectors.
2. **Atom pick.** Plugin `preferAllocation` pickers win for their class. Otherwise the default pick
   prefers NVLink-complete sets, then the fewest NUMA nodes. `topology: 'nvlink-all'` refuses
   anything less than all-NV.
3. **Scorers.** The built-ins are `binpack` (weight 1, keeps 8-GPU boards whole), `topology`
   (1, NV > PIX > PXB > PHB > NODE > SYS), `fragmentation` (0.25) and `spread` (0). Plugin scorers
   add to them. `weights` overrides any of them by id.

`choosePlan` then picks at random among the top `topN` (default 5). `summarizeRejections` explains
an empty result, e.g. `no node fits (3 nodes): 2 × fits: 1 of 4 gpu free; 1 × cordoned`.

`inlinePlacer()` runs this inside the admission transaction:

- It locks the pool (`FOR UPDATE`), loads `NodeView`s, plans, and commits the chosen node inside
  `SAVEPOINT capacity_place_<n>`.
- The node is locked with `FOR SHARE OF n` under `schedulableSql`, and the atoms with
  `FOR SHARE` where they are healthy and bookable.
- Bookings use `INSERT … ON CONFLICT DO NOTHING`, which honours the `EXCLUDE` constraint.
- Scalars use a guarded `UPDATE`. Then come the allocation row and the rollup delta.
- A lost race rolls back to the savepoint and replans without that node, up to `maxAttempts`
  (default 3). After that it answers `pending`, with the conflict trail.

## Quotas (§10.3, D9)

- `quotaDemand(request)` counts device classes and scalars.
- `chargeQuota` is all-or-nothing, inside a savepoint. It throws `QUOTA_EXCEEDED` with
  `details: { resource, poolId, requested, max, used }`. A missing row grants 0.
- `refundQuota` never drives a counter below 0.
- `setQuota` never lowers `max` below `used`.
- `readQuotas` lists a tenant's rows.

A reservation holds its charge from admission until it is terminal, `pending` included. That is
why the placer never charges quota.

## Allocations (§10.5)

- `releaseAllocation` releases at `compute_now()`. It truncates the current booking, deletes
  future ones and keeps past ones. It returns scalar claims and rollups, and it is idempotent.
- `extendAllocation` moves the end later. On a conflict it answers
  `{ status: 'conflict', availableUntil }` and changes nothing.
- `readAllocation` and `readOwnerAllocations` read allocations back.

## Rollups (§10.6)

`pool_capacity_rollup` is kept current by deltas in the booking transaction (`applyRollupDelta`).
`rebuildPoolRollup` recomputes it from nodes, devices, bookings and `node_resources`. Reads
(`readPoolCapacity`, `readPoolsCapacity`) never aggregate devices.

## Topology

The capacity module's migration `capacity/0001_device_links` creates `capacity_device_links`.
Fill it with `writeDeviceLinks(tx, nodeId, pairs)` from the inventory `gpus` topology matrix.
