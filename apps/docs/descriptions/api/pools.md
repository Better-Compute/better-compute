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
- A site the tenant does not own is `NOT_FOUND`.

Emits `pool.created`.

## capacity

Returns one pool's rollup rows, one per resource; the same answer as `capacity.byPool`.

The call is `NOT_FOUND` when the pool is not visible to the tenant.

## offer

Offers a pool the tenant owns to another tenant with a quota, or updates an existing offer and its quota; returns the pool as that tenant sees it.

- `quota` creates or resizes the offered tenant's quota rows. A new maximum below what is in use is raised to the amount in use.
- `includeDescendants` and `priority` (default 0) are stored with the offer.
- `INVALID_STATE` when the pool is archived, when a `timeslice` or `mps` pool or a pool holding `tenant-owned` nodes is offered to anyone but its owner, or when a `policy.singleTenant` pool is offered with `includeDescendants` or is already offered to another tenant.
- The pool's IAM authz row is written for the offered tenant, with the attributes `gpuModel`, `class`, `sharing`, `region` and `owned`.

Emits `pool.offered`.

## unoffer

Withdraws a pool's offer from a tenant and returns whether an offer was removed.

That tenant's quota rows on the pool drop to what is in use, so live reservations keep their bookings while nothing new fits, and its authz row for the pool is removed. A pool cannot be unoffered from its owner (`INVALID_INPUT`). Calling it again answers `removed: false`. Emits `pool.unoffered` only when an offer was removed.

## update

Replaces the policy, the GPU model, or both, of a pool the tenant owns, and returns the pool with its version incremented.

- The new `policy` replaces the old one as a whole, and is checked as on `create`: the `pool-policy` validators, and `platformOperated` for a platform site's Kubernetes join. A request with neither field is `INVALID_INPUT`. Class, site, sharing mode and agent cannot change.
- Turning `policy.singleTenant` on is `INVALID_STATE` while more than one tenant, or any tenant with `includeDescendants`, holds an offer.
- A new `migLayout` in a `mig` pool never repartitions booked GPUs; each node takes the new layout once its GPUs are idle. A change to `prewarmImages` refreshes the desired state of the site's agents.
- The pool's authz rows are refreshed for the owner and every offered tenant.

Emits `pool.updated`.

## archive

Retires a pool the tenant owns: it removes every offer and stops new work, while live reservations keep their bookings until they end.

Each offered tenant's quota rows drop to what is in use and its authz row for the pool is removed. After archiving, only the owner sees the pool, with `archived: true`. Archiving an archived pool returns it unchanged. Emits `pool.archived` with the list of tenants whose offers were removed.

## bindMachines

Binds machines that the `vps.discovery` worker saw in a `provider` pool's account to the pool; returns `bound`, the machines bound to the pool now, and `skipped`, each with `externalId` and `reason`. Tenants the pool is offered to can then list them (`machines`) and attach them (`instances.attach`).

- **Input.** `externalIds` lists 1 to 100 machine ids as `providerAccounts.machines` shows them; duplicates count once.
- **Skips.** `not-found`: discovery has not seen the machine in the pool's account (run `providerAccounts.discover`). `bound-elsewhere`: it is bound to another pool; unbind it there first. `gone`: discovery marked it gone. `deleting`: the provider is deleting it. `held`: an instance of another pool holds it (one of this pool may). `other-region`: for Compute Engine accounts (`gcp`), the machine's region (or its zone's) is not the region of the pool's site; other providers' sites name regions freely and are not compared.
- **Idempotency.** The machine rows are locked while the call runs. A machine already bound to the pool is listed in `bound` again and changes nothing. Discovery passes, detaching and deleting never clear a binding, so a machine whose instance goes returns to its pool. A binding to a pool archived since counts as none: the machine can be bound and attached elsewhere.
- **IAM.** Decided as `compute:pools:manage` on the pool. Only the platform (root callers) and the tenant that owns the pool's provider account bind; a tenant the pool is offered to is `ACCESS_DENIED`.
- **Errors.** `NOT_FOUND` for a pool the tenant neither owns nor is offered, `INVALID_INPUT` for one that is not a `provider` pool, `INVALID_STATE` for a provider pool without an account.
- **Events.** `pool.machines.bound` with `poolId`, `accountId` and the `externalIds` this call bound (none is published when it bound nothing new).

## unbindMachines

Takes machines out of the pool; returns `unbound` and `skipped`, with the input of `bindMachines`. An instance that holds an unbound machine keeps it.

- A machine discovery has not seen is skipped as `not-found`, one bound to another pool as `bound-elsewhere`. A machine that is not bound is listed as unbound and changes nothing.
- Decided as `compute:pools:manage` on the pool; only the platform and the account's tenant unbind (`ACCESS_DENIED` otherwise). Publishes `pool.machines.unbound` with the `externalIds` this call unbound.

## machines

Lists the machines bound to the pool that the provider still reports, ordered by zone and machine id; returns `items`, a `cursor` when more remain, and `discoveredAt`, the time of the account's last successful discovery pass.

- **Input.** `filter` is `free` (the default: no instance holds the machine), `attached` (one does) or `all`. `limit` is 1 to 500 (default 100).
- **Output.** Each machine is shown as `providerAccounts.machines` shows it, with `poolId`. A machine held by an instance of another tenant is listed without that instance's `instanceId` and `tenantId`, except to the platform. Tenants the pool is offered to are not shown `accountId`, as `get` does not show them `providerAccountId`.
- **IAM.** Decided as `compute:pools:read` on the pool: its owner and the tenants it is offered to read it. Any other tenant gets `NOT_FOUND`.
