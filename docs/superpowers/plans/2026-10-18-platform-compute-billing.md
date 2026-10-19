# Platform Compute Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the root (platform) tenant bill its sub-tenants for the compute it issues to them. That covers GCP VMs
that root creates or attaches for a tenant, reservation capacity it commits to a tenant, tenant networks, disks and
public IPs, plus provider pass-through costs such as egress. Root controls every price, discount and commitment, can
see its margin against what the provider charged, and gets budget enforcement that actually stops spend.

**Architecture:** The existing split stays as it is. better-compute **meters** usage and better-iam **rates and
invoices** it. Each organization directly under root is a billing account, and better-iam's statements, credits,
terms and budgets are the ledger. This plan does five things:
1. It generalizes better-compute's metering beyond node allocations. Usage windows now come from typed *sources*:
   allocations, provider instances (compute, public-IP and disk lines), reservation grants, networks, snapshots and
   provider costs.
2. It meters provider compute from lifecycle intervals written in the same transactions as state changes.
3. It adds reservation grants: root commits slots of a provider reservation to a tenant for a term.
4. It ingests provider costs from the GCP billing export, for pass-through charges, margins and leak detection.
5. It extends the IAM port so compute can manage meters, prices and quotes on root's behalf, and finishes budget
   enforcement.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), pnpm workspace, vitest on PGlite plus an embedded better-iam
(`>=0.2.0 <0.4.0`; billing is identical across that range), Compute Engine REST v1, BigQuery REST v2 and Cloud Billing
Catalog API v1. Everything uses plain `fetch` and adds no new npm dependencies.

**Spec:** No separate spec file. The requirements are the user's request of 2026-10-18 ("improve the billing
functionality of these new compute features so the root tenant can bill sub tenants for compute"), restated in
Requirements below, plus the codebase findings in Current state. Related designs that this plan treats as context,
not scope:
- `PLAN.md` §12.7 (billing and usage), D14, D21 and I8.
- legionedge `docs/redesign/10-billing.md`, `11-compute.md` §5.7, `12-gcp-hosted-compute.md` §7, and
  `docs/plans/2026-10-18-compute-vm-fixes.md`.

---

## Requirements

1. **B1 (meter all issued compute).** Every compute resource root issues to a tenant produces usage attributed to
   that tenant:
   - provider VMs that root creates for the tenant;
   - provider VMs that root attaches to the tenant;
   - VMs admitted against a reservation;
   - tenant networks, public IPs and disks;
   - hosted instances, node reservations, sandboxes and volumes, which are metered today.
2. **B2 (root owns prices).** Root defines the meters and list prices, sets negotiated per-tenant prices and
   discounts, and can price either by resource (vCPU, GiB, GPU) or by whole machine shape. Compute never invents a
   price.
3. **B3 (commitments).** Root can commit reservation capacity to a tenant for a term. The tenant pays for the
   committed slots whether or not it uses them and gets priority on them. Usage inside a commitment is never also
   billed as on-demand.
4. **B4 (pass-through and cost).** Root can bill provider costs it cannot meter itself, such as egress and
   snapshots, at cost times a multiplier. It can also see its cost, revenue and margin per tenant, pool and account,
   and is alerted when a provider bills for something better-compute did not meter (leakage).
5. **B5 (price discovery).** Root can generate proposed prices from the provider's list prices plus a margin, and
   publish them explicitly. Tenants see an hourly estimate before they create something.
6. **B6 (enforcement).** Budgets stop new spend on every path that creates billable resources. Root can configure a
   per-offer policy (notify, stop new, drain, suspend) through the API rather than SQL.
7. **B7 (visibility and corrections).** Root can see usage across all tenants, see and retry usage that failed to
   record, and void usage that was metered wrongly before it is invoiced. Tenants see their own provider usage.
8. **B8 (no breakage).** Existing hosted, node and sandbox metering keeps its meters, idempotency keys and amounts.
   Tenant-owned bring-your-own (BYO) provider accounts are not charged for compute the tenant already pays its
   provider for.

## Current state (verified 2026-10-18 at `origin/main` a5bc5ea5)

**Metering.**
- The only billable sources are rows in `allocations`.
- `usage_windows.allocation_id` is `NOT NULL REFERENCES allocations`
  (`postgres/src/migrations/0018_partitioned_history.ts:110-129`).
- `capacity.usage` meters reservations (`capacity/src/usage.ts:293`). `vps.usage` meters hosted instances and
  volumes (`vps/src/usage.ts:39`, `vps/src/volumes.ts:844`). `iam.usage` flushes the windows hourly into
  `IamPort.recordUsage` (`iam/src/worker.ts:371`).
- Provider VMs (created or attached), reservation-admitted VMs, `provider_reservations`, networks, disks, IPs and
  snapshots produce **no usage**.
- The docs say this outright (`billing-and-usage.mdx:55`): "Provider-backed instances … are billed by their provider."

**Meters and prices.**
- `computeMeters` (`iam/src/setup.ts:29-40`) does not create `vps.volume.gib.hours`, the `.spot` meters or
  `gpu.other.hours`, so windows for those meters are dead-lettered.
- No code calls `setPrice`.
- GCP offers have no `pricePerHour`; only Hetzner sets one.
- Flavors have no billing fields.

**Budgets.**
- `budgetAdmissionCheck` (`capacity/src/reservations.ts:971`) covers `reservations.create/extend`,
  `instances.create` and `sandboxes.*`. It does not cover `instances.attach`, `networks.*` or `bindReservation`.
- `pool_offers.on_budget_exceeded` and `allowed_regions` have no API writer.
- `drain` cancels only unstarted reservations.

**Visibility.**
- `usage.list/export` read one tenant at a time.
- `EventSink` (host-level) sees all tenants' events. Webhooks are per tenant.

**better-iam** already provides everything needed:
- billing accounts per organization under root;
- `per-unit | graduated | volume | package` prices with `includedQuantity`, minimum and maximum;
- negotiated `setPrice({targetTenantId})`;
- `reported` meters that carry `cost`;
- `setTerms` (discount, minimum commitment, tax), credits, invoice items and credit notes;
- budgets with `check`, plus `billing:budget-alert` events.

Its constraints:
- 100 meters per tenant.
- Prices do not vary by tag.
- Calendar-month periods only.
- One currency per deployment.
- Usage is refused once a month is closed (`BILLING_PERIOD_CLOSED`).
- High-cardinality tags multiply its daily rollups.
- Root-only billing operations (credits, terms, invoice items) need a root admin user session with MFA, so service
  accounts cannot call them.

**legionedge conflict.** legionedge's `docs/plans/2026-10-18-compute-vm-fixes.md` decided to "meter in LegionEdge"
from lifecycle events, with its own `compute_rates` and `compute_vm_charges`. It did so because upstream does not
meter provider VMs. This plan meters them upstream instead (D1). The integration notes at the end say what legionedge
keeps: its price book UI, Stripe and tax, and its cost ledger UI on top of this data.

## Design decisions

