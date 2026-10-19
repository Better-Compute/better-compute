# @better-compute/capacity

GPU capacity for better-compute: device selectors, schedulability, the placement pipeline and placers, reservations, quotas, allocations and pool capacity rollups.

## Install

```sh
npm install @better-compute/capacity
```

It is also included in the umbrella package as `better-compute/capacity`:

```sh
npm install better-compute
```

It depends on `@better-compute/core` and `@better-compute/inventory`.

## Usage

The server always registers `capacityModule`, right after the inventory module and before any injected module. You configure it through `betterCompute()`:

```ts
import { formatSelector, parseSelector } from '@better-compute/capacity';
import { betterCompute } from '@better-compute/server';

const compute = betterCompute({
  // ...database, secret, baseURL, iam
  capacity: { placer: 'pool-lease', maxBatch: 64 }, // capacityModule options
  scheduler: { weights: { spread: 0.5 }, topN: 5 }, // plugins, scorer weights, top-N
});

const selector = parseSelector('gpuProduct in (H100-SXM5-80GB), vramGiB >= 80, !fabric.domain');
formatSelector(selector); // the same shorthand back
```

The placer can also be driven directly, inside a transaction:

```ts
import { inlinePlacer, parseSelector } from '@better-compute/capacity';

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

## What it covers

- the placement pipeline, the inline placer and the pool-lease placer, quotas, bookings and rollups;
- `capacityModule`, which serves the `pools`, `capacity`, `reservations` and `quotas` API groups.
  Reservation creates and extends run on the server's admission hook;
- fractional GPUs (MIG, timeslice/MPS slots and the atom rule), calendar reservations with
  BookingRepair, gangs, spot, `binding: 'node'` leases, dedicated nodes and attested bindings.

GPU devices, MIG layouts and bindings come from what bcd reports. These paths are tested against
simulated nodes and fake GPUs; they have not run on real GPU hardware yet.

## capacityModule

`capacityModule(options)` builds the module; `createCapacityPort(context)` backs `ctx.capacity`
for other modules.

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
  `BoundedExtend`) before the decision. It then raises every allocation's end all-or-nothing, under
  the pool lock. On a conflict it answers `{ extended: false, availableUntil }`.
  - The projection holds one pending value per reservation, so one extend at a time is decided
    (`capacity_extend_holds`, keyed by a nonce `prepare` mints, not by the caller-chosen request
    id). A concurrent one gets `CONFLICT` (`extend-in-flight`) and doesn't replace the duration
    being decided. A stalled hold is taken over after 60 s.
  - A refusal, a budget refusal, or a handler that throws after the allow (`admission.abandoned`)
    clears the pending change, but only its own.
- **`reservations.renew`** moves the lease deadline.
- **`release`** ends a reservation at `compute_now()`.
- **`cancel`** withdraws a reservation that has not started.
- **The `capacity.reservations` reconciler** walks each reservation through placed → binding
  (node spec invalidated) → active (after `markAllocationBound`) → released at its end or when
  its lease lapses.
  - A pending reservation retries every 30 s until `policy.maxPending` (default 24 h).
  - A bind timeout (5 min) re-places the reservation twice, then fails it.
- **Delegated confirmation.**
  - A `CONFIRMATION_REQUIRED` refusal parks the draft in `awaiting-confirmation`, with the
    confirmation id and a deadline of at most 30 minutes.
  - The agent's retry with the same key decides the same draft again.
  - An unconfirmed request becomes `expired`.
- **`reservations.list`** defaults to `scope: 'mine'`, the caller's own reservations.
  `scope: 'all'` lists the whole tenant. Pages follow `(created_at, id)`.
- **`capacity.timeline`** reports GPUs booked per bucket (5 min to 24 h each, at most 7 days),
  for calendar views.
- **`pools.update`** changes a pool's policy or GPU model and refreshes every tenant's authz view
  of the pool.
- **`quotas.set`** is a fleet operation. **`pools.archive`** unoffers the pool everywhere and
  takes no new work; live bookings run out.
- **`capacity.rollup`** rebuilds every pool's rollup every 5 minutes.
- **`capacity.usage`** writes hourly `usage_windows` for the IAM usage sink.
  - Meter: `gpu.<model>.hours`, billed on reserved time from `active` (`bound_at`) to the release
    or the booked end.
  - Only final windows are written, idempotently by `cmp:<allocId>:<windowStartMs>`.
  - Delegated work bills the person and tags the agent.
  - `meterAllocation` lets other modules, such as vps, meter their own allocations.
- **`nodeSpec`** puts the CDI assignments of started reservations in the node's `devices`
  section.
- **`pools.offer`** enforces the offering validator. A pool with tenant-owned nodes, or a
  `timeslice`/`mps` pool, goes only to its owner. A `policy.singleTenant` pool (container
  runtimes) goes to one tenant besides its owner, without `includeDescendants`, and
  `pools.update` refuses to set the flag while more than one tenant holds an offer.
- **Attested bindings** (`capacityModule({ attestedBindings })`). `markAllocationBound` stores the
  node's signed report as received (`bound_report`, `bound_sig_kid`, `bound_sig`). With the option
  set, the reservation worker verifies it before the binding counts:
  - a verified report replaces the binding with the signed devices;
  - an unsigned, forged or replayed one never counts. In `binding`, `bound_at` is cleared, so
    nothing is billed and the reservation waits for a real report or its bind timeout. In `active`,
    the binding is marked lost (`Degraded`). Both publish `reservation.binding-rejected`.

  The server passes a pki-backed check when command signing is configured. Node leases are exempt,
  since metal binds them.

- **`capacity.preview`** dry-runs a request without booking it.

## Selectors

Selectors are structured `matchExpressions` over device attributes, then node labels. The ops
are `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Gte`, `Lt` and `Lte`.

- `parseSelector` reads the CLI shorthand, for example
  `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80, mig.capable, !fabric.domain`.
- `formatSelector` prints a selector back in the same shorthand.
- `assertSelector` validates a selector's shape.
- Comparisons are numeric. `In` and `NotIn` compare as strings.

## Schedulability

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

**Dedicated nodes.** `nodes.taint { add: ['dedicated=acme'] }` stores `taint:dedicated=acme`.
Placement for tenant `acme` tolerates that one reason, and every other tenant's placement treats
it as NoSchedule. A dedication plus any other reason, or two tenants' dedications, blocks
everyone. Placement paths pass the request's tenant: `isSchedulable(node, pool, tenantId)` and
`schedulableSqlTolerating('$n::text[]')` bound to `[dedicatedTaint(tenantId)]`. Rollups and the
generic `schedulableSql` still count a dedicated node as NoSchedule (bucket `unhealthy`).

## Placement

`planPlacement(request, nodeViews, pool, { plugins, weights })` is pure. It runs these steps:

1. **Filters.** Eligibility (for the request's tenant), `excludeNodes`, `nodeLabels` (every named
   label with exactly that value, e.g. a runtime a host advertised as `bc.dev/driver.kata`), scalar
   room (`floor(allocatable × ratio) − allocated`), plugin filters, then device fit with selectors.
2. **Atom pick.** Plugin `preferAllocation` pickers win for their class. Otherwise the default pick
   prefers NVLink-complete sets, then the fewest NUMA nodes. `topology: 'nvlink-all'` refuses
   anything less than all-NV.
3. **Scorers.** The built-ins are:
   - `binpack` (weight 1): keeps 8-GPU boards whole.
   - `topology` (1): NV > PIX > PXB > PHB > NODE > SYS.
   - `fragmentation` (0.25).
   - `spread` (0).
   - `image-cached` (0.5): only for requests with an `imageId`, such as VPS instances. It scores 1
     on nodes whose runtime caches the image, from `node_image_cache` (`readImageCachedNodes`).

   Plugin scorers add to these. `weights` overrides any of them by id.

`choosePlan` then picks at random among the top `topN` (default 5). `summarizeRejections` explains
an empty result, e.g. `no node fits (3 nodes): 2 × fits: 1 of 4 gpu free; 1 × cordoned`.

Scheduler plugins' `admit(request, admission)` hooks are admission decisions: they run once, in the
request's own transaction, with the caller's `AdmissionContext`. That covers `reservations.create`
(inline, pool-lease and `binding: 'node'` leases) and bookings other modules make through
`createCapacityPort().reserve(tx, request, { admission })` (e.g. `instances.create`). The system's
own re-placements of an admitted request carry no caller and do not re-admit: pending retries,
BookingRepair, bind-timeout re-places, preemption and a module's retries. Filters and scorers apply
to every attempt.

`inlinePlacer()` runs this inside the admission transaction:

- It plans on plain reads. When the request allows it (no selectors, no plugin scorers, no gang),
  it plans from an exact SQL shortlist (`planFromShortlist`): the best 48 nodes by the
  count-derived part of the score, used only when no other node could reach the top N. Otherwise
  it loads every `NodeView`. The shortlist reads per-node device counts from
  `capacity_device_counts` (migration `capacity/0003`, kept exact by a trigger on `devices`), never
  an aggregate of the pool's devices.
- Then it locks the pool (`FOR UPDATE`) and commits the chosen node inside
  `SAVEPOINT capacity_place_<n>`. The critical section is the commit alone.
- The node is locked with `FOR SHARE OF n` under `schedulableSql`, and the atoms with
  `FOR SHARE` where they are healthy and bookable.
- Bookings use `INSERT … ON CONFLICT DO NOTHING`, which honours the `EXCLUDE` constraint.
- Scalars use a guarded `UPDATE`. Then come the allocation row and the rollup delta.
- A lost race rolls back to the savepoint and replans without that node, up to `maxAttempts`
  (default 3). After that it answers `pending`, with the conflict trail.

### Choosing a placer

|                                                  | `placer: 'inline'` (default)      | `placer: 'pool-lease'` (recommended in production)                          |
| ------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------- |
| `reservations.create` answers                    | `placed` or `pending`             | `pending` with a `Queued` condition, then `placed` once the batch runs      |
| Where placement runs                             | the admission transaction         | the `capacity.placer` worker that owns the pool's shard (`shardBy: 'pool'`) |
| Pool lock                                        | only around the commit (a few ms) | never at admission; once per batch of ≤64                                   |
| Throughput (repository benchmark, PGlite, 1k nodes) | ~35 placements/s                  | ~1,500 placements/s (10k nodes: ~1,000)                                     |

```ts
betterCompute({ /* … */ capacity: { placer: 'pool-lease', maxBatch: 64 } });
```

Both placers use the same guarded commits, so neither can double-book. Instances, gangs,
BookingRepair and spot preemption always place synchronously. VPS instances stay inline on purpose:
they are created far less often than reservations, and queuing them would need a withdraw path in
the CapacityPort. Inline stays the library default because it is synchronous and simpler to test;
production hosts on PostgreSQL should use pool-lease.

## Spot reservations and node leases

- **Spot.** `spot: true` reservations bill `gpu.<model>.spot.hours`. A regular request that would
  go pending may preempt them:
  - A started spot reservation gets a notice. It is cut back to end at `now + spotNoticeMs`
    (default 2 min), with a `Preempted` condition and a `reservation.preempting` event, and is
    released at the deadline.
  - A spot reservation that has not started is re-queued.
  - Notices never name another tenant's reservation.
- **Node leases.** `binding: 'node'` with `node: { profileId, profileVersion? }` in a
  `policy.tenantRoot` pool books a whole `ready` node. Metal deploys the tenant profile from the
  lease start and marks the allocation bound.
  - Billing is `node.metal.hours` plus the GPUs healthy at each window's start (`billableLines`).
  - Unhealthy GPUs show in an `UnhealthyAtoms` condition.

## MIG layout changes

A `mig` pool's `policy.migLayout` reaches nodes through provision's `mig-layout { from: 'pool' }`
config unit. A change must never repartition booked GPUs, so it goes through a gate:

1. `pools.update` freezes every node of the pool at the old layout, with the new one pending
   (`capacity_mig_layouts`, migration `capacity/0004`). Provision reads the node's gated layout,
   falling back to the pool's for nodes never gated.
2. The `capacity.mig` reconciler (shardBy node) books every GPU family on the node, parent and
   every atom, from the end of its last booking onward (`bookPartitionChange`). Nothing new lands
   past that point, though idle time before it still books.
3. At that time it grants the new layout and invalidates the node spec. The daemon repartitions
   idle GPUs.
4. Once the node has converged a newer spec, the holds are released. A node whose host config
   doesn't take its layout from the pool never repartitions for it, and is released at the grant.
   No timer releases a hold, since work could then land on atoms a late repartition destroys. A
   node that never converges shows up in doctor as `capacity.mig.stuck`.

Events: `node.mig.scheduled`, `node.mig.granted`, `node.mig.applied`. Rollups don't count partition
holds.

## Operations, budgets and IAM reactions

- **Async-with-wait.** Every reservation view carries `operation: { id, state, error? }`:
  - `running`: queued for a pool-lease batch;
  - `pending`: Unschedulable, or awaiting a person;
  - `succeeded`: placed or later;
  - `failed`: failed, denied, cancelled or expired, with the reason.

  `reservations.create` with `wait: { timeoutMs ≤ 30000 }` is held by the envelope while the
  operation is `running`. An inline create is done at once, so swapping placers changes no client.

- **Budgets.** With `policy.admission.budgetCheck: 'meter'`, or an offer whose
  `onBudgetExceeded` is `stop-new` / `drain` / `suspend`, `reservations.create` and `extend` call
  `iam.billingCheck` for the caller after the IAM decision, outside any transaction. A spent budget
  refuses with `SPEND_LIMIT_REACHED`, and the draft stays for a retry once the window resets.
  `applyBudgetPolicy` handles the alert itself: notify, and for `drain` it cancels the tenant's
  unstarted reservations.
  `pools.offer` and `pools.updateOffer` set the policy and `allowedRegions` per offer. `suspend` marks the
  offer `suspended_at`, publishes `quota.budget-suspended`; vps's `vps.suspension` sweep (every minute, no host
  wiring needed; `sandboxIamReactions.budget` makes it immediate) stops the tenant's running instances in the pool; while it is set every
  admission (`budgetAdmissionCheck`, `offerAdmissionCheck`) refuses with `SPEND_LIMIT_REACHED`, until
  `pools.updateOffer({ suspended: false })`, which restarts nothing.
- **IAM reactions.** `withdrawAgentReservations` (an agent suspended, a delegation revoked) and
  `reassignReservations` (an owner offboarded) cancel unstarted reservations, or move them to the
  successor along with their authz row. Building blocks: `cancelPendingReservation`,
  `readReservationsBy`, `reservationAuthzRow`.
- **Active conditions.** An active reservation carries `Degraded` (`BindingLost`, `AtomUnhealthy`)
  and `NodeUnreachable`. These are conditions only; nothing is released. Node-controller and health
  edges wake it with `wakeStartedOnNode`, and it rechecks every 15 minutes otherwise.
- **Input schemas.** Every method's `validate` carries `jsonSchema` (`schemas.ts`) for the API
  reference. Structural problems are reported together as `details.issues`.

## Metrics and invariants

- `onPlacement(observation)` (module and placer option) reports every placement: placer, outcome,
  conflicts and seconds. Observability's `placementObserver` maps it to `placements_total`,
  `booking_conflicts_total` and `placement_seconds`.
- `placeablePending(tx, { now })` is an offline solver for the invariant that no pending
  reservation could be placed. It returns the pending reservations that would fit right now, and
  should be empty after a quiet period.

## Host resources

- The `capacity.hosts` reconciler (`syncNodeResources`, every `hostSyncEvery`, default 30 s) keeps
  every host's `vcpu`, `memoryGiB`, `hugepages2Mi` and `hugepages1Gi` rows in step with its applied
  inventory:
  - allocatable is the inventory total minus `policy.hostReserve` (default 2 CPUs and 8 GiB), with
    hugepage pools carved out of memory;
  - the ratio is `policy.overcommit` (hugepages never overcommit);
  - vps keeps `vps-host` pools' `vcpu`/`memoryGiB`/`diskGiB`;
  - `tenant-controlled` nodes add nothing;
  - rows never shrink below what is allocated.
- Reservations take `resources` ({ `vcpu`, `memoryGiB`, `hugepages1Gi` }, per node for a gang).
  - Without it, whole-GPU requests get `perGpuShare`: `policy.perGpu`, else the smallest per-GPU
    share among the pool's GPU hosts. The share is resolved at the draft and stored in the
    reservation's request.
  - These are placed with the devices and never charged to quota (`reservationDemand` counts
    devices only).
  - `capacity.preview` books the same.
- `deviceAssignments` gives each started hold `limits` (`assignmentLimits`): `cpuMillis`,
  `memoryBytes`, `hugepages1Gi`, and a cpuset on the devices' NUMA nodes (`readNodeTopology`).
  - The cpuset leaves out the host's reserved CPUs, and is set only when the nodes have room: CPUs
    for `cpus`, memory for `mems`.
- `PlacementRequest.onlyNodes` restricts a placement to named nodes (volume hosts). The exact
  shortlist narrows before cutting, so they can't be crowded out.
- `pool-policy` extensions (`policyValidators`) check pool policies at `pools.create` and
  `pools.update`.
- The cpulist helpers are `parseCpuList` and `formatCpuList`.

## Quotas

- `quotaDemand(request)` counts device classes and scalars. Hugepages count as `memoryGiB`
  (`quotaScalar`).
- `chargeQuota` is all-or-nothing, inside a savepoint. It throws `QUOTA_EXCEEDED` with
  `details: { resource, poolId, requested, max, used }`. A missing row grants 0.
- `refundQuota` never drives a counter below 0.
- `setQuota` never lowers `max` below `used`.
- `readQuotas` lists a tenant's rows.

A reservation holds its charge from admission until it is terminal, `pending` included. That is
why the placer never charges quota.

## Allocations

- `releaseAllocation` releases at `compute_now()`. It truncates the current booking, deletes
  future ones and keeps past ones. It returns scalar claims and rollups, and it is idempotent.
- `extendAllocation` moves the end later. On a conflict it answers
  `{ status: 'conflict', availableUntil }` and changes nothing.
- `readAllocation` and `readOwnerAllocations` read allocations back.

## Rollups

`pool_capacity_rollup` is kept current by deltas in the booking transaction (`applyRollupDelta`).
`rebuildPoolRollup` recomputes it from nodes, devices, bookings and `node_resources`. Reads
(`readPoolCapacity`, `readPoolsCapacity`) never aggregate devices.

## Topology

The capacity module's migration `capacity/0001_device_links` creates `capacity_device_links`.
Fill it with `writeDeviceLinks(tx, nodeId, pairs)` from the inventory `gpus` topology matrix.

## Documentation

- [Capacity](https://better-compute.com/docs/guides/capacity)
- [Placement](https://better-compute.com/docs/guides/capacity/placement)
- [Reservations](https://better-compute.com/docs/guides/capacity/reservations)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
