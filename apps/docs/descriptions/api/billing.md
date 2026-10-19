The platform's billing setup for compute: the meters and prices root keeps on the IAM root tenant, so root can bill its sub-tenants for what they use. Every method is decided as a `compute:billing:*` action on `compute-fleet`, which resolves only in the root tenant, so a tenant administrator is turned away before any IAM decision, however broad the tenant's own grants. A root member needs `compute:billing:read` or `compute:billing:manage` on `compute-fleet`.

These methods call the IAM root tenant's billing API as a root service account. The IAM port must be configured with one: `bridge.embedded(iam, { rootTenantId, serviceCredential })` with `iam:billing:manage` and `iam:billing:read` on the root tenant (a remote bridge takes a `serviceToken`). Without it every method answers `UNSUPPORTED` and names that fix. Amounts are micros of the deployment's currency (1,000,000 micros = 1 unit).

The catalog these methods work from is the same one `better-compute iam setup --meters` and the IAM bridge sync: hosted and node GPU, CPU, memory and volume hours, provider VM meters, reservation-grant and managed-VM meters, the ancillary network, address, disk and snapshot meters, and the `flavor.*` meters root sets on flavors. `vps({ billing: { gpuModels, gpuFamilies } })` names the GPU models whose VM meters exist; name the same models as the bridge so the two agree.

## meters

Returns the catalog compute defines, `catalog`, and `missing`: the keys of the catalog the IAM root tenant has no meter for yet. Usage recorded on a missing meter is refused by IAM; `syncMeters` creates the missing ones.

An archived meter still exists on the root tenant, so it is not listed as missing. `UNSUPPORTED` when the IAM port cannot list meters.

## syncMeters

Creates the catalog's meters that the root tenant lacks, and returns `{ created, existing }` (meter keys). A meter that exists is left as it is, whatever its name, unit or pricing mode; calling it again creates nothing.

Decided as `compute:billing:manage` on `compute-fleet`. The IAM call happens outside any compute transaction.

## prices

Returns the rate-card price entries of one meter, or of every rate-card meter, newest first, as `{ meter, targetTenantId, effectiveFrom, spec }`. The list price is the entry whose `targetTenantId` is the root tenant; a negotiated price names the tenant (and its subtree) it applies to. `targetTenantId` filters.

`meter` and `targetTenantId` are optional. `reported` meters carry their cost on each usage event and have no prices.

## setPrices

Sets up to 100 prices on the root tenant's rate card and returns `{ applied, failed }`.

- **Each price** is `{ meter, targetTenantId?, effectiveFrom, spec }`. Without `targetTenantId` it is the list price; with one it is a negotiated price for that tenant's subtree. `effectiveFrom` is a billing period (`YYYY-MM`), and `spec` is a better-iam price (`per-unit`, `graduated`, `volume` or `package`) in micros.
- **Meters.** Every `meter` must be in the catalog (`meters`) or be a flavor meter; one that is not refuses the whole request with `INVALID_INPUT` before any price is applied.
- **Tenants.** `targetTenantId` is not checked here: better-iam validates it, and a tenant it refuses lands in `failed`.
- **Partial failure.** A price better-iam refuses does not stop the others: `applied` lists the prices that took effect, in request order, and `failed` lists `{ index, meter, targetTenantId?, code, message }` for the rest. Setting a price is idempotent, so a retry of the same request is safe.

Decided as `compute:billing:manage` on `compute-fleet`.

## margins

Returns the platform's margin over a range: revenue (what better-iam billed) minus provider cost (what the providers billed the platform, D12), grouped by `tenant`, `pool`, `account` (provider account) or `meter`, as `{ rows, unattributedCostMicros, currency, from, to }`.

- **Input.** `from` and `to` are epoch milliseconds (`to` after `from`, at most 400 days apart); `groupBy` is required.
- **Revenue** comes from the IAM port's spend report on the root tenant (`IamPort.spend`, by tenant, by meter, or by the `pool` tag). better-iam sums whole billing periods, so the answer covers every period the range touches, and costs are summed over exactly that range: `from` and `to` in the answer are the range both cover. Without `spend`, `revenueMicros`, `marginMicros` and `marginPct` are `null` and costs cover the query's range. better-iam has no provider-account dimension, so `groupBy: 'account'` always has `null` revenue.
- **Cost** is the sum of cost plus credits of the `vps.costs` worker's rows (`provider_costs`) of the platform's own provider accounts (the root tenant's; a tenant's own account is that tenant's cost, not the platform's) whose usage started in the range, in the deployment currency (`vps({ costs: { currency } })`, default `USD`; rows in another currency are excluded). Rows attributed to no tenant are not in `rows` but in `unattributedCostMicros`. By pool, a row counts toward its instance's pool; by meter, toward the reported meter it was passed through on. Attributed cost with no such pool or meter is grouped under the key `(none)`, whose revenue is `null`. Provider compute cost has no meter dimension (a provider bills a VM's cores and memory, not compute's meters), so with `groupBy: 'meter'` all compute cost is under `(none)` while its revenue is under the `vm.*` meters: read the meter view for pass-through margins, and the tenant or pool view for compute. Pass-through usage carries the instance's `pool` tag, so revenue by pool includes it.
- **Rows.** One per key that has revenue or cost, sorted by key with `(none)` last: `{ key, revenueMicros, costMicros, marginMicros, marginPct }`. `marginPct` is the margin over revenue in percent (2 decimals), `null` when revenue is not positive.

Decided as `compute:billing:read` on `compute-fleet`, so a tenant cannot read it. The IAM call happens outside any compute transaction.

## Leak detection

Not a method: at the end of every `vps.costs` pass over a platform provider account, each instance's provider-billed compute is compared with what compute metered for it, per UTC day. The provider hours of an instance-day are the **distinct hour slots** the provider billed compute for it (regular rows of the provider's compute SKUs attributed to the instance, quantity above 0), not the sum of the rows' quantities: a provider bills a VM's cores and memory as separate rows in vCPU-hours and GiB-hours, so summed quantities are no count of hours. The metered hours are how many of those slots a `running` usage interval of the instance overlaps. When the provider hours exceed the metered ones by more than `vps({ costs: { leakToleranceHours } })` (default 1), `billing.leak` is published, at most once per instance and day. Instances with `billing: none` and tenants' own accounts are not checked.