| # | Decision | Why |
|---|---|---|
| D1 | Upstream better-compute meters every provider resource. better-iam stays the only place prices, statements and credits live. legionedge drops its own VM metering and builds UI on these APIs. | One source of truth for usage, close to the state transitions. It also keeps PLAN G7 ("compute never prices anything itself"). Two metering systems would double-bill or drift. |
| D2 | `usage_windows` gains `source_kind` (`allocation`, `instance`, `grant`, `network`, `snapshot`, `cost`) + `source_id`, and `allocation_id` becomes nullable. A provider instance's compute, public-IP and disk lines all come from its `instance` source, as distinct meters. Allocation windows keep their keys `cmp:<allocId>:<windowStartMs>[:<meter>]`. New sources use `cmp:<kind>:<id>:<windowStartMs>[:<meter>]`. | One flush path (`iam.usage`), with its dead letters and outcomes, serves every source. Existing idempotency keys are untouched (B8). |
| D3 | Provider instance usage comes from `instance_usage_intervals`, written in the same transaction as the lifecycle state change. A non-overlap `EXCLUDE` constraint enforces one open interval per instance. Phases are `running` and `stopped`. The interval starts and ends when better-compute *observes* the state, either through the reconciler's poll (≤ 60 s while steady) or through the API action that changed it. | Event-sourced intervals are exact and restart-safe, and the database refuses overlaps. Polling `instances.state` every 5 min would lose short runs and double-count across restarts. |
| D4 | Provider VMs use their own meters, separate from hosted ones: `vm.vcpu.hours`, `vm.memory.gib.hours`, `vm.gpu.<model>[.spot].hours` and `vm.instance.hours` (one per running VM). Root can instead set `billing.meter` on a flavor (for example `flavor.a3-highgpu-8g.us-central1.hours`), and that replaces the composed lines for instances of that flavor. | better-iam prices cannot vary by tag, so a distinct price needs a distinct meter. Composed meters stay within the 100-meter limit. Per-flavor meters cover whole-shape and region-specific prices. |
| D5 | A provider pool's billing mode lives in `PoolPolicy.billing?: { mode: 'metered' \| 'platform-fee' \| 'none' }`. The default is `metered` for root-owned pools, `platform-fee` for tenant-owned pools on the tenant's own account, and `metered` for hosted pools. `platform-fee` records only `vm.managed.hours` per running VM. | A BYO tenant already pays its provider (B8, legionedge Q-B4). Root can still charge a management fee. |
| D6 | Attach takes `billing?: 'metered' \| 'none'`, which only root may set to `none`. It defaults to the pool's mode. Metering starts at the first observed `running` after `attached_at`. | Root decides whether a lent VM is billed. The tenant never pays for time before the VM was attached. |
| D7 | Reservation grants: `reservationGrants.create` (root) commits `slots` of one `provider_reservations` row to a tenant for `[startsAt, endsAt)`.<br>• The tenant is billed `vm.grant.slot.hours` for every committed slot every hour of the term, used or not.<br>• Instances the tenant runs inside its grant are metered on the informational `vm.grant.usage.hours` meter and record **no** compute meters, so there is no double billing.<br>• Admission serves the grantee from its granted slots first.<br>• Non-grantees can only use `total − Σ active grants − used outside grants`.<br>• The database refuses `Σ active grants > total` under the reservation row lock. | This is the B3 commitment model. The reserved slots are root's real cost whether used or not, so the tenant that holds the commitment carries it. Grant slot-hours are also the natural true-up unit. |
| D8 | An instance admitted against a reservation outside any grant is metered on `vm.reserved.*` variants of D4's meters. | Root can price reservation-backed capacity, which is guaranteed availability, separately from on-demand. |
| D9 | Ancillary meters:<br>• `network.vpc.hours`: per network that has been provisioned and is not deleted.<br>• `ip.public.hours`: per running provider instance that has a public address.<br>• `disk.<type>.gib.hours`: per boot or data disk on a provider instance, in both `running` and `stopped`.<br>• `snapshot.gib.hours`: per sandbox snapshot.<br>Firewall rules and subnets are free. | They carry real provider cost. Disks bill while a VM is stopped (GCE does too). Firewall rules and subnets have no list price. |
| D10 | Provider cost ingestion is a new optional `ProviderImpl.costs?(window, ctx)` capability, which GCP implements by reading the BigQuery detailed billing export. Rows land in `provider_costs` and are attributed in this order: `better-compute-instance` label, then `better-compute-tenant` label, then the account's tenant, then `unattributed`. They are deduplicated by a source row hash. | Costs are the basis for B4. The labels already exist on GCP resources. BigQuery rows arrive late and can be re-exported, so the hash makes ingestion idempotent. |
| D11 | Pass-through charges: a provider account's `billing.passThrough` rules map SKU patterns to `reported` meters with a multiplier. Each attributed cost row becomes one usage event `{ meter, quantity: usage amount, cost: costMicros × multiplier / 1e6 }` keyed `costx:<accountId>:<rowHash>`. Compute SKUs that D4 already meters are refused as pass-through targets. | better-iam already supports `reported` meters. Refusing compute SKUs means nothing is billed twice. |
| D12 | Margins: the root-only `billing.margins` method returns revenue (better-iam spend through a new optional `IamPort.spend?`) minus cost (`provider_costs`), grouped by tenant, pool, account or meter. The `vps.costs` worker raises `billing.leak` when a cost row attributed to an instance has more than `leakToleranceHours` (default 1) more provider hours than metered running hours in the same day. It raises `billing.unattributed` for cost rows with no tenant. | B4 visibility. Leak detection catches metering bugs before an invoice goes out. |
| D13 | Prices are managed through compute but stored in better-iam. New optional `IamPort` members: `ensureMeters?`, `setPrice?`, `listPrices?`, `quote?`, `spend?`. The embedded bridge implements them with `iam.api.billing` / `iam.billing`; the remote bridge implements them over HTTP. The `billing` API group exposes them to root (`compute:billing:manage` on `fleet`, which only root can hold). | One place for root to manage compute prices. `setPrice` is not root-only in better-iam, so a service account can call it, and decisions stay in compute's catalog. |
| D14 | Price proposals: a new optional `ProviderImpl.listPrices?(query, ctx)`, which GCP implements against the Cloud Billing Catalog API (service `6F81-5844-456A`, Compute Engine). `billing.proposePrices` turns provider list prices into proposed `PriceSpec`s at `cost × (1 + marginPct/100)` per D4 meter and per flavor. Proposals are returned, never applied, and root publishes them with `billing.setPrices`. | B5. Root keeps the final say, matching legionedge 10-billing §3. |
| D15 | Estimates: `flavors.list` and `instances.create` with `dryRun: true` return `estimate?: { perHourMicros, currency, lines }` computed with `IamPort.quote?` for the caller's tenant. Without `quote` the field is absent. | B5 for tenants, priced with the tenant's negotiated price. |
| D16 | Enforcement:<br>• `pools.offer` accepts `onBudgetExceeded` and `allowedRegions`.<br>• New `pools.updateOffer`.<br>• `budgetAdmissionCheck` also runs on `instances.attach` (billed attaches only) and on `networks.create`.<br>• New policy `suspend`: refuses admission, stops (desired `stopped`) the tenant's running provider instances in that offer's pool, and marks the offer `suspended_at`. `pools.updateOffer({ suspended: false })` lifts it but does not restart anything.<br>• Grants are root contracts and are not budget-checked. | Closes the B6 gaps. `suspend` actually stops spend on provider VMs, which `drain` does not. |
| D17 | Visibility and corrections:<br>• `usage.platform` (root): usage across tenants grouped by tenant, pool, meter or source.<br>• `usage.deadLetters` and `usage.retry` (root): see and retry failed windows after meters are fixed.<br>• `usage.void` (root): marks unflushed windows `voided` with a reason. Flushed usage is corrected in better-iam by credit note (documented; compute does not call root-only IAM operations). | B7. Corrections never fake better-iam history. |
| D18 | Period close: every metering reconciler meters only windows that have ended. `iam.usage` flushes hourly. Hosts must schedule better-iam `closePeriod` at least `closeGraceHours` (default 6, documented) after month end, so the last windows land. A window refused with `BILLING_PERIOD_CLOSED` is dead-lettered with reason `period-closed` and listed for a root invoice item. | Months close cleanly without losing the last hour. |
| D19 | Low-cardinality tags only: `region`, `pool`, `project`, `provider`, `gpuModel`, `flavor`, `source` (never instance, network or grant ids). Instance-level detail lives in `usage_windows` (with `source_id`) and in `usage.platform`, not in better-iam tags. | Respects better-iam's rollup cost (D19 matches PLAN §12.7's "per-resource ids never in tags"). |

## Phases

| Phase | Delivers | Tasks | Depends on |
|---|---|---|---|
| 1 Foundation | IAM pricing port, `billing` API, complete meter catalog, generalized usage sources | 1–4 | — |
| 2 Provider VMs | lifecycle intervals, metering of provider-created and attached VMs, pool billing modes | 5–8 | 1 |
| 3 Commitments | reserved-rate meters, reservation grants, grant admission and billing | 9–11 | 2 |
| 4 Ancillaries | networks, public IPs, disks, snapshots | 12–13 | 2 |
| 5 Cost and margin | provider cost ingestion (GCP BigQuery export), pass-through, margins, leak detection | 14–17 | 1, 2 |
| 6 Price discovery | provider list prices (GCP Catalog), price proposals, tenant estimates | 18–19 | 1 |
| 7 Enforcement | offer budget policies over the API, `suspend`, budget checks on attach/networks | 20–21 | 2 |
| 8 Visibility and corrections | platform usage, dead letters, retry, void | 22–23 | 1 |
| 9 Proof and docs | end-to-end month-close statement test, docs, legionedge notes, gates | 24–25 | all |

Phases 3–8 depend only on the phases listed, so after Phase 2, Phases 3+4, 5, 6, 7 and 8 can run in parallel.

## Global Constraints

- Node ≥ 22.12, ESM only. Every package imports its own `.js` paths.
- **Core is frozen.** `@better-compute/core` changes only by **additive** optional members. Never change an existing
  member's type.
- **better-iam:** use only APIs present in `>=0.2.0 <0.4.0`. No upstream better-iam change is required by this plan.
- **Migrations:**
  - Core migrations are `core/00NN_<slug>` in `packages/postgres/src/migrations/`; the next free number at
    execution time, currently 0029.
  - vps migrations are `vps/00NN_<slug>`; the next free number at execution time, currently 0027. The 0.2.1 hotfix
    (branch `release-0.2.1`) may take some numbers first, so rebase before numbering.
  - Migrations are additive, and they must run on a populated, partitioned `usage_windows` without rewriting
    partitions (use `ADD COLUMN … DEFAULT` with a constant, `DROP NOT NULL`, and per-partition indexes via the
    parent).
- **SQL:** `compute_now()`, never `now()` (`scripts/check-sql-now.mjs`).
- **Provider calls:** never inside a transaction. A reconciler run stays under `claimTtlMs` (60 s).
- **Money:**
  - Compute never computes a billed amount, except `reported` pass-through cost (D11), which is in micros
    (integer).
  - Prices are better-iam `PriceSpec` in micros.
  - Currency is the better-iam deployment currency. A provider cost in another currency is stored as received and
    excluded from pass-through and margins, with condition `CurrencyMismatch`.
- **Meter keys** match `/^[a-z][a-z0-9_.-]{0,63}$/`. Tags: at most 10, from D19's list only.
- **Usage events:** quantity ≥ 0. `occurredAt` is the window start. Windows are aligned to the hour.
- **Idempotency keys** are unchanged for allocation windows (B8). New sources use D2's form.
- **API surface:** every new method gets an `apiSurface` row (phase `'v1.0'`) and a description in
  `apps/docs/descriptions/api/<group>.md`. Root-only methods decide on `fleet`.
- **Events:** new families get a row in `packages/events/src/catalog.ts`.
- **Commits:** through a private index, per `.claude/coordination.md`, with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Double billing inside a commitment.** A tenant runs an instance inside its reservation grant. Expected: the
   grant's `vm.grant.slot.hours` plus the informational `vm.grant.usage.hours`, and **no** `vm.*` compute meters.
   When usage exceeds the grant, the extra instances fall back to `vm.reserved.*` (if the reservation has free
   slots) or are refused. *Test: Task 11, `instances inside a grant record no compute meters`.*
2. **Intervals at the edges.** Covers state flaps (running → lost → recovered), a reconciler restart mid-interval, a
   stop requested while GCP still reports running, and attach → detach → re-attach of the same VM to another
   tenant. Expected: no overlap (the database refuses), no gap while the VM really runs, billing ends at the
   observed stop, and each attachment bills its own tenant. *Test: Task 6, `interval edges`.*
3. **Month boundary and closed periods.** An interval spans 23:30 to 00:30 across a month end, and better-iam closes
   the old month before the 23:00 window flushes. Expected: windows split at the hour (hence at the month). The late
   window is dead-lettered as `period-closed`, listed by `usage.deadLetters`, and not retried in a loop. *Test:
   Task 4, `month split`, and Task 23, `period-closed dead letter`.*
4. **Late, duplicate and corrected cost rows.** BigQuery re-exports a day with corrected cost, and a credit row
   arrives as a negative cost. Expected: idempotent by row hash, corrections replace the stored row, and no second
   pass-through event (the correction is reported as `billing.cost-corrected` for a root credit note). *Test: Task
   15, `re-exported rows are idempotent`.*
5. **BYO accounts never billed for compute.** A tenant runs VMs on its own GCP account. Expected: only
   `vm.managed.hours` (platform-fee) or nothing (`none`), never `vm.*` compute meters, and no pass-through from its
   costs. *Test: Task 8, `BYO pools bill a platform fee only`.*

---

## File structure

**`packages/core/src/`** (additive only)

| File | Change |
|---|---|
| `iam.ts` | `IamPort.ensureMeters?`, `setPrice?`, `listPrices?`, `quote?`, `spend?`, plus types `MeterSpec`, `PriceSpecInput`, `PriceView`, `QuoteLine`, `SpendQuery`, `SpendRow`. |
| `extension.ts` | `ProviderImpl.costs?`, `listPrices?`, plus types `ProviderCostRecord`, `ProviderListPrice`. |
| `domain.ts` | `PoolPolicy.billing?`, `Offering.allowedRegions?`/`suspendedAt?`, `Flavor.billing?`, `Instance.billing?`. |
| `catalog.ts` | Rows for the `billing`, `reservationGrants` and new `usage` methods, `pools.updateOffer`, and actions `billing:read`/`billing:manage`. |

**`packages/postgres/src/migrations/`:** `00NN_usage_sources.ts` (D2).

**`packages/capacity/src/`**

| File | Change |
|---|---|
| `usage.ts` | Generalize `meterAllocation` into `meterSource` (D2). Existing callers are unchanged. |
| `module.ts` | `pools.offer` fields, `pools.updateOffer`, `suspend` policy. |
| `iam-reactions.ts` | `suspend` handling. |

