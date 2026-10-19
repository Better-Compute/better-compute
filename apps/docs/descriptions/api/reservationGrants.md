Reservation grants commit slots of a provider capacity reservation to one tenant for a term. Root makes them: the reservation is the platform's (a GCE reservation on a root provider account, bound to a pool with `providerAccounts.bindReservation`), and a grant hands some of its slots to a tenant the pool is offered to, from `startsAt` to `endsAt`. Times are epoch milliseconds.

While a grant is in its term, its slots are the grantee's. `instances.create` on the reservation's flavor puts the grantee's instance into its grant while the grant has a slot its instances do not hold; once the grant is full, the instance takes an ordinary slot of the reservation if one is free. Nobody else can take a granted slot, even while the grantee leaves it idle: others share `total - in use - unused granted slots`. A grant that names a `projectId` serves only that project's instances. A reservation that is physically full refuses everyone, the grantee included, with `CAPACITY_UNAVAILABLE`.

Billing: the grantee is billed `vm.grant.slot.hours` for every committed slot, every hour of the term, used or not, once each hour has ended (the `vps.grants` reconciler writes them as usage, tagged with the reservation's region, the pool and the provider). Its instances inside the grant record only the informational `vm.grant.usage.hours`, never compute meters, so nothing is billed twice; an instance beyond its grant is billed at the reservation rate (`vm.reserved.*`). When a grant ends, its billing stops at `endsAt` and its running instances are billed at the reservation rate from then on, unless another grant of the tenant on the same reservation is live then (a renewal), which takes them on up to its free slots. Likewise a grant that starts while its tenant already runs instances on the reservation outside any grant takes them in, oldest first, from its start; instances attached with `billing: 'none'` are never taken in.

While a grant is `scheduled` or `active`, `providerAccounts.unbindReservation` and `providerAccounts.delete` refuse with `INVALID_STATE` (`details.grantIds`); deleting the account removes its ended and cancelled grants, once `vps.grants` has metered every committed slot-hour of the ended ones (until then `providerAccounts.delete` is `INVALID_STATE` with `details.grantIds`; retry after the reconciler's next pass past the hour the grant ended in). When a tenant is deleted, its active grants end and its scheduled ones are cancelled.

A grant's stopped instances keep their slots for the grantee: others never get a slot the grant pays for.

When the provider stops reporting the reservation (the `vps.reservations` scan marks it gone), its active grants end at that moment and its scheduled ones are cancelled, as `end` would, with `reason: 'reservation-gone'` on their `reservation-grant.ended` / `.cancelled` events. Its instances are no longer reserved: they are billed on-demand from then on. When a scan sees the reservation's `total` drop below the slots its live grants hold (at their peak overlap), it publishes `reservation-grant.capacity-short` `{ accountId, reservationId, total, grantedSlots, grantIds }` in the platform's tenant, once per change of `total`. The grants keep billing: root decides which to end.

States: `scheduled` until `startsAt`, `active` during the term, then `ended`; `cancelled` when ended before it started. Each change publishes a `reservation-grant.*` event (`created`, `active`, `ended`, `cancelled`) in the grantee's tenant, with `{ grantId, poolId, projectId?, slots, startsAt, endsAt }`.

## create

Root only. Commits `slots` of a reservation to `grantTenantId` (optionally one of its projects) for `[startsAt, endsAt)` and returns the grant.

- **Who.** Decided as `compute:providers:manage` on the provider account. `tenantId` must be the root tenant and the caller a member of it; anyone else is `ACCESS_DENIED`.
- **The reservation** must be on that account, `ready`, and bound to a pool that is offered to the grantee: otherwise `NOT_FOUND`, `INVALID_STATE` (not ready, gone or unbound) or `INVALID_INPUT` (the pool is not offered to the grantee).
- **Capacity.** The slots of every grant (other than cancelled ones) whose term overlaps, plus these, must fit the reservation's `total`: otherwise `CAPACITY_UNAVAILABLE` with `details { total, granted }`. Concurrent grants are decided one at a time under the reservation's row lock, so they never over-commit it.
- **Project.** A `projectId` must be a project of the grantee (`INVALID_INPUT`, `details.reason` `project-not-grantee`).
- **Term.** `startsAt` may be at most 5 minutes in the past; `endsAt` must be after it (`INVALID_INPUT`).
- **Idempotency.** A retry with the same `idempotencyKey` returns the grant; a different request under the key is `CONFLICT`.

## get

Returns one grant of the tenant. Root, acting in the root tenant, can read any grant. Decided as `compute:quotas:read` on the tenant. A grant of another tenant is `NOT_FOUND`.

## list

Returns the tenant's grants as `items`, newest first (at most 1000). With `all: true`, root (acting in the root tenant) lists every tenant's grants; anyone else asking for `all` is `ACCESS_DENIED`. A plain read decided as `compute:quotas:read` on the tenant (the grants are filtered to the tenant, not checked one by one).

## end

Root only, decided as `compute:providers:manage` on the provider account. Ends the grant now: `endsAt` becomes the current time (never later than it was), so the hours already in the term stay committed and the rest are released. A grant that has not started yet is `cancelled` instead. Ending a grant that is already `ended` or `cancelled` returns it unchanged. A grant of another account is `NOT_FOUND`.
