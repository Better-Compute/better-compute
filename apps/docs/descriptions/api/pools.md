A pool groups the nodes of one site under one GPU model, one sharing mode and one policy, and every reservation and quota belongs to exactly one pool. The tenant that creates a pool owns it; other tenants see it only once the owner offers it to them with a quota. Only the owner can offer, unoffer, update or archive a pool; anyone else gets `NOT_FOUND`. See [Pools](/docs/guides/capacity/pools).

## list

Returns the pools the tenant owns or is offered, each with `owned`, `archived` and the tenant's own quota rows.

Archived pools appear only for their owner. After the coarse decision on the tenant, each pool is checked as `compute:pools:read` on the pool, and only the allowed ones are returned.

## get

Returns one pool as the tenant sees it, with `owned`, `archived` and the tenant's own quota rows.

The call is `NOT_FOUND` when the pool is not owned by or offered to the tenant, or is archived and the tenant is not its owner.

## create

Creates a pool on a site the tenant owns, with the owner's quota rows and an empty rollup; returns the pool at version 1.

- It is decided as `compute:pools:create` on the tenant (`compute-tenant`), the alternative its catalog row lists next to `compute-fleet`.
- `sharing` defaults to `exclusive` and `agent` to `bcd` (`none` for `provider` pools). A `provider` pool needs `providerAccountId` and `agent: 'none'`, and other classes refuse `providerAccountId`; both are `INVALID_INPUT`. The account must be one of the pool's own tenant: another tenant's (the root's included) is `NOT_FOUND`, worded as for an account that does not exist. Tenants a pool is offered to are not shown its `providerAccountId` in `get` and `list`.
- `ownerQuota` defaults to `gpu` at 2,147,483,647. Owners of `mig`, `timeslice` or `mps` pools add `gpu.mig` or `gpu.slot` rows themselves, because a missing row grants 0.
- The policy is checked as the nodes will get it (v1.1). Each module's `pool-policy` validator runs, e.g. provision's host units: hugepages, kernel modules, a `kubernetes` join set given all together or not at all, and sharing replicas up to 48. A policy nodes can't take is `INVALID_INPUT`.
- On a platform (non-`custom`) site, a `kubernetes` join set also needs `platformOperated: true`: the cluster's admins get root on the machines, which keep their platform trust.
- With `idempotencyKey`, the pool id is derived from the tenant, the caller and the key. A retry returns the stored pool without a second IAM decision; the same key with a different site, class, sharing mode, agent or provider account is `CONFLICT`.
- `policy.billing: { mode }` sets how provider instances in the pool are billed: `metered` (priced per resource), `platform-fee` (one managed-VM line, as a tenant's own cloud account pays) or `none`. Without it a provider pool owned by a tenant other than the root pays the platform fee and every other pool is metered. The explicit mode outranks that default, so only the platform (a caller of the IAM root tenant) sets it: any other caller gets `ACCESS_DENIED`, and a mode other than those three is `INVALID_INPUT`. The mode is read when an instance's usage interval opens.
- A site the tenant does not own is `NOT_FOUND`.

Emits `pool.created`.

## capacity

Returns one pool's rollup rows, one per resource; the same answer as `capacity.byPool`.

The call is `NOT_FOUND` when the pool is not visible to the tenant.

## offer

Offers a pool the tenant owns to another tenant with a quota, or updates an existing offer and its quota; returns the pool as that tenant sees it.

- `quota` creates or resizes the offered tenant's quota rows. A new maximum below what is in use is raised to the amount in use.
- `includeDescendants` and `priority` (default 0) are stored with the offer.
- `onBudgetExceeded` (`notify`, `stop-new`, `drain` or `suspend`) and `allowedRegions` (1 to 16 region names) are stored with the offer; leaving one out keeps what the offer already has, so re-offering to change the quota does not clear them. See `updateOffer` for what the policies do. Anything else is `INVALID_INPUT`.
- `INVALID_STATE` when the pool is archived, when a `timeslice` or `mps` pool or a pool holding `tenant-owned` nodes is offered to anyone but its owner, or when a `policy.singleTenant` pool is offered with `includeDescendants` or is already offered to another tenant.
- The pool's IAM authz row is written for the offered tenant, with the attributes `gpuModel`, `class`, `sharing`, `region` and `owned`.

Emits `pool.offered`.

## unoffer

Withdraws a pool's offer from a tenant and returns whether an offer was removed.

That tenant's quota rows on the pool drop to what is in use, so live reservations keep their bookings while nothing new fits, and its authz row for the pool is removed. A pool cannot be unoffered from its owner (`INVALID_INPUT`). Calling it again answers `removed: false`. Emits `pool.unoffered` only when an offer was removed.

## updateOffer

Changes the budget policy and regions of an existing offer, or suspends or lifts it, and returns the pool as the offered tenant sees it. It is the owner's call, decided as `compute:pools:share` on the pool like `offer`; a tenant that is only offered the pool gets `NOT_FOUND`.

- **Fields.** `onBudgetExceeded`, `allowedRegions` and `suspended` are each optional, and a request naming none is `INVALID_INPUT`. `NOT_FOUND` when the pool is not offered to `toTenantId`; a pool has no offer to its owner (`INVALID_INPUT`).
- **Budget policies.** When a budget of the tenant is spent, better-iam's alert applies the policy of each offer to that tenant. `notify` only publishes `quota.budget-exceeded`. `stop-new` and `drain` also make admissions check the tenant's budget, and `drain` cancels the tenant's reservations on the pool that have not started. `suspend` stops spend on the pool: it marks the offer suspended, publishes `quota.budget-suspended`, sets the tenant's running instances in the pool to `desiredState: 'stopped'` with the condition `BudgetSuspended` (the reconciler then stops the machines), and refuses the tenant's new work on the pool with `SPEND_LIMIT_REACHED` (`details.reason: 'offer-suspended'`): creating or attaching an instance, creating a network or reservation, and starting an instance. The stop does not depend on host wiring: the `vps.suspension` reconciler stops, every minute, the running instances of every suspended offer (a stop that failed is retried on the next pass), and the host's budget reaction (vps's `sandboxIamReactions`, in `iamReactions`) only makes it immediate. Sandbox warm pools of a suspended offer are emptied and not refilled. Other sandbox-managed instances follow their sandbox and are not stopped directly.
- **Suspension.** `suspended: true` suspends the offer by hand (it refuses new work; it stops nothing). `suspended: false` lifts it and restarts nothing: stopped instances stay stopped until the tenant starts them, and `BudgetSuspended` clears on that start. A new alert that finds the budget still spent suspends the offer again.
- **Regions.** With `allowedRegions`, new work on a pool whose site is in another region is `ACCESS_DENIED` (`details.reason: 'region-not-allowed'`). The site's `iamRegion` is compared, else its `region`; a site with neither match is refused. It applies to instances, reservations, networks and sandboxes created on the pool.

Emits `pool.offer-updated`.

## update

Replaces the policy, the GPU model, or both, of a pool the tenant owns, and returns the pool with its version incremented.

- The new `policy` replaces the old one as a whole, and is checked as on `create`: the `pool-policy` validators, and `platformOperated` for a platform site's Kubernetes join. A request with neither field is `INVALID_INPUT`. Class, site, sharing mode and agent cannot change.
- `policy.billing` is root's, as on `create`: a non-root caller may resend the pool's stored `billing` but not add, change or remove it (`ACCESS_DENIED`).
- Turning `policy.singleTenant` on is `INVALID_STATE` while more than one tenant, or any tenant with `includeDescendants`, holds an offer.
- A new `migLayout` in a `mig` pool never repartitions booked GPUs; each node takes the new layout once its GPUs are idle. A change to `prewarmImages` refreshes the desired state of the site's agents.
- The pool's authz rows are refreshed for the owner and every offered tenant.

Emits `pool.updated`.

## archive

Retires a pool the tenant owns: it removes every offer and stops new work, while live reservations keep their bookings until they end.

Each offered tenant's quota rows drop to what is in use and its authz row for the pool is removed. After archiving, only the owner sees the pool, with `archived: true`. Archiving an archived pool returns it unchanged. Emits `pool.archived` with the list of tenants whose offers were removed.