**`packages/iam/src/`**

| File | Change |
|---|---|
| `setup.ts` | `computeMeters` becomes the full catalog (`meterCatalog()`). |
| `bridge.ts`, `embedded.ts`, `remote.ts` | Implement the new optional port members. |
| `worker.ts` | Flush windows of every source; `period-closed` dead letters. |

**`packages/vps/src/`** (new files own their migrations, as `bootstraps.ts` does)

| File | Change |
|---|---|
| `billing.ts` | New. `meterLinesFor(shape, policy)` (D4/D5/D8), `billingModeOf(pool, account)`. |
| `instance-usage.ts` | New. `vps/00NN_instance_usage` (intervals), `openInterval`/`closeInterval`, the `vps.provider-usage` reconciler. |
| `reservation-grants.ts` | New. `vps/00NN_reservation_grants`, the `reservationGrants.*` API, grant-aware admission, grant metering. |
| `ancillary-usage.ts` | New. Network and snapshot metering (D9). Public-IP and disk lines live in `billing.ts`. |
| `costs.ts` | New. `vps/00NN_provider_costs`, the `vps.costs` worker, attribution, pass-through, leak detection. |
| `pricing.ts` | New. The `billing.*` API (meters, prices, proposals, margins) and estimates. |
| `lifecycle.ts`, `attach.ts`, `instances.ts`, `provider-reservations.ts`, `networks.ts`, `flavors.ts`, `module.ts` | Hooks, as each task says. |

**`packages/provider-gcp/src/`**

| File | Change |
|---|---|
| `costs.ts` | New. BigQuery export reader. |
| `prices.ts` | New. Catalog API reader. |
| `config.ts`, `provider.ts` | Wiring. |

**`packages/server/src/api/usage.ts`:** `usage.platform`, `usage.deadLetters`, `usage.retry`, `usage.void`.

**`packages/events/src/catalog.ts`:** families `billing.*` and `reservation-grant.*`.

**Tests (root `tests/`)**

| File | Covers |
|---|---|
| `billing-port.test.ts` | Phase 1 |
| `usage-sources.test.ts` | Phase 1 |
| `vps-provider-usage.test.ts` | Phase 2 |
| `vps-reservation-grants.test.ts` | Phase 3 |
| `vps-ancillary-usage.test.ts` | Phase 4 |
| `vps-costs.test.ts` | Phase 5 |
| `provider-gcp-costs.test.ts` | Phase 5 |
| `vps-pricing.test.ts` | Phase 6 |
| `provider-gcp-prices.test.ts` | Phase 6 |
| `capacity-offer-budgets.test.ts` | Phase 7 |
| `usage-platform.test.ts` | Phase 8 |
| `billing-month-close.test.ts` | Phase 9 end-to-end, embedded better-iam |
| `support/gce-emulator.ts` (extended) | BigQuery `queries`/`getQueryResults` and Catalog `skus` endpoints |

**Docs:**
- `apps/docs/content/docs/guides/iam/billing-and-usage.mdx`, rewritten around this model.
- `guides/vps/providers.mdx`, adding billing modes, grants and pass-through.
- `descriptions/api/{billing,reservationGrants,usage,pools,instances,flavors}.md`.
- `CHANGELOG.md`, `PLAN.md` §12.7.

---

## Phase 0 — Setup

### Task 0: Branch, claim, coordinate

**Files:** Modify `.claude/coordination.md` (one claim line).

- [ ] **Step 1:** Work on branch `feat/platform-compute-billing` in its own worktree, branched from the latest
  `origin/main` (rebased onto `release-0.2.1` if that has merged). Record the migration numbers that are free at that
  point, then substitute them for `00NN` everywhere in this plan.
- [ ] **Step 2:** Add the claim line, naming:
  - the new files above;
  - the shared files: `usage_windows` migration, `capacity/src/usage.ts`, `iam/src/{setup,worker,bridge}.ts`,
    `vps/src/{lifecycle,attach,instances,provider-reservations,networks,flavors,module}.ts` and
    `core/src/{iam,extension,domain,catalog}.ts`;
  - the 0.2.1 hotfix session as the owner of `provider-gcp/src/compute.ts` disk changes.
- [ ] **Step 3:** Run the baseline, `node node_modules/vitest/vitest.mjs run tests/vps-*.test.ts tests/capacity-*.test.ts tests/iam-*.test.ts tests/provider-gcp*.test.ts`.
  Expected: pass (or record pre-existing failures).
- [ ] **Step 4:** Commit with `chore: claim platform compute billing area`.

---

## Phase 1 — Foundation

### Task 1: IAM pricing port (D13)

**Files:**
- Modify: `packages/core/src/iam.ts`
- Modify: `packages/iam/src/bridge.ts`, `embedded.ts`, `remote.ts`
- Test: `tests/billing-port.test.ts`

**Interfaces — Produces** (all optional members of `IamPort`):

```ts
export interface MeterSpec { key: string; name: string; unit: string; pricing: 'rate-card' | 'reported' }
export interface PriceSpecInput {           // better-iam PriceSpec, micros
  model: 'per-unit' | 'graduated' | 'volume' | 'package';
  unitAmountMicros?: number; tiers?: { upTo: number | null; unitAmountMicros: number; flatAmountMicros?: number }[];
  packageSize?: number; packageAmountMicros?: number; includedQuantity?: number;
  minimumAmountMicros?: number; maximumAmountMicros?: number;
}
export interface PriceView { meter: string; targetTenantId?: string; effectiveFrom: string /* YYYY-MM */; spec: PriceSpecInput }
export interface QuoteLine { meter: string; quantity: number; amountMicros: number | null /* null = unpriced */ }
export interface SpendQuery { tenantId: string; from: number; to: number; groupBy: 'tenant' | 'meter' | 'tag'; tag?: string }
export interface SpendRow { key: string; meter?: string; tenantId?: string; amountMicros: number; quantity: number }

ensureMeters?(meters: readonly MeterSpec[]): Promise<{ created: string[]; existing: string[] }>;   // on the root tenant
setPrice?(input: { meter: string; targetTenantId?: string; effectiveFrom: string; spec: PriceSpecInput }): Promise<PriceView>;
listPrices?(input: { meter?: string; targetTenantId?: string }): Promise<PriceView[]>;
quote?(input: { tenantId: string; lines: readonly { meter: string; quantity: number }[] }): Promise<QuoteLine[]>;
spend?(query: SpendQuery): Promise<SpendRow[]>;
```

**How each port implements it:**
- **Embedded:** `iam.billing` (trusted runtime) where it has the method, otherwise `iam.api.billing.*` with the
  bridge's root service credential. `createMeter` on conflict counts as `existing`.
- **Remote:** HTTP `POST {base}/billing/{createMeter|setPrice|listPrices|quote|spend}` as the root service account.
- **`quote`:** prices `quantity` for `tenantId` with that tenant's effective price. When better-iam's `quote`
  covers a single meter only, call it once per line.

- [ ] **Step 1: Write the failing tests.** Against an embedded better-iam (fixture as in
  `tests/iam-bridge-matrix.test.ts`):
  - `ensureMeters creates missing meters on root and is idempotent`: the second call returns all keys in `existing`.
  - `setPrice then listPrices round-trips`, plus a negotiated price for tenant A whose `quote` beats the list price.
  - `quote marks unpriced meters null`.
  - `spend groups by meter for a tenant`.
  - `the remote port implements the same members`: against the HTTP test server in `tests/support/iam.ts`.
