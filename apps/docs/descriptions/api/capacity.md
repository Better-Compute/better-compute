The capacity methods report what the pools a tenant can see hold, book and have free, without booking anything. `summary` and `byPool` read the per-pool rollup, which the booking transactions update and a periodic rebuild corrects. `preview` asks the placer whether a request fits, and `timeline` counts booked GPUs over time. All four are decided as `compute:capacity:read`. See [Capacity](/docs/guides/capacity).

## summary

Returns every pool the tenant owns or is offered, each with its rollup rows, plus whole-GPU totals per GPU model.

Archived pools appear only for their owner. `byGpuModel` sums only each pool's `gpu` row (`total`, `allocatable`, `allocated`, `reserved`, `available`), and a pool without a GPU model is counted under `other`. The `gpu.mig`, `gpu.slot` and scalar rows are in `pools[].capacity`. The decision is made on the tenant.

## byPool

Returns one pool's rollup rows, one per resource, ordered by resource name.

Each row carries `total`, `allocatable`, `allocated`, `reserved`, `available`, the `provisioning`, `unhealthy`, `maintenance` and `unreachable` buckets, and `updatedAt`. `available` is conservative: an atom booked now and again later counts in both `allocated` and `reserved`. The call is `NOT_FOUND` when the pool is not owned by or offered to the tenant, or is archived and the tenant is not its owner. `pools.capacity` returns the same rows.

## preview

Runs the placer on a reservation request without booking anything and returns whether it fits now, the candidate nodes with the atoms each would take, and a reason when it does not fit.

- The input is the `reservations.create` input, validated the same way, `idempotencyKey` included. Nothing is written and no quota is checked.
- Up to 10 ranked candidates are returned, each with `nodeId`, `atoms` and `score`. With `gang`, the candidates are the members of the best gang. With `binding: 'node'`, they are the whole nodes a lease would take.
- When a regular (not `spot`) request does not fit, `preemptible` says how many spot reservations would get a notice and when the request would start. It gives a count only, never the other reservations' ids.
- `NOT_FOUND` when the pool is not visible to the tenant.

## timeline

Returns, for one pool, the number of whole GPUs booked in each time bucket and how many of the pool's allocatable GPUs remain free.

`from` defaults to the start of the current hour, `to` to 24 hours after `from`, and `stepMinutes` to 60. A timeline spans at most 7 days and 336 buckets, and `to` must be after `from`; otherwise the call is `INVALID_INPUT`. `allocatable` comes from the pool's current `gpu` rollup row, and each bucket's `free` is `allocatable` minus `booked`, never below 0. MIG and slot atoms are not counted. `NOT_FOUND` when the pool is not visible to the tenant.
