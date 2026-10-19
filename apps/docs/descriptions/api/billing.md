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

## proposePrices

Reads the list prices of one of the platform's provider accounts, adds a margin and returns prices root can publish. It sets nothing: `prices` is the same before and after, and root publishes the proposals it wants through `setPrices`. Decided as `compute:billing:read` on `compute-fleet`. It needs no billing member on the IAM port, only the provider.

- **Input.** `accountId` is a provider account of the root tenant whose provider lists prices (Compute Engine reads the Cloud Billing Catalog): another tenant's account, or one that does not exist, is `NOT_FOUND`, and a provider without prices is `UNSUPPORTED`. `marginPct` (0 to 1000) is the percentage added. `region` limits the prices read to one region; without it the cheapest basis across the regions the provider lists is used. `effectiveFrom` (`YYYY-MM`) is the period root means to publish the proposals from; it is checked and left to `setPrices`.
- **Result.** `{ proposals, unpriced }`. A proposal is `{ meter, spec, basis }`: `spec` is `per-unit` at `round(unitPriceMicros x (1 + marginPct / 100))` micros, and `basis` lists the provider prices (`sku`, `unitPriceMicros`) it came from. A meter the provider's prices cover is proposed; the provider meters that remain are `unpriced`.
- **`vm.vcpu.hours` and `vm.memory.gib.hours`** take the cheapest general-purpose machine family (E2, N1, N2, N2D, N4, T2D, C3, C3D, C4, by one vCPU and four GiB of on-demand prices) in the region. Per-family accuracy is what flavor meters are for.
- **GPU meters** (`vm.gpu.<model>.hours` and the `.spot` meters) take the cheapest GPU SKU of that model, on demand or Spot. **Ancillary meters** (`ip.public.hours`, `disk.<type>.gib.hours`) take the matching SKU; monthly storage prices become GiB-hours at 730 hours a month.
- **Flavor meters** (`flavor.<name>.hours`) are composed for the flavors of the account's pools that carry them: the flavor's vCPUs, memory and GPUs at the prices of its offer's machine family in the offer's region (an offer id spelled `zone/machine-type`). Flavors that share a meter must share a shape, else the meter is `unpriced`.
- **Left `unpriced`:** instance, reserved, reservation-grant and managed-VM meters, network and snapshot meters, GPU models the provider has no price for, and any meter whose price is in another currency than the deployment's (`vps({ billing: { currency } })`, default `USD`). Hosted, node and sandbox meters are the platform's own and are not listed.