- [ ] **Step 2: Run.** `node node_modules/vitest/vitest.mjs run tests/billing-port.test.ts`. Expected: FAIL
  (members undefined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS. Also run `tests/iam-*.test.ts` with no regressions.
- [ ] **Step 5: Commit** with `core,iam: optional IAM port members for meters, prices, quotes and spend`.

### Task 2: The complete meter catalog

**Files:**
- Modify: `packages/iam/src/setup.ts`
- Create: `packages/vps/src/billing.ts` (only the meter-name helpers in this task)
- Test: `tests/billing-port.test.ts` (section `catalog`)

**Interfaces — Produces:**
- `export function meterCatalog(options: { gpuModels: readonly string[]; flavorMeters?: readonly string[] }): MeterSpec[]`.
  It always includes:
  - every existing `computeMeters` entry;
  - `vps.volume.gib.hours`, `gpu.other.hours`, and `gpu.<model>.spot.hours` for every model;
  - `vm.vcpu.hours`, `vm.memory.gib.hours`, `vm.instance.hours`;
  - `vm.gpu.<model>.hours` and `vm.gpu.<model>.spot.hours`;
  - `vm.reserved.vcpu.hours`, `vm.reserved.memory.gib.hours`, `vm.reserved.gpu.<model>.hours`;
  - `vm.grant.slot.hours`, `vm.grant.usage.hours`, `vm.managed.hours`;
  - `network.vpc.hours`, `ip.public.hours`, `disk.<type>.gib.hours` for `pd-standard`, `pd-balanced`, `pd-ssd`,
    `hyperdisk-balanced` and `local-ssd`;
  - `snapshot.gib.hours`.

  All of these are `rate-card`. `flavorMeters` adds `flavor.*` keys. Units: `hour`, `vcpu-hour`, `gib-hour`,
  `gpu-hour`, `slot-hour`.
- `computeMeters` stays exported as an alias of the old list, for compatibility.
- `meterCatalog` must stay ≤ 90 keys for the default `gpuModels` (`H100`, `H200`, `B200`, `A100`, `L4`, `L40S`,
  `other`), leaving headroom under better-iam's 100. A test asserts this.

- [ ] **Step 1: Write the failing tests:**
  - `meterCatalog covers every meter any reconciler emits`: collect the meter names from `billableLines`,
    `meterLinesFor` (Task 5) and the D9 meters; assert all are present.
  - `meterCatalog stays under 90 meters for the default models`.
  - `setup creates the catalog so no window dead-letters on NOT_FOUND`: meter a volume and a spot GPU through the
    existing reconcilers, flush, and assert outcome `recorded`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `setup` calls `ensureMeters(meterCatalog(...))` when the port has it.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `iam: one meter catalog for every metered source`.

### Task 3: The `billing` API group (D13)

**Files:**
- Create: `packages/vps/src/pricing.ts` (meters and prices here; proposals, estimates and margins come in later
  tasks)
- Modify: `packages/vps/src/module.ts`, `packages/core/src/catalog.ts`
- Docs: `apps/docs/descriptions/api/billing.md` (create)
- Test: `tests/vps-pricing.test.ts`

**Interfaces — Produces.** The catalog gains actions `billing:read` / `billing:manage` on the `fleet` kind. Only
root can hold `fleet` grants.

| Method | Kind | Action | Decided on | Phase |
|---|---|---|---|---|
| `meters` | read | `billing:read` | `fleet` | `v1.0` |
| `syncMeters` | mutation | `billing:manage` | `fleet` | `v1.0` |
| `prices` | read | `billing:read` | `fleet` | `v1.0` |
| `setPrices` | mutation | `billing:manage` | `fleet` | `v1.0` |

Each row is written as `group('billing', 'vps', [['meters', 'read', 'billing:read', 'fleet', 'v1.0'], …])`.

The methods:
- `billing.meters({})` returns `{ catalog: MeterSpec[]; missing: string[] }`.
- `billing.syncMeters({})` calls `ensureMeters`.
- `billing.prices({ meter?, targetTenantId? })` returns `PriceView[]`.
- `billing.setPrices({ prices: { meter, targetTenantId?, effectiveFrom, spec }[] })` takes at most 100 prices and
  calls `setPrice` for each. Its rules:
  - It validates that each meter is in the catalog or is a flavor meter.
  - `targetTenantId` is passed through to better-iam, which validates it.
  - On a partial failure it returns `{ applied, failed[] }`.
- Every method returns `UNSUPPORTED` when the port lacks the member.

- [ ] **Step 1: Write the failing tests:**
  - `root lists meters and sees missing ones`.
  - `root sets a list price and a negotiated price for tenant A`.
  - `a tenant admin is denied on every billing method`: through the real IAM path, as in
    `tests/root-issued-compute-iam.test.ts`.
  - `setPrices refuses an unknown meter`.
  - `UNSUPPORTED without the port member`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS. `node scripts/authz-matrix.mjs` must also pass.
- [ ] **Step 5: Commit** with `vps: billing API for root (meters and prices)`.

### Task 4: Generalized usage sources (D2)

**Files:**
- Create: `packages/postgres/src/migrations/00NN_usage_sources.ts`, registered in `migrations/index.ts`
- Modify: `packages/capacity/src/usage.ts`, `packages/iam/src/worker.ts`
- Test: `tests/usage-sources.test.ts`

**Migration:**

```sql
ALTER TABLE usage_windows ALTER COLUMN allocation_id DROP NOT NULL;
ALTER TABLE usage_windows ADD COLUMN source_kind text NOT NULL DEFAULT 'allocation'
  CHECK (source_kind IN ('allocation','instance','grant','network','snapshot','cost'));
ALTER TABLE usage_windows ADD COLUMN source_id text;            -- NULL for legacy rows = allocation_id
ALTER TABLE usage_windows ADD COLUMN voided_at timestamptz;     -- Task 23
ALTER TABLE usage_windows ADD COLUMN void_reason text;
ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_ck
  CHECK ((source_kind = 'allocation' AND allocation_id IS NOT NULL) OR (source_kind <> 'allocation' AND source_id IS NOT NULL));
-- No WHERE clause (partitioned parents may refuse partial unique indexes); legacy allocation rows have
-- source_id NULL, and NULLs never collide in a unique index.
CREATE UNIQUE INDEX usage_windows_source ON usage_windows (source_kind, source_id, window_start, meter);
```

There is no backfill. Allocation rows keep their existing unique key `(allocation_id, window_start, meter)`.

**Interfaces — Produces** (`capacity/src/usage.ts`):

```ts
export type UsageSourceKind = 'allocation' | 'instance' | 'grant' | 'network' | 'snapshot' | 'cost';
export interface SourceMeterInput {
  sourceKind: Exclude<UsageSourceKind, 'allocation' | 'cost'>; sourceId: string;
  tenantId: string; identityId?: string; lines: readonly { meter: string; perHour: number }[];
  from: number; to: number;                 // ms; only whole ended hours are written (hourlyWindows)
  tags: UsageTags;                          // D19 keys only
}
export function sourceUsageKey(kind: UsageSourceKind, id: string, windowStartMs: number, meter?: string): string; // D2 form
export async function meterSource(tx: SqlTx, input: SourceMeterInput, now: number): Promise<number>; // windows written
```

- `meterAllocation` stays byte-for-byte compatible: same keys, same rows.
- `UsageTags` gains optional `provider`, `flavor` and `source`.
- The `iam.usage` flush selects every source and skips `voided_at IS NOT NULL`.

- [ ] **Step 1: Write the failing tests:**
  - `allocation windows keep their keys and amounts`: a golden test that runs the existing reservation metering
    and compares with a fixture of keys and quantities captured on `main` before the change.
  - `meterSource writes hourly windows with D2 keys and is idempotent`: running the same span twice writes 0 the
    second time.
  - `month split`: a span from 23:30 on the last day of the month to 00:30 gives two windows, at 23:00 (0.5) and
    00:00 (0.5).
  - `the flush records instance-source windows and skips voided ones`.
  - `the migration runs on a populated partitioned table`: seed 3 monthly partitions, migrate, and assert row counts
    unchanged.
- [ ] **Step 2: Run** `node node_modules/vitest/vitest.mjs run tests/usage-sources.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS. Also run `tests/capacity-*usage*.test.ts` and
  `tests/vps-*.test.ts` with no regressions.
- [ ] **Step 5: Commit** with `core,capacity,iam: usage windows from typed sources`.

---

## Phase 2 — Provider VMs

### Task 5: Billing rules: meters for a provider instance (D4, D5, D8)

**Files:**
- Modify: `packages/vps/src/billing.ts`, `packages/core/src/domain.ts`
- Test: `tests/vps-provider-usage.test.ts` (section `rules`)

**Interfaces — Produces:**

```ts
// core domain.ts (additive)
PoolPolicy.billing?: { mode: 'metered' | 'platform-fee' | 'none' };
Flavor.billing?: { meter?: string };          // flavor.<…>.hours; replaces composed lines
// vps billing.ts
export type BillingMode = 'metered' | 'platform-fee' | 'none';
export interface BillableShape {
  vcpu: number; memoryGiB: number; gpus?: { model: string; count: number };
  spot: boolean; reserved: boolean; granted: boolean; flavorMeter?: string;
  publicIp?: boolean;                                  // Task 12
  disks?: readonly { type: string; sizeGiB: number }[]; // Task 13
}
export function billingModeOf(pool: { ownerTenantId: string; class: string; policy: PoolPolicy }, account: { tenantId: string } | undefined, rootTenantId: string): BillingMode;
export function meterLinesFor(shape: BillableShape, mode: BillingMode, phase: 'running' | 'stopped'): { meter: string; perHour: number }[];
```

**Rules for `meterLinesFor`:**
- `phase: 'stopped'` returns only disk lines (Task 13; `[]` until then).
- `none` returns `[]`.
- `platform-fee` returns `[{ vm.managed.hours, 1 }]`.
- `granted` returns `[{ vm.grant.usage.hours, 1 }]` only (D7).
- `flavorMeter` returns `[{ flavorMeter, 1 }]`.
- Otherwise:
  - prefix `vm.reserved.` when `reserved`, else `vm.`;
  - vCPU → `<prefix>vcpu.hours` × vcpu;
  - memory → `<prefix>memory.gib.hours` × memoryGiB;
  - GPUs → `<prefix>gpu.<model>[.spot].hours` × count, where spot never combines with reserved and an unknown model
    becomes `other`;
  - plus `vm.instance.hours` × 1, never prefixed.
- Tasks 12 and 13 append `ip.public.hours` and `disk.<type>.gib.hours` lines here. They apply in `metered` mode
  only, including granted and flavor-meter instances (a grant covers the VM, not its disks or address).

**Rules for `billingModeOf`:**
- An explicit `policy.billing.mode` wins.
- Otherwise a `class: 'provider'` pool whose account's tenant ≠ `rootTenantId` gets `platform-fee`.
- Everything else gets `metered`.

- [ ] **Step 1: Write the failing tests:** a table test covering every rule above, including:
  - `spot GPU`: `vm.gpu.H100.spot.hours` × 8;
  - `reserved`: `vm.reserved.vcpu.hours`, with no `.spot`;
  - `granted`: only `vm.grant.usage.hours`;
  - `flavor meter replaces composition`;
  - `BYO pool → platform-fee`;
  - `explicit none`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: billing rules for provider instances`.

### Task 6: Lifecycle intervals (D3)

**Files:**
- Create: `packages/vps/src/instance-usage.ts` (migration `vps/00NN_instance_usage`)
- Modify: `packages/vps/src/lifecycle.ts`, `instances.ts`, `attach.ts`, `migrations.ts`
- Test: `tests/vps-provider-usage.test.ts` (section `intervals`)

**Table:**

```sql
CREATE TABLE instance_usage_intervals (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES instances,
  tenant_id text NOT NULL, project_id text, identity_id text,
  pool_id text NOT NULL, region text, provider text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('running', 'stopped')),
  mode text NOT NULL CHECK (mode IN ('metered', 'platform-fee', 'none')),
  shape jsonb NOT NULL,                     -- BillableShape
  started_at timestamptz NOT NULL, ended_at timestamptz,
  metered_until timestamptz NOT NULL,       -- = started_at initially
  EXCLUDE USING gist (instance_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity')) WITH &&)
);
CREATE INDEX instance_usage_open ON instance_usage_intervals (metered_until) WHERE ended_at IS NULL OR metered_until < ended_at;
ALTER TABLE instances ADD COLUMN billing text CHECK (billing IN ('metered', 'none'));   -- D6, NULL = pool default
```

**Interfaces — Produces:**

```ts
export async function openInterval(tx: SqlTx, row: InstanceRow, phase: 'running' | 'stopped', at: number, deps: { rootTenantId: string }): Promise<void>;
export async function closeOpenInterval(tx: SqlTx, instanceId: string, at: number): Promise<void>; // no-op when none open
```

These are called inside the existing lifecycle transactions, for provider-pool instances only:
- **Reported `running`:** close any open interval, then open `running`.
- **Reported `stopped`:** close, then open `stopped`.
- **`lost`, `deleted`, `detached`:** close.
- **`error`:** close.
- **Recovery** `lost → running`: open a new interval at the recovery time. The lost time is not billed.

`shape` is captured at open: flavor or attached shape, `spot` from the flavor or offer, `reserved` from
`instances.provider_reservation`, `granted` from Task 10, and `flavorMeter`. A resize or grant change closes the
interval and opens a new one. Attached instances open their first interval no earlier than `attached_at`, and only
when `instances.billing` is not `none`.

- [ ] **Step 1: Write the failing tests** (inline fake provider, the P2 style from `tests/vps-attach.test.ts`;
  `manualClock`):
  - `a created VM opens running at the first observed running and closes at observed stopped`.
  - `interval edges`:
    - a running → lost → recovered flap leaves the lost span unbilled;
    - a restart mid-interval (rebuild the module, tick) creates no duplicate, and the database refuses an overlapping
      insert;
    - a requested stop while the provider still reports running keeps billing until the observed stop;
    - attach to A, then detach, then attach to B gives two intervals with the right tenants and no overlap.
  - `attached billing none opens no interval`.
  - `stopped phase opens for disks only` (Task 13 meters it).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS. Also run `tests/vps-*.test.ts`.
- [ ] **Step 5: Commit** with `vps: lifecycle usage intervals for provider instances`.

### Task 7: The `vps.provider-usage` reconciler

**Files:**
- Modify: `packages/vps/src/instance-usage.ts`, `module.ts`
- Test: `tests/vps-provider-usage.test.ts` (section `metering`)

**Interfaces — Produces:**
- The reconciler `vps.provider-usage`: `shardBy: 'none'`, `periodic: [{ key: 'all', every: '5m' }]`.
- For each interval with `metered_until < coalesce(ended_at, now)` (at most 5000 per pass, oldest first), it does
  the following:
  - Calls `meterSource(tx, { sourceKind: 'instance', sourceId: instance_id, … lines: meterLinesFor(shape, mode, phase),
    from: metered_until, to: coalesce(ended_at, now) })`.
  - Advances `metered_until` to the last whole hour written.
  - Uses tags `{ region, pool, project?, provider, gpuModel?, flavor?, source: 'instance' }` and `identityId` =
    the instance owner.
  - Meters both phases through `meterLinesFor(shape, mode, phase)`. Until Task 13, `stopped` gives no lines.
    Those intervals keep `metered_until` unadvanced, so Task 13 bills their backlog.

- [ ] **Step 1: Write the failing tests:**
  - `a 2h30m run writes 2 whole hours now and the half hour when it closes`.
  - `vcpu/memory/gpu/instance lines match the shape`: for an 8×H100 a3-highgpu-8g, assert `vm.vcpu.hours` 208,
    `vm.memory.gib.hours` 1872, `vm.gpu.H100.hours` 8 and `vm.instance.hours` 1 per full hour.
  - `usage is attributed to the issued tenant and owner`: a VM root issued to A has `tenantId` A and
    `identityId` = the A owner, and the tags contain no instance id.
  - `flushed through iam.usage as recorded`: embedded better-iam, with meters from Task 2.
  - `I8 conservation`: Σ quantity of `vm.instance.hours` = Σ interval hours.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: meter provider instances from their intervals`.

### Task 8: Pool billing modes and attach billing (D5, D6)

**Files:**
- Modify: `packages/vps/src/attach.ts`, `packages/capacity/src/module.ts` (`pools.create/update` accept
  `policy.billing`), `packages/vps/src/flavors.ts` (`billing.meter`)
- Docs: `descriptions/api/{instances,pools,flavors}.md`
- Test: `tests/vps-provider-usage.test.ts` (section `modes`)

**Interfaces — Produces:**
- `instances.attach` input gains `billing?: 'metered' | 'none'`. A non-root caller passing `none` gets
  `ACCESS_DENIED`. It is stored in `instances.billing`.
- `flavors.create/update` accept `billing?: { meter?: string }`. The meter must match `^flavor\.[a-z0-9.-]{1,56}\.hours$`;
  it is created through `ensureMeters` when the port has it.

- [ ] **Step 1: Write the failing tests:**
  - `BYO pools bill a platform fee only`: a tenant-owned account with A's own pool and a running VM gives only
    `vm.managed.hours`, and never `vm.*` compute meters.
  - `policy.billing none bills nothing`.
  - `root attaches with billing none and nothing is metered`.
  - `a tenant cannot attach with billing none`.
  - `a flavor meter replaces composed lines`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps,capacity: pool billing modes, attach billing, flavor meters`.

---

## Phase 3 — Commitments

### Task 9: Reserved-rate metering (D8)

**Files:**
- Modify: `packages/vps/src/instance-usage.ts` (shape `reserved` from `instances.provider_reservation`)
- Test: `tests/vps-reservation-grants.test.ts` (section `reserved`)

- [ ] **Step 1: Write the failing tests:**
  - `an instance admitted against a reservation meters vm.reserved.* lines`.
  - `binding or unbinding does not change running intervals`: the shape is captured at open.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: reserved-rate meters for reservation-admitted instances`.

### Task 10: Reservation grants: model, API, admission (D7)

**Files:**
- Create: `packages/vps/src/reservation-grants.ts` (migration `vps/00NN_reservation_grants`)
- Modify: `packages/vps/src/provider-reservations.ts` (`claimReservationSlot` is grant-aware),
  `packages/core/src/catalog.ts`, `packages/events/src/catalog.ts` (family `reservation-grant.*`, subject
  `reservation-grant/{id}`)
- Docs: `descriptions/api/reservationGrants.md`
- Test: `tests/vps-reservation-grants.test.ts` (section `grants`)

**Table:**

```sql
CREATE TABLE reservation_grants (
  id text PRIMARY KEY,
  account_id text NOT NULL, reservation_id text NOT NULL,
  tenant_id text NOT NULL, project_id text,
  slots int NOT NULL CHECK (slots > 0),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  state text NOT NULL CHECK (state IN ('scheduled', 'active', 'ended', 'cancelled')),
  metered_until timestamptz NOT NULL,
  created_by text NOT NULL, idempotency_key text NOT NULL, request_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  FOREIGN KEY (account_id, reservation_id) REFERENCES provider_reservations (account_id, reservation_id),
  UNIQUE (created_by, idempotency_key)
);
ALTER TABLE instances ADD COLUMN reservation_grant_id text REFERENCES reservation_grants;
```

**Interfaces — Produces:**

| Method | Kind | Action | Decided on | Notes |
|---|---|---|---|---|
| `create` | mutation | `providers:manage` | `provider-account` | Root account only |
| `get` | read | `quotas:read` | `tenant` | |
| `list` | read | `quotas:read` | `tenant` | `list` recipe; a tenant sees only its own grants; root sees all with `tenantId: root` and `all: true` |
| `end` | mutation | `providers:manage` | `provider-account` | |

Each row is written as `group('reservationGrants', 'vps', [...])`.

**`reservationGrants.create({ tenantId: root, accountId, reservationId, grantTenantId, projectId?, slots, startsAt, endsAt, idempotencyKey })`:**
- The reservation must be on a root-owned account, `ready`, and bound to a pool offered to `grantTenantId`.
- Under the reservation row lock, `Σ slots of scheduled or active grants overlapping the term + slots` must be
  ≤ `total`. Otherwise it fails with `CAPACITY_UNAVAILABLE` and details `{ total, granted }`.
- `startsAt` must be ≥ now − 5 min.
- It publishes `reservation-grant.created`.

**State transitions** (driven by Task 11's reconciler):
- `scheduled` becomes `active` at `starts_at`, and `active` becomes `ended` at `ends_at`.
- `end` sets `ends_at = max(now, starts_at)`: past hours stay billed and later ones are not.

**Admission** (`claimReservationSlot`) for a tenant T on reservation R:
- **T has an active grant G on R:** if T's instances in G number fewer than `G.slots`, admit into G (set
  `reservation_grant_id`) and stop.
- **Otherwise:** `free_outside = total − in_use_outside_grants − Σ unused slots of active grants`. Admit with no
  grant if that is ≥ 1; otherwise fail with `CAPACITY_UNAVAILABLE`.
- `in_use` from the provider scan counts all VMs. Pending-count logic from 0.2.0 still applies, per grant and
  outside grants.

- [ ] **Step 1: Write the failing tests:**
  - `root grants 2 of 4 slots to A for a month`.
  - `over-granting is refused by the database`: concurrent grants of 3 + 2 on 4 slots give one success and one
    `CAPACITY_UNAVAILABLE`.
  - `A is admitted into its grant first`.
  - `B cannot take A's granted slots`: with 4 slots, 2 granted to A and A idle, B gets 2 and is refused the 3rd.
  - `A beyond its grant falls back to outside slots`.
  - `a tenant cannot create a grant and sees only its own`.
  - `ending a grant mid-term`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS. Also run `tests/vps-provider-reservations.test.ts`.
- [ ] **Step 5: Commit** with `vps: reservation grants with grant-aware admission`.

### Task 11: Grant billing

**Files:**
- Modify: `packages/vps/src/reservation-grants.ts` (the `vps.grants` reconciler), `instance-usage.ts` (`granted`
  shape)
- Test: `tests/vps-reservation-grants.test.ts` (section `billing`)

**Interfaces — Produces:**
- The reconciler `vps.grants`: `periodic: [{ key: 'all', every: '5m' }]`. It does three things:
  - moves grants between states;
  - for `active` and `ended` grants with `metered_until < min(ends_at, now)`, calls `meterSource({ sourceKind:
    'grant', sourceId: grant.id, tenantId: grant.tenant_id, lines: [{ meter: 'vm.grant.slot.hours', perHour:
    slots }], from: max(metered_until, starts_at), to: min(ends_at, now), tags: { region, pool, provider, source:
    'grant' } })`;
  - publishes `reservation-grant.active` and `reservation-grant.ended`.
- Instances with `reservation_grant_id` open intervals with `granted: true` (Task 5 rule).

- [ ] **Step 1: Write the failing tests:**
  - `a 2-slot grant bills 2 slot-hours every hour, used or not`: across 3 hours with 0, 1 and 2 instances running,
    `vm.grant.slot.hours` is 6.
  - `instances inside a grant record no compute meters`: only `vm.grant.usage.hours`, with no `vm.vcpu.hours` etc.
  - `an instance outside the grant (overflow) meters vm.reserved.*`.
  - `an ended grant stops billing at ends_at`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: bill reservation grants by committed slot-hours`.

---

## Phase 4 — Ancillaries

### Task 12: Networks and public IPs (D9)

**Files:**
- Create: `packages/vps/src/ancillary-usage.ts` (the `vps.ancillary-usage` reconciler, `periodic` 5 min)
- Modify: `packages/vps/src/networks.ts`; migration `vps/00NN_network_metering` adds
  `networks.metered_until timestamptz` (`provisioned_at` already exists)
- Modify: `packages/vps/src/billing.ts` (the `ip.public.hours` line), `instance-usage.ts` (`shape.publicIp`)
- Test: `tests/vps-ancillary-usage.test.ts`

**Rules:**
- `network.vpc.hours` is metered per network from `provisioned_at` until it is `deleted`, with source `network`
  and the network's tenant.
- `ip.public.hours` × 1 is a `meterLinesFor` line for `running` intervals whose `shape.publicIp` is true.
  - `publicIp` is captured at interval open from the instance's current addresses.
  - The lifecycle closes and reopens the interval when the public address appears or disappears.
  - It is metered by `vps.provider-usage` under the instance's source.
- Neither meter applies when the pool mode is `none` or `platform-fee`.

- [ ] **Step 1: Write the failing tests:**
  - `a provisioned network bills vpc hours until deleted`.
  - `a never-provisioned network bills nothing`.
  - `a VM with a public IP bills ip.public.hours while running`.
  - `BYO networks bill nothing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: meter tenant networks and public IPs`.

### Task 13: Disks and snapshots (D9)

**Files:**
- Modify: `packages/vps/src/billing.ts` (disk lines in both phases), `instance-usage.ts` (`shape.disks` captured
  at interval open; stopped intervals' backlog), `ancillary-usage.ts` (snapshots)
- Test: `tests/vps-ancillary-usage.test.ts` (section `disks`)

**Rules:**
- `disk.<type>.gib.hours` × `sizeGiB` per disk covers both `running` and `stopped` intervals.
  - Disks come from the machine record when the provider reports them (0.2.1 adds disks to the machine record).
  - Otherwise there is one boot disk of `flavor.diskGiB` and type `pd-balanced`, or `hyperdisk-balanced` for machine
    families the provider marks as requiring it. Read that from the provider's machine record.
  - An unknown type is metered as `disk.pd-balanced.gib.hours`, with condition `DiskTypeUnknown` on the instance.
- `snapshot.gib.hours` × `sizeBytes / 2^30` per sandbox snapshot, from `ready` until it is deleted.

- [ ] **Step 1: Write the failing tests:**
  - `a 100 GiB boot disk bills 100 GiB-hours per hour running and stopped`.
  - `hyperdisk machine family bills hyperdisk-balanced`.
  - `snapshots bill by size`.
  - `a deleted VM stops disk billing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: meter disks and snapshots`.

---

## Phase 5 — Cost and margin

### Task 14: The provider cost contract and the GCP BigQuery reader (D10)

**Files:**
- Modify: `packages/core/src/extension.ts`
- Create: `packages/provider-gcp/src/costs.ts`
- Modify: `packages/provider-gcp/src/config.ts` (`billingExport?: { project: string; dataset: string; table:
  string; location?: string }`), `provider.ts`
- Modify: `tests/support/gce-emulator.ts` (BigQuery `POST /bigquery/v2/projects/{p}/queries`,
  `GET …/queries/{jobId}` with `pageToken`)
- Test: `tests/provider-gcp-costs.test.ts`

**Interfaces — Produces** (core, additive):

```ts
export interface ProviderCostRecord {
  sourceRowId: string;                // stable hash of the export row identity (see below)
  service: string; sku: string; skuDescription?: string;
  region?: string; zone?: string; project?: string; resourceName?: string;
  usageStart: number; usageEnd: number;
  quantity: number; unit: string;     // usage.amount_in_pricing_units / pricing unit
  costMicros: number; creditsMicros: number;   // credits ≤ 0
  currency: string; labels: Readonly<Record<string, string>>;
  exportTime: number;
}
costs?(window: { from: number; to: number }, context: CallContext): AsyncIterable<ProviderCostRecord>;
```

**GCP implementation:**
- **Query:** a parameterized query, never string-built, against `` `<project>.<dataset>.<table>` `` (the detailed
  resource-level export).
  - Filter: `usage_start_time >= @from AND usage_start_time < @to` and `cost_type = 'regular'`, plus adjustments
    with `cost_type != 'regular'` as their own rows.
  - Columns selected: `service.description`, `sku.id`, `sku.description`, `location.region`, `location.zone`,
    `project.id`, `resource.name`, `usage_start_time`, `usage_end_time`, `usage.amount_in_pricing_units`,
    `usage.pricing_unit`, `cost`, `currency`, `labels`, `export_time`, `credits`.
- **`sourceRowId`:** `sha256` of `billing_account_id | sku.id | project.id | resource.name | usage_start_time |
  usage_end_time | cost_type`. `export_time` is excluded, so a re-export of the same row has the same id.
- **Pagination:** `pageToken`. Long jobs are polled with `jobs.getQueryResults`, with a 30 s in-call budget; if
  that runs out, throw `UNAVAILABLE` so the worker retries.
- **Auth scopes:** `bigquery.readonly` plus the existing `compute` scope. The README lists the IAM role
  `roles/bigquery.dataViewer` on the dataset and `roles/bigquery.jobUser` on the project.

- [ ] **Step 1: Write the failing tests** (the emulator serves fixture rows):
  - `reads and maps export rows`.
  - `query parameters, never interpolation`: assert the request body uses `queryParameters` and the SQL contains
    no literal dates.
  - `pages through results`.
  - `stable sourceRowId across re-export`.
  - `credits are summed negative`.
  - `long jobs time out as UNAVAILABLE`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `core,provider-gcp: provider cost records from the BigQuery billing export`.

### Task 15: Cost ingestion and attribution (D10)

**Files:**
- Create: `packages/vps/src/costs.ts` (migration `vps/00NN_provider_costs`, the `vps.costs` reconciler)
- Modify: `packages/vps/src/module.ts` (`VpsOptions.costs?: { every?: Duration; lookbackDays?: number }`, defaults
  `6h` and `3`), `packages/events/src/catalog.ts` (family `billing.*`)
- Test: `tests/vps-costs.test.ts`

**Table:**

```sql
CREATE TABLE provider_costs (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  source_row_id text NOT NULL,
  record jsonb NOT NULL,
  usage_start timestamptz NOT NULL, usage_end timestamptz NOT NULL,
  cost_micros bigint NOT NULL, credits_micros bigint NOT NULL, currency text NOT NULL,
  instance_id text, tenant_id text,
  attribution text NOT NULL CHECK (attribution IN ('instance', 'tenant-label', 'account', 'unattributed')),
  passed_through_at timestamptz, pass_through_key text,
  ingested_at timestamptz NOT NULL DEFAULT compute_now(), updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (account_id, source_row_id)
);
CREATE INDEX provider_costs_tenant_day ON provider_costs (tenant_id, usage_start);
CREATE TABLE provider_cost_scans (account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL, scanned_to timestamptz, last_error text);
ALTER TABLE provider_accounts ADD COLUMN billing jsonb NOT NULL DEFAULT '{}';   -- Task 16 pass-through rules
```

**The worker** uses the same two-key pattern as `vps.discovery`, over accounts whose provider implements `costs`:
- It reads `[now − lookbackDays, now)` outside any transaction, then upserts in batches of 500.
- **Attribution order:**
  1. `labels['better-compute-instance']` → `instances.id`, which gives `tenant_id`.
  2. `labels['better-compute-tenant']`.
  3. The account's tenant, when the account is a tenant's own (BYO).
  4. `unattributed`.
- **A changed row:** an existing row whose `cost_micros` changed is updated, and `billing.cost-corrected` is
  published with `{ accountId, sourceRowId, previousMicros, costMicros, passedThrough: boolean }`.
- **Events:** `billing.unattributed` once per row, and `billing.cost-ingested` once per pass per account, with
  totals.

- [ ] **Step 1: Write the failing tests:**
  - `attributes by instance label, then tenant label, then account`.
  - `re-exported rows are idempotent`.
  - `a corrected row updates and publishes cost-corrected`.
  - `rate limits defer the account`.
  - `currency mismatch is stored but flagged`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: ingest and attribute provider costs`.

### Task 16: Pass-through charges (D11)

**Files:**
- Modify: `packages/vps/src/costs.ts`, `accounts.ts` (reads and writes the `provider_accounts.billing` column from
  Task 15; validated in vps, not in the provider manifest)
- Docs: `descriptions/api/providerAccounts.md`
- Test: `tests/vps-costs.test.ts` (section `pass-through`)

**Interfaces — Produces:**
- `providerAccounts.create/update` accept `billing?: { passThrough?: { skuPattern: string; meter: string;
  multiplier: number }[] }`, root accounts only.
  - `skuPattern` is a case-insensitive substring of `sku` or `skuDescription`.
  - `meter` must exist as a `reported` meter (created through `ensureMeters` with `pricing: 'reported'`).
  - `1 ≤ multiplier ≤ 10`.
  - A pattern that matches a SKU family D4 meters is refused with `INVALID_CONFIG`. The SKU families are
    `/core|ram|gpu|instance/i` for Compute Engine; each provider exposes its compute SKU matcher as
    `ProviderDefinition.billing?.computeSku?: (record) => boolean`.
- **After attribution:** each row that is attributed to a tenant, matches a rule, and is not yet passed through
  emits one usage event:
  - `{ tenantId, meter, quantity: record.quantity, cost: (costMicros + creditsMicros) × multiplier / 1e6, occurredAt:
    usageStart, tags: { region, provider, source: 'cost' }, idempotencyKey: 'costx:<accountId>:<sourceRowId>' }`.
  - It is recorded through `recordUsage` with source `cost` written to `usage_windows` for visibility, and
    `passed_through_at` is set.
- **Rows with zero or negative net cost** are skipped. A corrected row that was already passed through is never
  re-emitted (D11, Review Focus 4).

- [ ] **Step 1: Write the failing tests:**
  - `egress rows pass through at cost × 1.2 on the egress meter`.
  - `pass-through is idempotent across rescans`.
  - `compute SKUs cannot be pass-through targets`.
  - `BYO and unattributed rows never pass through`.
  - `a corrected row after pass-through emits cost-corrected only`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: pass provider costs through to tenants`.

### Task 17: Margins and leak detection (D12)

**Files:**
- Modify: `packages/vps/src/pricing.ts` (`billing.margins`), `costs.ts` (leak check), `core/src/catalog.ts`
- Docs: `descriptions/api/billing.md`
- Test: `tests/vps-costs.test.ts` (section `margins`)

**Interfaces — Produces:**
- The row `['margins', 'read', 'billing:read', 'fleet', 'v1.0']`.
- `billing.margins({ from, to, groupBy: 'tenant' | 'pool' | 'account' | 'meter' })` returns
  `{ rows: { key, revenueMicros: number | null, costMicros, marginMicros: number | null, marginPct: number | null }[],
  unattributedCostMicros, currency }`.
  - Revenue comes from `IamPort.spend?`. Without it, revenue is `null`.
  - Cost is `Σ (cost_micros + credits_micros)` from `provider_costs` in the same currency.
- **Leak check** (end of each `vps.costs` pass, per instance per UTC day): provider hours are the sum of
  `record.quantity` over rows whose SKU the provider's `computeSku` matches. If they exceed metered `running` hours
  from intervals by more than `leakToleranceHours` (default 1), it publishes `billing.leak` with
  `{ instanceId, tenantId, day, providerHours, meteredHours }`. It does this at most once per instance-day.

- [ ] **Step 1: Write the failing tests:**
  - `margins per tenant equal revenue minus cost`: embedded better-iam with prices, plus cost fixtures.
  - `unattributed cost is reported separately`.
  - `a VM running in the provider with no interval raises billing.leak`.
  - `within tolerance raises nothing`.
  - `a tenant cannot read margins`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: margins and leak detection`.

---

## Phase 6 — Price discovery

### Task 18: Provider list prices (GCP Catalog)

**Files:**
- Modify: `packages/core/src/extension.ts`
- Create: `packages/provider-gcp/src/prices.ts`
- Modify: `tests/support/gce-emulator.ts` (`GET https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus`
  with `pageToken`)
- Test: `tests/provider-gcp-prices.test.ts`

**Interfaces — Produces** (core, additive):

```ts
export interface ProviderListPrice {
  resource: 'vcpu' | 'memory' | 'gpu' | 'disk' | 'ip' | 'egress';
  region: string; gpuModel?: string; diskType?: string; machineFamily?: string;
  spot: boolean; unitPriceMicros: number; unit: 'hour' | 'gib-hour' | 'gib';
  currency: string; sku: string;
}
listPrices?(query: { regions?: readonly string[] }, context: CallContext): Promise<ProviderListPrice[]>;
```

**GCP implementation:**
- It maps SKU `category.resourceGroup` (`CPU`, `RAM`, `GPU`, `SSD`, `PDStandard`, …), `usageType` (`OnDemand` or
  `Preemptible`; `Commit1Yr`/`Commit3Yr` are skipped) and `serviceRegions` to resources.
- `pricingInfo[0].pricingExpression.tieredRates[0].unitPrice {units, nanos}` becomes micros.
- The machine family comes from `description`, e.g. "N2 Instance Core": the family is the first token,
  lowercased.
- The result is cached per account for 24 h.

- [ ] **Step 1: Write the failing tests:**
  - `maps CPU, RAM and H100 GPU SKUs for us-central1`.
  - `spot SKUs are flagged`.
  - `commitment SKUs are skipped`.
  - `pages and caches`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `core,provider-gcp: provider list prices from the Cloud Billing Catalog`.

### Task 19: Price proposals and tenant estimates (D14, D15)

**Files:**
- Modify: `packages/vps/src/pricing.ts`, `flavors.ts`, `instances.ts` (`dryRun`), `core/src/catalog.ts`
- Docs: `descriptions/api/{billing,flavors,instances}.md`
- Test: `tests/vps-pricing.test.ts` (section `proposals`)

**Interfaces — Produces:**
- The row `['proposePrices', 'read', 'billing:read', 'fleet', 'v1.0']`.
- `billing.proposePrices({ accountId, marginPct, region?, effectiveFrom })` returns
  `{ proposals: { meter, spec: PriceSpecInput, basis: { sku, unitPriceMicros }[] }[], unpriced: string[] }`.
  - **D4 meters:** `vm.vcpu.hours` and `vm.memory.gib.hours` use the region's cheapest general-purpose family as
    the basis. Per-family accuracy is what flavor meters are for.
  - **GPU meters:** `vm.gpu.<model>.hours` and the `.spot` meters use the GPU SKU.
  - **Per-flavor meters:** composed from the family's vCPU, RAM and GPU SKUs.
  - **Ancillaries:** the matching SKUs.
  - Every spec is `per-unit` at `round(unitPriceMicros × (1 + marginPct/100))`. Nothing is applied: root
    publishes through `billing.setPrices`.
- `flavors.list` items gain `estimate?: { perHourMicros: number | null; currency: string; lines: QuoteLine[] }`.
  - It is computed with `IamPort.quote` for the caller's tenant, using `meterLinesFor` of the flavor's shape and the
    pool's billing mode.
  - It is cached 5 min per (tenant, pool).
  - `instances.create({ …, dryRun: true })` returns `{ estimate }` and creates nothing.

- [ ] **Step 1: Write the failing tests:**
  - `proposals apply the margin to provider list prices`.
  - `proposals never set prices`: `listPrices` is unchanged afterwards.
  - `a tenant sees its negotiated estimate on flavors.list`.
  - `dryRun creates nothing and returns the estimate`.
  - `no quote port → no estimate field`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: price proposals for root and estimates for tenants`.

---

## Phase 7 — Enforcement

### Task 20: Offer budget policies over the API (D16)

**Files:**
- Modify: `packages/capacity/src/module.ts`, `iam-reactions.ts`, `core/src/{domain,catalog}.ts`
- Create: migration `core/00NN_offer_suspension` (`pool_offers.suspended_at timestamptz`)
- Docs: `descriptions/api/pools.md`
- Test: `tests/capacity-offer-budgets.test.ts`

**Interfaces — Produces:**
- `pools.offer` input gains `onBudgetExceeded?: 'notify' | 'stop-new' | 'drain' | 'suspend'` and
  `allowedRegions?: string[]`. The DB `CHECK` is widened to include `suspend`.
- New row `['updateOffer', 'mutation', 'pools:share', 'pool', 'v1.0']`, the same action as `offer`.
  `pools.updateOffer({ tenantId, poolId, toTenantId, onBudgetExceeded?, allowedRegions?, suspended?: boolean })`.
- `applyBudgetPolicy` for `suspend` does the following:
  - sets `suspended_at`;
  - publishes `quota.budget-suspended`;
  - sets `desired_state = 'stopped'` on the tenant's running instances in the pool, with condition
    `BudgetSuspended`, through the existing `setPower` path so the reconciler stops them;
  - makes admission (`visibleVpsPool` / offers) refuse new work with `SPEND_LIMIT_REACHED` while `suspended_at` is
    set.
- `updateOffer({ suspended: false })` clears `suspended_at` and restarts nothing.
- `allowedRegions` limits instances and reservations on that offer to pools whose site region is in the list.

- [ ] **Step 1: Write the failing tests:**
  - `offer accepts and stores budget policy and regions`.
  - `suspend stops running provider instances and refuses new ones`.
  - `resuming does not restart instances`.
  - `allowedRegions refuses other regions`.
  - `a tenant cannot update an offer`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `capacity: offer budget policies over the API, and suspend`.

### Task 21: Budget checks on every billable path (D16)

**Files:**
- Modify: `packages/vps/src/module.ts` (admission for `instances.attach`, `networks.create`)
- Test: `tests/capacity-offer-budgets.test.ts` (section `paths`)

**Rules:**
- `budgetAdmissionCheck` runs on `instances.attach` when the resulting billing is `metered` or `platform-fee`, and
  on `networks.create` when the pool mode is `metered`.
- A root caller issuing into a tenant is checked against the **tenant's** budgets, not root's: pass `tenantId` =
  target, with no `identityId`.

- [ ] **Step 1: Write the failing tests:**
  - `attach is refused over budget`.
  - `attach with billing none is not budget-checked`.
  - `networks.create is refused over budget`.
  - `a root-issued create checks the target tenant's budget`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `vps: budget checks on attach and networks`.

---

## Phase 8 — Visibility and corrections

### Task 22: Platform usage view (D17)

**Files:**
- Modify: `packages/server/src/api/usage.ts`, `core/src/catalog.ts`
- Docs: `descriptions/api/usage.md`
- Test: `tests/usage-platform.test.ts`

**Interfaces — Produces:**
- The row `['platform', 'read', 'usage:read', 'fleet', 'v1.0']`. `usage:read` is added to the `fleet` kind, as in
  Task 23.
- `usage.platform({ from, to, groupBy: ('tenant' | 'pool' | 'meter' | 'source' | 'provider')[], tenantId?: string,
  format?: 'json' | 'csv' })` returns `{ rows: { keys: Record<string, string>; quantity: number; windows: number;
  outcomes: Record<string, number> }[] }`.
  - The range is ≤ 93 days; rows are ≤ 50 000.
  - Voided windows are excluded and counted separately.
- `usage.list/export` include provider sources for the tenant (they already read `usage_windows`; verify the new
  sources appear).

- [ ] **Step 1: Write the failing tests:**
  - `root sees usage across tenants grouped by tenant and meter`.
  - `a tenant admin is denied usage.platform`.
  - `a tenant's usage.list includes its provider instance windows`.
  - `csv export`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `server: platform usage view for root`.

### Task 23: Dead letters, retry, void (D17, D18)

**Files:**
- Modify: `packages/server/src/api/usage.ts`, `packages/iam/src/worker.ts`, `core/src/catalog.ts`
- Docs: `descriptions/api/usage.md`, `guides/iam/billing-and-usage.mdx` (period close)
- Test: `tests/usage-platform.test.ts` (section `corrections`)

**Interfaces — Produces:**

| Method | Kind | Action | Decided on | Phase |
|---|---|---|---|---|
| `deadLetters` | read | `usage:read` | `fleet` | `v1.0` |
| `retry` | mutation | `usage:manage` | `fleet` | `v1.0` |
| `void` | mutation | `usage:manage` | `fleet` | `v1.0` |

The `fleet` kind gains actions `usage:read` and `usage:manage`, so only root can hold them.

The methods:
- **`usage.deadLetters({ reason?, cursor?, limit? })`** returns dead letters with `{ idempotencyKey, tenantId,
  meter, quantity, windowStart, reason: 'meter-missing' | 'period-closed' | 'identity' | 'invalid' | 'other',
  error }`. The reason is derived from the error code: `NOT_FOUND` on a meter → `meter-missing`;
  `BILLING_PERIOD_CLOSED` → `period-closed`.
- **`usage.retry({ idempotencyKeys | reason })`** clears the outcome so the next flush retries. It refuses
  `period-closed`, because retrying would only fail again; those need a root invoice item in better-iam, and the
  error says so.
- **`usage.void({ idempotencyKeys, reason })`** sets `voided_at` and `void_reason` on windows not yet flushed
  (outcome `NULL`). A flushed window gives `INVALID_STATE` with the hint "issue a credit note in Better IAM".
- **`iam.usage`:** a `BILLING_PERIOD_CLOSED` result is dead-lettered once and never retried automatically.

- [ ] **Step 1: Write the failing tests:**
  - `period-closed dead letter`: close the month in embedded better-iam, then flush a late window; it is listed with
    reason `period-closed` and not retried on later flushes.
  - `meter-missing then retry after syncMeters succeeds`.
  - `void excludes a pending window from the flush`.
  - `void of a flushed window is refused`.
  - `tenants cannot read dead letters`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `server,iam: usage dead letters, retry and void for root`.

---

## Phase 9 — Proof and docs

### Task 24: End-to-end month-close statement

**Files:** Create `tests/billing-month-close.test.ts`. Use the embedded better-iam, the real `gcpProvider` and
`tests/support/gce-emulator.ts`, with `manualClock` across a month boundary.

The scenario, step by step:
1. Root runs `billing.syncMeters`, then sets list prices for `vm.vcpu.hours`, `vm.memory.gib.hours`,
   `vm.gpu.H100.hours`, `vm.instance.hours`, `vm.grant.slot.hours`, `network.vpc.hours`, `ip.public.hours`,
   `disk.pd-balanced.gib.hours` and egress (`reported`).
2. Root sets a negotiated `vm.gpu.H100.hours` price for tenant A and `setTerms` 10 % discount.
3. Root creates a GCP account (root-owned) and a pool, then offers it to A and B.
4. Root attaches a running VM to A. A creates a VM and a network. Root grants 2 reservation slots to A for the month.
5. B creates one VM.
6. The emulator BigQuery export holds egress rows labelled with A's instance.
7. Advance through the month, ticking `vps.provider-usage`, `vps.grants`, `vps.ancillary-usage`, `vps.costs` and
   `iam.usage`. Then run better-iam `closePeriod`.

Assertions:
- A's statement has one line per meter, with quantities equal to the expected hours (computed from the scenario
  timeline in the test).
