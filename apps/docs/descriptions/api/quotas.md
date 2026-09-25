A quota caps how much of one resource a tenant may hold in one pool at the same time, as a `max` and a `used` counter per tenant, pool and resource. A missing row grants 0; `pools.create` and `pools.offer` create the rows, and admissions charge them with `QUOTA_EXCEEDED` when a request does not fit. See [Quotas and usage](/docs/guides/capacity/quotas-and-usage).

## get

Returns the tenant's quota rows, each with `max`, `used` and `available`, optionally only those of one pool.

Rows are ordered by pool, then resource. `available` is `max` minus `used`, never below 0.

## set

Sets one tenant's maximum for one resource in one pool, creating the row if needed, and returns the row with the maximum that took effect.

- It is decided as `compute:quotas:manage` on `compute-fleet`, which resolves only in the root tenant, so only callers in the root tenant get past the tenant pre-check. `tenantId` names the tenant whose quota is set.
- A maximum below the current `used` is raised to `used`. To shrink a quota under live reservations, set it again once they have released.
- `NOT_FOUND` when the pool does not exist.

Emits `quota.updated` with the resource and the requested `max`.
