A quota caps how much of one resource a tenant may hold in one pool at the same time, as a `max` and a `used` counter per tenant, pool and resource. A missing row grants 0; `pools.create` and `pools.offer` create the rows, and admissions charge them with `QUOTA_EXCEEDED` when a request does not fit.

- **Tenant-level rows.** A row whose `poolId` is `*` caps the tenant's total over every pool (`vcpu`, `memoryGiB`, `diskGiB`, `gpu` and other device classes, and `gpu.<gpuModel>` for the GPUs of pools of one model). A missing tenant row limits nothing. Every charge and refund on any of the tenant's pools also moves the tenant row, all or nothing: a refusal there is `QUOTA_EXCEEDED` with `details.poolId: '*'` and `details.scope: 'tenant'`, and no pool row changes.
- **Counted resources.** `instances` counts one per instance (`instances.create` and `instances.attach`, hosted or provider) and `sandboxes` one per sandbox; a sandbox's instance is not counted as an instance, and warm instances count as neither. Unlike scalars, a missing row limits nothing, on a pool or tenant-wide. Each instance records what its admission took and gives exactly that back when it is deleted, so a row set later counts the work admitted from then on.
- **Flavor allowlists.** A row may list `flavors`: an admission that would consume the row (create, attach, resize, sandbox) with another flavor is `QUOTA_EXCEEDED` with `details.reason: 'flavor-not-allowed'`. Reservations and volumes have no flavor and are not restricted. See [Quotas and usage](/docs/guides/capacity/quotas-and-usage).

## get

Returns the tenant's quota rows, each with `max`, `used`, `available` and, when the row lists them, `flavors`; optionally only those of one pool, or with `poolId: '*'` only the tenant-level rows.

Rows are ordered by pool, then resource. `available` is `max` minus `used`, never below 0.

## set

Sets one tenant's maximum for one resource in one pool, or tenant-wide with `poolId: '*'`, creating the row if needed, and returns the row with the maximum that took effect.

- It is decided as `compute:quotas:manage` on `compute-fleet`, which resolves only in the root tenant, so only callers in the root tenant get past the tenant pre-check. `tenantId` names the tenant whose quota is set.
- A maximum below the current `used` is raised to `used`. To shrink a quota under live reservations, set it again once they have released.
- A new tenant-level row of a scalar starts at the tenant's current total of it over its pool rows (`gpu.<model>`: its GPUs on pools of that model); a counted resource starts at 0.
- `flavors` sets the row's flavor allowlist; `null` clears it, and leaving it out keeps it.
- `NOT_FOUND` when the pool does not exist.

Emits `quota.updated` with the resource and the requested `max` (and `flavors` when given); a tenant-level row's event has subject `tenant/<tenantId>` and `scope: 'tenant'`.