- The amounts use A's negotiated GPU price and the 10 % discount.
- Egress is cost × multiplier.
- There are no lines from B's usage.
- B's statement has only its own VM.
- Root's own usage is never invoiced.
- `usage.deadLetters` is empty.
- `billing.margins` per tenant equals revenue minus fixture cost.

- [ ] **Step 1:** Write the test. It must fail until Tasks 1–23 are merged; run it after each phase merges to track
  progress.
- [ ] **Step 2:** Run `node node_modules/vitest/vitest.mjs run tests/billing-month-close.test.ts`. Expected: PASS.
- [ ] **Step 3:** Commit with `test: month-close statement for platform-issued compute`.

### Task 25: Docs, legionedge notes, gates

**Files:**
- Rewrite: `apps/docs/content/docs/guides/iam/billing-and-usage.mdx`. It covers:
  - the model (root meters, better-iam rates and invoices);
  - meter catalog, billing modes, grants, pass-through, margins, estimates, enforcement, corrections;
  - period close (D18) and BYO rules.
- Modify: `guides/vps/providers.mdx` (billing section), `packages/provider-gcp/README.md` (`billingExport` setup:
  enabling the detailed export is a manual Cloud Console step; dataset IAM roles; Catalog API), `CHANGELOG.md`
  (Unreleased Added/Changed), `PLAN.md` §12.7 (sources, grants, pass-through, D-numbers).
