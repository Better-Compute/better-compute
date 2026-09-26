A reservation is a tenant's claim on devices of one pool for a time window. `create` first writes the request as a draft, Better IAM decides once on that draft with the request as attributes, and only an allowed draft is charged against quota and placed. A reservation holds its quota charge until it reaches a terminal state, and the `capacity.reservations` reconciler drives it through `placed`, `binding` and `active` to `released`. See [Reservations](/docs/guides/capacity/reservations).

## create

Books devices of one pool for a time window after one IAM decision on the draft; returns the reservation, `placed` or `pending`.

- **Idempotency.** The reservation id is derived from the tenant, the caller's identity and `idempotencyKey`. The same key with the same request returns the stored reservation without a second decision once it is past the draft stage, and decides the same draft again while it is still a draft. The same key with a different request is `CONFLICT`, with `details.reservationId`; a key whose request was refused stays `ACCESS_DENIED`. `wait` is not part of the compared request.
- **Decision.** `compute:reservations:create` is decided on the draft (`compute-reservation`), with attributes such as `gpuModel`, `gpuCount`, `durationHours` and `region`. When an agent in a delegated session is refused and IAM opens a confirmation request, the call fails with `CONFIRMATION_REQUIRED` and the draft waits in `awaiting-confirmation` for at most 30 minutes; a retry with the same key after approval continues it.
- **Errors.** `NOT_FOUND` when the pool is not owned by or offered to the tenant, or is archived. `INVALID_INPUT` when a device class or sharing mode does not match the pool's, `binding: 'node'` names a pool without `policy.tenantRoot`, `binding: 'kubernetes'` names a pool without `policy.kubernetes`, or a node binding asks for `resources`. `UNSUPPORTED` for any binding other than `hold`, `node` or `kubernetes`. `QUOTA_EXCEEDED` when the charge does not fit; the draft stays, so the same key can be retried. `SPEND_LIMIT_REACHED` when the pool or the tenant's offer asks for a budget check and the budget is spent.
- **Host resources.** `resources` (`vcpu`, `memoryGiB`, `hugepages1Gi`, per node for a gang) books host CPU, memory and 1 GiB hugepages on the same node as the devices, and the node enforces them. Without it, a request for whole GPUs books the pool's per-GPU share, stored on the reservation at creation. That share is `policy.perGpu` where it is set, or otherwise the smallest share any of the pool's GPU hosts can give (its allocatable CPUs or memory divided by its bookable GPUs). Requests for MIG instances or slots alone, and pools whose hosts report no CPU or memory rows, book none. Host resources are not charged to quota: the GPUs are.
- **Placement.** A request that does not fit, and is not spot, may preempt spot work. Otherwise it is `pending` with an `Unschedulable` condition and retried every 30 seconds, or, with the pool-lease placer, `pending` with a `Queued` condition. `wait.timeoutMs` (at most 30 seconds) holds the answer while the reservation is queued; a timeout returns the reservation still queued, not an error.

Emits `reservation.placed`, `reservation.pending`, `reservation.queued` or `reservation.awaiting-confirmation`.

## get

Returns one reservation of the tenant with its `operation` and, once a node reported its devices bound, its `binding`.

Drafts are internal: the call is `NOT_FOUND` for them, as for a reservation that does not exist in the tenant.

## list

Returns the tenant's reservations newest first, skipping drafts, filtered by `state` and `poolId`, one page at a time.

With `scope: 'mine'` (the default) only the caller's own reservations are listed. With `scope: 'all'` the tenant's reservations are loaded and each one is checked as `compute:reservations:read` on the reservation, so only the allowed ones are returned. `limit` is 1 to 200, default 50; `cursor` is the id of the last reservation of the previous page, and the answer carries the next `cursor` while more remain.

## release

Ends a reservation now: its bookings are released at `compute_now()`, its quota is refunded, and it becomes `released`; returns the reservation.

A `pending` reservation is `cancelled` instead. A reservation already in a terminal state is returned unchanged. A request still in `draft` or `awaiting-confirmation` is `INVALID_STATE`. Freed capacity wakes the pool's pending reservations. Emits `reservation.released` or `reservation.cancelled`, with `reason: 'release'`.

## cancel

Withdraws a reservation that has not started (`pending` or `placed`): its bookings are released, its quota is refunded, and it becomes `cancelled`; returns the reservation.

A reservation already `cancelled` is returned unchanged. Any other state is `INVALID_STATE`; use `release` for a reservation that has started. Drafts are `NOT_FOUND`. It is decided as `compute:reservations:release`. Emits `reservation.cancelled`.

## extend

Moves the end of a `placed`, `binding` or `active` reservation later, all or nothing, after one IAM decision; returns the reservation and whether it was extended.

- Give exactly one of `until` (a new end, epoch milliseconds) or `by` (a duration); both or neither is `INVALID_INPUT`. Other states are `INVALID_STATE`.
- It is admitted like `create`: the pending change goes into the reservation's authz row with `durationHours` set to the total after the change, so a policy that caps duration also caps extensions. A refusal is `ACCESS_DENIED` and clears the pending change. `SPEND_LIMIT_REACHED` applies as for `create`.
- When another booking starts before the new end, nothing moves and the answer is `extended: false` with `availableUntil`, the latest end the bookings can reach.
- **Idempotency.** An `until` the reservation already reaches answers `extended: false` without a decision, so a retried `until` is safe. `idempotencyKey` does not replay: a repeated `by` extends again from the new end.
- While another extend of the same reservation is being decided, the call is `CONFLICT` with `details.reason: 'extend-in-flight'` and `retryAfterSeconds`.

Emits `reservation.extended` with the new `end`.

## renew

Moves the lease deadline of a renewable reservation to now plus its `leaseSeconds`, without changing its window; returns the reservation.

A reservation created without `leaseSeconds` is `INVALID_STATE`, as is one not in `placed`, `binding` or `active`. A lease that lapses without renewal releases the reservation with reason `lease-lapsed`. It is decided as `compute:reservations:extend`. Renewing emits no event.