- Regenerate the API reference (`head-check` + `generate.mjs`, in a clean verify worktree).
- Write the legionedge integration notes (append to the end of this plan when executing, and copy them to legionedge
  `docs/redesign/10-billing.md` through a legionedge session):
  - **Replace** the planned LegionEdge VM metering (`compute_vm_intervals`, `compute_vm_charges`, `vm.instance.hours`
    keyed `vmc:`) with upstream metering. Map `compute_rates` → `billing.setPrices` with `targetTenantId`, and
    flavor meters for per-VM-shape prices.
  - **Keep:** Stripe collection, tax, the admin price-book UI (built on `billing.meters/prices/proposePrices`), the
    margins UI (`billing.margins`), the cost ledger UI (read `provider_costs` through `billing.margins` or a future
    `billing.costs` read API).
  - **Configure:** `vps({ costs: { every: '6h' } })`, `billingExport` on the managed account, and pass-through rules
    for egress and snapshots.
- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** In a clean verify worktree, run:
  - `node node_modules/pnpm/bin/pnpm.mjs -r build`
  - `node node_modules/pnpm/bin/pnpm.mjs lint:repo`
  - `node scripts/authz-matrix.mjs --check`
  - the full suite, split into two halves to stay under the runner timeout

  Expected: green, apart from failures pre-existing on `main`, which must be listed.
- [ ] **Step 3:** Commit with `docs: platform compute billing`.

---

## Follow-ups (separate plans)

- **`include_descendants` for offers and budgets.** This needs a tenant-tree mirror from `iam:tenants:*`. It matters
  for project sub-accounts under an organization.
- **Committed-use discounts.** Ingest GCP CUD credits per reservation into grant margins.
- **Instance-level cost read API.** `billing.costs` for consoles.
- **Other providers.** Hetzner and Proxmox `costs`/`listPrices` implementations.
- **Proration.** Proration of grant fees for partial first hours (today grants bill whole hours from `starts_at`
  rounded down, which is documented).
- **better-iam upstream asks.** Tag-dimensioned prices, which would remove the need for per-flavor meters;
  `recordMany` with `enforceBudgets`; and a push event on budget exhaustion.

---

## Legionedge integration notes

Written at Task 25 against the merged branch (`feat/platform-compute-billing`, every billing phase in). Copy this
section to legionedge `docs/redesign/10-billing.md` through a legionedge session; nothing here changes a legionedge
file by itself. Names are the code's, which differ from the plan text above in places (see the SDD ledger's
rulings): for example estimates are `instances.estimate`, not `instances.create({ dryRun })`, and the deployment
currency is `vps({ billing: { currency } })`.

### What upstream now does

- better-compute meters every compute resource the platform issues to a tenant: provider VMs created or attached
  (lifecycle intervals, `vps.provider-usage`), reservation grants (`vps.grants`), tenant networks and sandbox
  snapshots (`vps.ancillary-usage`), public addresses and disks (lines of the VM's intervals), and provider
  pass-through costs (`vps.costs`). All of it lands in `usage_windows` and reaches better-iam through the one
  `iam.usage` flush, attributed to the tenant (and owner) the resource was issued to.
- better-iam stays the only place prices, statements, terms, credits and budgets live. Root manages compute's
  prices through the root-only `billing` API group (`meters`, `syncMeters`, `prices`, `setPrices`,
  `proposePrices`, `margins`).
- BYO cloud accounts (a tenant's own GCP project) default to `platform-fee`: at most `vm.managed.hours`, never
  `vm.*` compute, and their costs are never passed through or counted in margins.

### Replace

- **Drop the planned LegionEdge VM metering:** `compute_vm_intervals`, `compute_vm_charges` and the
  `vm.instance.hours` events keyed `vmc:`. Upstream already records `vm.instance.hours` (and the vCPU, memory, GPU,
  address and disk meters) for the same VMs under `cmp:instance:<id>:<windowStartMs>:<meter>`; a second,
  `vmc:`-keyed writer on the same meter would bill every VM twice. If any `vmc:` usage was already recorded, cut
  over at a month boundary: stop the LegionEdge writer, let its last month close, and run upstream metering from the
  next month. Upstream meters hours from each VM's intervals as they are observed; it does not backfill hours before
  the upgrade.
- **`compute_rates` → `billing.setPrices`.** A list rate is `{ meter, effectiveFrom: 'YYYY-MM', spec }`; a
  negotiated rate for an organization adds `targetTenantId` (the org's tenant; it applies to its subtree). Specs
  are better-iam `PriceSpec`s in micros (`per-unit`, `graduated`, `volume`, `package`). At most 100 prices per
  call; partial failures come back in `failed`.
- **Per-VM-shape rates → flavor meters.** better-iam prices cannot vary by tag, so a price per machine shape (or per
  shape and region) is a flavor meter: `flavors.update` with `billing: { meter: 'flavor.a3-highgpu-8g.us-central1.hours' }`
  (root only; created on the root tenant when the IAM port can define meters), then `setPrices` on that meter. It
  replaces the composed vCPU, memory, GPU and instance lines for that flavor's VMs; disks and addresses still bill.
  Mind better-iam's 100 meters per tenant (the default catalog stays under 90).
- **Free or written-off VMs:** `instances.attach({ billing: 'none' })` (root only) instead of a zero rate.
- **Committed capacity:** `reservationGrants.create` (root) instead of LegionEdge-side commitment charges. The
  grantee pays `vm.grant.slot.hours` per committed slot, used or not; price `vm.grant.usage.hours` at 0.

### Keep (LegionEdge-side)

- **Stripe collection and tax.** better-iam closes the month into statements; LegionEdge collects them through
  Stripe and applies tax as today.
- **The admin price-book UI,** built on `billing.meters` (catalog and `missing`), `billing.prices`,
  `billing.proposePrices` (provider list price plus a margin, never applied) and `billing.setPrices`. All are
  `compute:billing:*` on `compute-fleet`, so only root members holding those actions can call them.
- **The margins UI,** on `billing.margins({ from, to, groupBy: 'tenant' | 'pool' | 'account' | 'meter' })`.
  Revenue comes from better-iam spend (whole billing periods; the answer's `from`/`to` are the range both cover),
  cost from the platform's own provider accounts. Compute cost has no meter dimension: use the tenant or pool view
  for compute margins and the meter view for pass-through.
- **The cost ledger UI.** Upstream has no row-level cost read API yet: read `provider_costs` aggregates through
  `billing.margins`, or wait for the planned `billing.costs` read API (Follow-ups). Drive alerts from the events
  `billing.cost-corrected` (`passedThrough: true` means issue a credit note in better-iam), `billing.leak` (a
  metering gap) and `billing.unattributed` (cost with no tenant: label the resource `better-compute-tenant=<tenant>`).
- **Credits, credit notes and invoice items** stay manual root actions in better-iam (root admin user session with
  MFA). Upstream points to them: `usage.void` refuses recorded usage with "issue a credit note in Better IAM", and
  `period-closed` dead letters need a `billing.createInvoiceItem`.

### Configure

```ts
bridge.embedded(iam, {
  rootTenantId,
  serviceCredential: { token: rootBillingServiceAccountKey }, // iam:billing:manage + iam:billing:read on root
  runIamJobs: { only: ['iam.jobs.audit-hooks', 'iam.jobs.auth-outbox', 'iam.jobs.budgets', 'iam.jobs.sweep'] },
});
vps({
  providers: [gcp],
  billing: { currency: 'USD', gpuModels: ['H100', 'H200', 'B200', 'A100', 'L4', 'L40S'] }, // as in the bridge
  costs: { every: '6h' }, // lookbackDays 3 and leakToleranceHours 1 by default
});
```

- **Currency:** `vps({ billing: { currency } })` is the one knob; set it to better-iam's deployment currency.
- **Meters:** run `billing.syncMeters` once, and again after adding GPU models or flavor meters. Create the
  `reported` pass-through meters on the root tenant yourself (better-iam `billing.createMeter` with
  `pricing: 'reported'`, or the port's `ensureMeters`), for example `network.egress.gib` and `storage.snapshot.gib`.
- **`billingExport` on the managed (root) GCP account:** turn on the **detailed** usage cost export in the Cloud
  Console (a manual step), grant the account's service account `roles/bigquery.dataViewer` on the export dataset
  and `roles/bigquery.jobUser` on the export's project, then set `billingExport` to
  `<project>.<dataset>.gcp_billing_export_resource_v1_<BILLING_ACCOUNT_ID>` (and `billingExportLocation`) with
  `providerAccounts.update`. Enable the Cloud Billing API in the credential's project for `proposePrices`. Check the
  first jobs' bytes processed: the query filters on `usage_start_time`, which may not prune the export's partitions
  (see the provider-gcp README).
- **Pass-through rules for egress and snapshots** on the same account, for example
  `billing: { passThrough: [{ skuPattern: 'egress', meter: 'network.egress.gib', multiplier: 1.2 }, { skuPattern: 'Storage PD Snapshot', meter: 'storage.snapshot.gib', multiplier: 1.1 }] }`.
  Patterns that match SKUs compute meters itself (core, RAM, GPU, instance, persistent disk and Hyperdisk capacity,
  local SSD, external IP) are refused. Check the SKU descriptions against a few days of the real export before
  choosing patterns.
- **Budgets:** set each organization's offer policy with `pools.updateOffer` (`onBudgetExceeded: 'suspend'`, or
  `stop-new`, `drain`, `notify`) instead of SQL; `suspend` stops the org's running VMs in that pool within a minute.
- **Month close:** schedule better-iam `closePeriod()` at least 6 hours after each month ends (the `only` list above
  leaves the daily job out), check the iam doctor's `iam.usage-backlog` before it, and watch `usage.deadLetters`
  after it.
- **Tenant estimates:** consoles show the `estimate` of `flavors.list` items and call `instances.estimate` before a
  create.
