# GCP: attach running VMs to tenants, detect reservations, tenant networks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can attach an already-running Google Compute Engine VM to a customer (tenant) account, so that
the customer controls it (status, start/stop/reboot, detach or delete) and builds networks, subnets and firewall rules
around it through the better-compute API that the legionedge console calls. Background workers discover the VMs in
each GCP provider account and detect its Compute Engine reservations, then expose those reservations as capacity
that can be spun up.

**Architecture:** A new `@better-compute/provider-gcp` package implements `ProviderImpl` against the Compute Engine
REST API v1 with plain `fetch`, as `provider-hetzner` does. All new control-plane behavior lives in `@better-compute/vps`,
which already owns provider accounts, provider pools, instances and the provider reconcilers:

- **Three new reconcilers (the "workers"):** `vps.discovery`, `vps.reservations` and `vps.networks`.
- **Three new tables:** `provider_machines`, `provider_reservations`, and the network tables.
- **New API methods:** `instances.attach`, `instances.detach`, `instances.reboot`; `providerAccounts.machines`,
  `discover`, `reservations`, `bindReservation`, `unbindReservation`; and new `networks` and `firewallRules` groups.

Attaching an instance reuses a path the provider reconciler already has: a `scheduling` row with an `external_id`
skips `create` and adopts the machine (`packages/vps/src/lifecycle.ts:335-344`).

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), pnpm workspace, vitest on PGlite, Standard-Schema manifests
(`manifest`/`field` from `@better-compute/core`), Compute Engine REST v1. No new npm dependencies.

**Spec:** No separate spec file. The requirements are the user's request of 2026-10-17, restated in "Requirements"
below, plus the codebase findings in "Current state". legionedge's own design (`../legionedge/docs/redesign/11-compute.md`,
`12-gcp-hosted-compute.md`, `work/P-gcp.md`) is context, not scope.

---

## Requirements (from the request)

1. **R1 Attach.** Attach GCP VMs that are already running to a customer/tenant account, without recreating them.
2. **R2 Create.** Create new GCP VMs for a tenant through the same provider (normal `instances.create` on a GCP-backed
   provider pool).
3. **R3 Customer control.** The tenant controls an attached VM like any of its instances: get/list, start, stop,
   reboot, and delete or detach.
4. **R4 Networks.** The tenant creates and manages networks (VPC), subnets and firewall rules, and puts its VMs on them.
5. **R5 Discovery worker.** A background worker keeps an up-to-date list of the VMs in each GCP account, with which
   ones are attached and to whom.
6. **R6 Reservation worker.** A background worker automatically detects Compute Engine reservations, both on-demand
   and future/calendar, with their free slots. An operator can expose a reservation as spin-up-able capacity in a
   pool. Creating an instance then consumes the reservation, and the database refuses to over-commit it.
7. **R7 Console-ready.** Everything is reachable through the typed API, client, CLI and MCP, which the legionedge
   console already uses through `instances.*` and `providerAccounts.*`.

## Current state (verified 2026-10-17)

- **Provider contract.** `ProviderImpl` is in `packages/core/src/extension.ts:665-702` and `defineProvider` in
  `packages/vps/src/provider.ts:25`. `list?()` is declared there but no control-plane code calls it.
  `ExternalMachine` (`extension.ts:629-644`) has no zone, shape, labels or GPU fields.
- **Provider pools.** A `class:'provider'`, `agent:'none'` pool has `pools.provider_account_id`. Its instances are
  `instances` rows with `provider_account_id` and `external_id`, reconciled by `reconcileProvider`
  (`lifecycle.ts:357-503`), which polls `get` every 60 s. `instances.delete` always calls `provider.delete`.
- **No attach API.** `instances.flavor_id` and `image_id` are `NOT NULL` (`vps/src/migrations.ts:60-97`).
- **No networks.** There is no network resource kind or API anywhere. `ipam.ts` covers only hosted vps-host pools.
- **Capacity.** Capacity only counts devices on `nodes`. `Offer.available` is a boolean with no count, so nothing
  models GCP reservations.
- **Tenancy.**
  - Only root callers act cross-tenant (`server/src/operations.ts:371-375`).
  - A root-created instance has the operator as `owner_identity_id`, so the customer's default `scope:'mine'`
    list hides it.
  - Root-owned provider accounts can back root pools that are offered to customers (`pools.offer`). This is the
    pattern legionedge uses (`syncManagedCatalog`).
- **Background work.** Background work is a `Reconciler` on a module, run on the coalescing `work_queue`. Periodic
  work uses `periodic: [{ key, every }]`. Provider calls happen outside transactions, then the results are written in
  short fenced transactions (`vps/src/bootstraps.ts:375-529` is the model to copy).
- **Tests.** Tests live in root `tests/*.test.ts`. Providers are tested against an in-memory emulator through an
  injected `fetch`, plus `runConformance(providerConformanceCases(), …)` (`tests/provider-hetzner.test.ts`). Module
  tests use `pglite` + `manualClock` + `useSimClock` and `compute.jobs.<name>.tick()` (`tests/vps-bootstraps.test.ts`,
  `tests/server-runtime-jobs.test.ts`).

## Design decisions

| # | Decision | Why |
|---|---|---|
| D1 | All generic behavior goes upstream in better-compute (`vps` + `provider-gcp`). Landing zones and per-tenant projects stay in legionedge. | legionedge embeds `betterCompute()`, so it gets these methods for free. The per-tenant project model is legionedge policy. |
| D2 | `provider-gcp` uses the REST API with no dependencies. Tokens come from a `TokenSource`: a service-account key (RS256 JWT via `node:crypto`), the GCE/GKE metadata server, an optional impersonation hop (`iamcredentials…:generateAccessToken`), or a host-supplied `tokenSource` option. | Matches `provider-hetzner`, and coordination rules forbid new deps without the orchestrator. legionedge can pass its `google-auth-library` client (WIF) as `tokenSource`. |
| D3 | `ExternalMachine.id` is `"<zone>/<name>"`. A plain offer id is `"<zone>/<machineType>"`. A reservation offer id is `"<zone>/<machineType>@<reservation>"`, where `<reservation>` is a bare name or `projects/<owner>/reservations/<name>` for shared reservations. | GCE's instance get and delete calls need zone + name. The reservation suffix lets `create` set `reservationAffinity` from the offer alone, so the existing flavor→offer path needs no new plumbing. |
| D4 | Ownership labels: `better-compute-managed=true` on VMs we create, and `better-compute-instance=<instanceId>` on VMs we create or attach. The provider refuses `delete`, `power` and `setTags` on a VM missing the right label (`INVALID_STATE`). | Mirrors Proxmox's `#managed` tag guard. An attached VM is never deleted by accident, and a stale instance row cannot touch a VM someone else re-attached. |
| D5 | Attach writes an `instances` row (`origin='attached'`) in the provider pool, in state `scheduling` with `external_id` set. The reconciler then labels it (`claim`) and adopts it. A partial unique index on `(provider_account_id, external_id)` refuses a double attach. | Reuses `reconcileProvider`. The database referees ownership, as it does for bookings. |
| D6 | Each attached instance has `on_delete`: `'detach'` (default for attach) or `'delete'` (default for create). `instances.detach` always detaches. Detaching removes the label, refunds quota and drops authz, and the VM keeps running in GCP. | Satisfies R3 without letting a customer destroy a VM the operator only lent them. The operator picks `'delete'` at attach time to hand over full ownership. |
| D7 | `attach` takes `ownerIdentityId?`, defaulting to the caller. | Without it a root-attached VM is invisible in the customer's default `scope:'mine'` list. |
| D8 | Discovery is a per-account worker that writes `provider_machines` and only reads GCP; it never attaches. Auto-attach is opt-in through `vps({ discovery: { autoAttach } })` and GCP labels, and limited to the account's own tenant or a root-owned account. | Keeps the worker safe by default. Label-driven auto-attach covers "automatically" without a rules engine. |
| D9 | The reservation worker writes `provider_reservations` (total, in use, observed time). Binding a reservation to a provider pool creates a flavor whose `offerId` is the reservation offer. Admission locks the reservation row (`FOR UPDATE`) and refuses with `CAPACITY_UNAVAILABLE` when `total − inUse − pending < 1`. | Reservations become spin-up-able capacity through the existing flavor → `instances.create` path, and the DB refuses over-commit between polls. |
| D10 | Networks are a new `network` resource kind owned by a tenant and tied to one provider pool's account. Firewall rules are their own `firewallRules` group with resource kind `network`. Subnets are methods on `networks` (`addSubnet`/`removeSubnet`). A `vps.networks` reconciler converges them through a new optional `ProviderImpl.networks`. | Two groups and one kind instead of three keeps the IAM catalog small. GCP firewall rules belong to a network, so `network` is the natural authz parent. |
| D11 | Firewall rules target instances, not raw tags. The reconciler gives each targeted instance the network tag `bc-<sha256(instanceId)[0:16]>` and compiles targets to `targetTags`. | Tenants never see or forge GCP tags. The tag is stable and fits GCE's 63-character limit. |
| D12 | New API rows use `ApiPhase` `'v1.0'` and module `'vps'`. | `ApiPhase` is a closed union (`catalog.ts:278`), so this avoids a core-type change. |
| D13 | Out of scope: bcd joining on GCE (cloud-iid in the Go daemon), GPU `reservations.create` on provider pools spinning up VMs (elastic nodes), serial console/SSH-key injection, and legionedge UI. | Each is a separate subsystem. They are listed as follow-ups at the end. |

## Global Constraints

- Node ≥ 22.12, ESM only. Every package imports its own `.js` paths.
- **Core is frozen.** `@better-compute/core` changes only by **additive** optional members
  (`.claude/coordination.md`). Never change an existing member's type.
- **Dependency rules** (`scripts/check-deps.mjs`):
  - `provider-gcp` depends only on `@better-compute/core` and `@better-compute/vps`.
  - Nothing in `packages/` imports `provider-gcp`.
  - Not added to `packages/better-compute/umbrella.json`.
- **New package registration.** Add one-line inserts only: `tsconfig.json` references, the `vitest.config.ts`
  `scoped` map, and `pnpm install` (via `node node_modules/pnpm/bin/pnpm.mjs install`) to link it. Ask the
  orchestrating session before running install if other agents are active.
- **SQL.** SQL uses `compute_now()`, never `now()` (`scripts/check-sql-now.mjs`).
- **Migrations.**
  - Names are `vps/00NN_<slug>`, strictly increasing. The next free numbers are `vps/0023` … `vps/0026`.
  - Migrations are additive (`ALTER … ADD`, `DROP NOT NULL`, new tables).
- **Provider calls.** No provider calls inside a transaction. A reconciler run stays under `claimTtlMs` (60 s). Long
  GCE operations are polled across runs with `enqueue(…, { notBefore })`, not awaited in-run.
- **Secrets.** Secrets are refs only (`field.secret()`; `assertNoInlineSecrets`). Never log an access token or a key.
- **Events.** New event types match `area.name`, and each family gets a row in `packages/events/src/catalog.ts`.
- **API surface.**
  - Every new method gets a row in `packages/core/src/catalog.ts` `apiSurface`, phase `'v1.0'`.
  - Its description goes in `apps/docs/descriptions/api/<group>.md`.
  - Regenerate with `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .` after the API is final.
- **Labels.** GCE label keys and values are `[a-z0-9_-]`, at most 63 chars. Instance ids are lowercase
  (`ins_…`) and fit as-is.
- **Formatting.** Format only files you touched (`prettier --write <files>`). Announce full `vitest run`s.
- **Commits.** End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Attach race against discovery or another attach.** Two operators attach the same VM, or attach lands while
   discovery marks it `gone`. Exactly one instance owns the VM. The second attach gets `CONFLICT`, and a `gone`
   machine refuses attach with `NOT_FOUND`. *Test: Task 9, `refuses a second attach of the same machine`, and
   `refuses attaching a machine discovery marked gone`.*
2. **The VM is deleted or stopped out-of-band in GCP.** The attached instance moves to `lost` (deleted) or
   `reported_state` stopped, and is never recreated. The reconciler must not call `create` for `origin='attached'`.
   *Test: Task 10, `an attached instance whose VM vanished goes lost, never recreated`.*
3. **Reservation over-commit between polls.** The reservation has one free slot and two `instances.create` calls
   arrive inside one 5-minute poll window. One is admitted and the other gets `CAPACITY_UNAVAILABLE`.
   *Test: Task 14, `admits only the free slots between polls`.*
4. **Customer deletes an attached VM.** The default `on_delete='detach'` releases the label and leaves the GCP VM
   running, and the provider's `delete` is never called. *Test: Task 10, `delete of an attached instance detaches by
   default`.*
5. **Deleting a network still in use.** `networks.delete` with instances on it, or with rules mid-delete, is refused
   with `INVALID_STATE`, naming the instances. The reconciler deletes rules, then subnets, then the network, and
   survives GCE's `resourceInUseByAnotherResource`. *Test: Task 17, `refuses deleting a network with instances on
   it`, and Task 18, `deletes rules then subnets then the network`.*

---

## File structure

**New package `packages/provider-gcp/`** (copy `packages/provider-hetzner/{package.json,tsconfig.json,LICENSE}` and
change the names):

| File | Responsibility |
|---|---|
| `src/index.ts` | Re-exports. |
| `src/config.ts` | The `GcpConfig` manifest and `GcpProviderOptions`. |
| `src/auth.ts` | `TokenSource`, `serviceAccountTokenSource`, `metadataTokenSource`, `impersonatedTokenSource`, token cache. |
| `src/client.ts` | `GceClient`: authorized JSON requests, error mapping, pagination, operation polling. |
| `src/ids.ts` | Parse and format machine ids, offer ids, label sanitizing, network tags, `requestIdFor(key)` (UUIDv5). |
| `src/shapes.ts` | Machine type → `Offer`, accelerator type → GPU model, GCE instance → `ExternalMachine`. |
| `src/compute.ts` | `listOffers`, `create`, `get`, `delete`, `power`, `list`, `discover`, `claim`, `release`. |
| `src/reservations.ts` | `listReservations` (on-demand + future reservations) → `ExternalReservation`. |
| `src/networks.ts` | The `ProviderNetworks` implementation (networks, subnetworks, firewalls, instance tags). |
| `src/provider.ts` | `gcpProvider(options)` and `export const gcp = gcpProvider()`. |
| `README.md` | Configuration, IAM roles needed, labels, attach semantics. |

**`packages/core/src/`**
- `extension.ts`: additive provider types.
- `catalog.ts`: new kind `network`, new actions, `apiSurface` rows.

**`packages/vps/src/`** (each new file owns its migration, as `bootstraps.ts` does):

| File | Responsibility |
|---|---|
| `discovery.ts` | `vps/0023_provider_machines`, the `vps.discovery` reconciler, `providerAccounts.machines/discover`, auto-attach. |
| `attach.ts` | `vps/0024_instance_attach`, `instances.attach/detach/reboot` handlers. |
| `provider-reservations.ts` | `vps/0025_provider_reservations`, the `vps.reservations` reconciler, `providerAccounts.reservations/bindReservation/unbindReservation`, admission helper `claimReservationSlot`. |
| `networks.ts` | `vps/0026_networks`, the `vps.networks` reconciler, `networks.*`, `firewallRules.*`. |
| `lifecycle.ts` | Modify: attached-instance branches in `providerAction`/`reconcileProvider`, plus reboot. |
| `instances.ts` | Modify: `networkId`/`subnetId` on create, reservation admission in `completeCreateInstance`. |
| `module.ts` | Modify: register the reconcilers, API methods, migrations and options. |
| `conformance.ts` | Modify: optional cases for `discover`, `claim`/`release`, `listReservations`. |
| `index.ts` | Export new public types. |

**`packages/events/src/catalog.ts`:** add families `provider.machine.*`, `provider.reservation.*`, `network.*`
(`instance.*` already covers `instance.attached`/`instance.detached`).

**Tests (root `tests/`):**

| File | Covers |
|---|---|
| `support/gce-emulator.ts` | Shared in-memory Compute Engine emulator (not collected: no `.test.ts`). |
| `provider-gcp.test.ts` | Auth, client, compute and conformance. |
| `provider-gcp-reservations.test.ts` | The provider's reservation mapping. |
| `provider-gcp-networks.test.ts` | The provider's network implementation. |
| `vps-discovery.test.ts` | Discovery worker + auto-attach. |
| `vps-attach.test.ts` | Attach, detach, reboot, on-delete. |
| `vps-provider-reservations.test.ts` | Reservation worker, bind, admission. |
| `vps-networks.test.ts` | Network API + reconciler. |

**Docs:**
- `apps/docs/descriptions/api/{instances,providerAccounts,networks,firewallRules}.md`
- `apps/docs/content/docs/guides/vps/providers.mdx` (GCP section)
- `CHANGELOG.md`

---

## Phase 0 — Setup

### Task 0: Branch, claim, baseline

**Files:**
- Modify: `.claude/coordination.md`, adding one claim row.

- [ ] **Step 1:** Confirm you are on branch `feat/gcp-attach-reservations`, created from `main`.
- [ ] **Step 2:** Add a claim line to `.claude/coordination.md` naming the new package `packages/provider-gcp/**`, the
  new vps files above, and the symbols `ProviderImpl.discover|claim|release|listReservations|networks`,
  `ExternalMachine` optional fields, `apiSurface` rows `instances.attach|detach|reboot`, `providerAccounts.machines|
  discover|reservations|bindReservation|unbindReservation`, `networks.*`, `firewallRules.*`. Message the orchestrator
  about the additive core edit.
- [ ] **Step 3:** Run the baseline.
  - Command: `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-hetzner.test.ts tests/vps-bootstraps.test.ts`
  - Expected: PASS. Record any pre-existing failures before you change anything.
- [ ] **Step 4: Commit:** `chore: claim GCP attach/reservations/networks area`.

---

## Phase 1 — Contracts and the GCP provider

### Task 1: Additive provider contract in core

**Files:**
- Modify: `packages/core/src/extension.ts` (after `ExternalMachine`, ~L644, and in `ProviderImpl`, ~L665-702)
- Modify: `packages/core/src/index.ts` (export the new types)
- Modify: `packages/vps/src/provider.ts` (no change to the allowed keys; confirm `defineProvider` still freezes)
- Modify: `packages/vps/src/conformance.ts` (optional cases)
- Test: `tests/provider-contract-extensions.test.ts`

**Interfaces — Produces** (exact; all new members optional):

```ts
// ExternalMachine gains (all optional; providers that do not know them omit them):
zone?: string; machineType?: string; vcpu?: number; memoryGiB?: number;
gpus?: { model: string; count: number };
labels?: Readonly<Record<string, string>>;
networks?: readonly { network: string; subnet?: string; address?: string; publicAddress?: string; tags?: readonly string[] }[];
/** The provider reservation this machine consumes, as a reservation id (see ExternalReservation.id). */
reservation?: string;
createdAt?: number;
/** The better-compute instance id the provider's ownership label names, if any. */
claimedBy?: string;

export interface ExternalReservation {
  id: string;                 // "<zone>/<name>" or "projects/<owner>/zones/<zone>/reservations/<name>" when shared in
  name: string; zone: string; region: string;
  state: 'scheduled' | 'creating' | 'ready' | 'updating' | 'deleting' | 'error';
  machineType: string; vcpu: number; memoryGiB: number;
  gpus?: { model: string; count: number };
  localSsdGiB?: number;
  total: number;              // specificReservation.count (future: totalCount)
  inUse: number;              // specificReservation.inUseCount (future: 0)
  specificOnly: boolean;      // specificReservationRequired
  shared: boolean;
  startsAt?: number; endsAt?: number;   // future/calendar reservations; deleteAtTime for on-demand
  offerId: string;            // "<zone>/<machineType>@<name|projects/<owner>/reservations/<name>>"
}

export interface NetworkRef { network: string; subnet?: string; tags?: readonly string[] }

export interface ProviderNetworkSpec { name: string; description?: string; mtu?: number }
export interface ProviderSubnetSpec { network: string; name: string; region: string; cidr: string; privateGoogleAccess?: boolean }
export interface ProviderFirewallSpec {
  network: string; name: string; direction: 'ingress' | 'egress'; action: 'allow' | 'deny'; priority: number;
  rules: readonly { protocol: 'tcp' | 'udp' | 'icmp' | 'all'; ports?: readonly string[] }[];
  sources?: readonly string[]; destinations?: readonly string[]; targetTags?: readonly string[]; disabled?: boolean;
}
export interface ProviderNetworkState { id: string; state: 'pending' | 'ready' | 'deleting' | 'deleted' | 'error'; message?: string }

export interface ProviderNetworks {
  ensureNetwork(spec: ProviderNetworkSpec, context: CallContext): Promise<ProviderNetworkState>;
  ensureSubnet(spec: ProviderSubnetSpec, context: CallContext): Promise<ProviderNetworkState>;
  ensureFirewall(spec: ProviderFirewallSpec, context: CallContext): Promise<ProviderNetworkState>;
  deleteNetwork(name: string, context: CallContext): Promise<ProviderNetworkState>;
  deleteSubnet(region: string, name: string, context: CallContext): Promise<ProviderNetworkState>;
  deleteFirewall(name: string, context: CallContext): Promise<ProviderNetworkState>;
  /** Replaces the tags this provider manages (prefix `bc-`) on a machine; keeps every other tag. */
  setTags(machineId: string, tags: readonly string[], context: CallContext): Promise<void>;
}

// ProviderImpl gains:
discover?(context: CallContext): AsyncIterable<ExternalMachine>;      // every machine the account can see
/** Write the ownership label; with managed, also `better-compute-managed=true` (hands deletion to better-compute). */
claim?(id: string, instanceId: string, context: CallContext, options?: { managed?: boolean }): Promise<ExternalMachine>;
release?(id: string, instanceId: string, context: CallContext): Promise<void>;            // remove it if it names instanceId
listReservations?(context: CallContext): Promise<ExternalReservation[]>;
networks?: ProviderNetworks;

// The create request gains optional members (existing callers unaffected):
create(request: { offerId: string; image: ImageRef; userData: string; name: string;
  network?: NetworkRef; labels?: Readonly<Record<string, string>> }, context: CallContext): Promise<ExternalMachine>;
```

`ensure*` and `delete*` are idempotent and non-blocking. They return `pending` while a GCE operation runs, and the
reconciler calls them again later.

**Interfaces — Produces in `conformance.ts`:**
- `ProviderConformanceSubject` gains `attachable?: string` (a machine id the subject can claim and release).
- Cases are added: `claim then release round-trips the label` (skipped without `claim`/`attachable`), and
  `discover yields the attachable machine` (skipped without `discover`).

- [ ] **Step 1: Write the failing test** `tests/provider-contract-extensions.test.ts`:
  - `defineProvider accepts a provider with discover, claim, release, listReservations and networks`: build one with
    stubs, then assert `Object.isFrozen(def)` and that `typeof (await def.create(cfg, ctx)).discover === 'function'`.
  - `conformance skips claim and discover cases for providers without them`: run `providerConformanceCases()` on an
    inline Hetzner-like fake. Assert every case passes or is skipped, and that the case names include
    `'claim then release round-trips the label'`.
- [ ] **Step 2: Run to fail.**
  - Command: `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-contract-extensions.test.ts`
  - Expected: FAIL. TypeScript/vitest reports an unknown property or a missing case name.
- [ ] **Step 3: Implement.** Add the types above to `extension.ts`, export them, and add the two conformance cases.
- [ ] **Step 4: Run to pass.** Run the same command, plus `tests/provider-hetzner.test.ts` and
  `tests/provider-proxmox.test.ts` (no regressions). Expected: PASS.
- [ ] **Step 5:** Run `node node_modules/pnpm/bin/pnpm.mjs -r exec tsc -b --noEmit` on core and vps. Expected: exit 0.
- [ ] **Step 6: Commit:** `core: optional provider discover/claim/release/listReservations/networks (additive)`.

### Task 2: provider-gcp scaffold, auth and REST client

**Files:**
- Create: `packages/provider-gcp/{package.json,tsconfig.json,LICENSE,README.md}` and
  `src/{index,config,auth,client,ids}.ts`
- Modify (one-line inserts):
  - root `tsconfig.json`: add `{ "path": "./packages/provider-gcp" }`
  - `vitest.config.ts` `scoped`: add `'@better-compute/provider-gcp': 'provider-gcp/src/index.ts'`
- Create: `tests/support/gce-emulator.ts`
- Test: `tests/provider-gcp.test.ts` (section `auth & client`)

**Interfaces — Produces:**

```ts
// config.ts
export interface GcpConfig {
  projectId: string;                 // field.string()
  zones: string[];                   // field.list(field.string()) — at least one; offers and discovery are limited to these
  credentials?: SecretRef;           // field.secret().optional() — service-account key JSON; absent ⇒ metadata server
  impersonate?: string;              // field.string().optional() — target service-account email
  network?: string;                  // field.string().default('default') — used by create when no NetworkRef is given
  subnet?: string;                   // field.string().optional()
  imageProject?: string;             // field.string().default('ubuntu-os-cloud')
  diskGiB?: number;                  // field.int().default(100)
  discoverLabel?: string;            // field.string().optional() — "key=value": discover() yields only matching VMs
}
export interface GcpProviderOptions {
  fetch?: typeof fetch;
  endpoint?: string;                 // default 'https://compute.googleapis.com/compute/v1'
  tokenSource?: TokenSource;         // overrides credentials/metadata (legionedge passes its WIF client here)
  operationPollMs?: number;          // default 2000 — only used by in-call waits ≤ 20 s
}

// auth.ts
export interface TokenSource { token(context: { signal: AbortSignal; clock: Clock }): Promise<string> }
export function serviceAccountTokenSource(keyJson: string, options?: { fetch?: typeof fetch; scopes?: string[] }): TokenSource;
export function metadataTokenSource(options?: { fetch?: typeof fetch }): TokenSource;
export function impersonatedTokenSource(base: TokenSource, targetEmail: string, options?: { fetch?: typeof fetch }): TokenSource;
export function cachedTokenSource(inner: TokenSource, skewMs?: number): TokenSource;   // default skew 60_000

// client.ts
export interface GceClient {
  request<T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string,
    options: { body?: unknown; query?: Record<string, string>; signal: AbortSignal }): Promise<T>;
  pages<T>(path: string, field: string, options: { query?: Record<string, string>; signal: AbortSignal }): AsyncIterable<T>;
  aggregated<T>(path: string, field: string, options: { query?: Record<string, string>; signal: AbortSignal }): AsyncIterable<T>;
}
export function gceClient(options: { fetch: typeof fetch; endpoint: string; projectId: string; tokens: TokenSource }): GceClient;

// ids.ts
export function machineId(zone: string, name: string): string;            // "zone/name"
export function parseMachineId(id: string): { zone: string; name: string };  // INVALID_INPUT otherwise
export function offerId(zone: string, machineType: string, reservation?: string): string;
export function parseOfferId(id: string): { zone: string; machineType: string; reservation?: string };
export function instanceName(instanceId: string): string;                 // "bc-" + lowercase id, [a-z0-9-], ≤ 63
export function labelValue(value: string): string;                        // lowercase, [a-z0-9_-], ≤ 63
export function networkTag(instanceId: string): string;                   // "bc-" + sha256(instanceId).hex.slice(0,16)
export function requestIdFor(idempotencyKey: string): string;            // UUIDv5 over a fixed namespace
export const labels = { managed: 'better-compute-managed', instance: 'better-compute-instance',
  tenant: 'better-compute-tenant', pool: 'better-compute-pool', owner: 'better-compute-owner' } as const;
```

**Error mapping** (`client.ts`). GCE errors are `{ error: { code, message, errors: [{ reason }] } }`:

| GCE response | ComputeError |
|---|---|
| 404 | `NOT_FOUND` |
| 409 `alreadyExists` | `CONFLICT` |
| 409 `resourceInUseByAnotherResource` | `INVALID_STATE` |
| 429, or 403 `rateLimitExceeded`/`userRateLimitExceeded` | `RATE_LIMITED` (`retryAfterMs` from `Retry-After`, else 10 000) |
| 403 `quotaExceeded` | `QUOTA_EXCEEDED` |
| other 403 | `ACCESS_DENIED` |
| 400 | `INVALID_INPUT` |
| 5xx, or `ZONE_RESOURCE_POOL_EXHAUSTED` in an operation error | `CAPACITY_UNAVAILABLE` (5xx → `UNAVAILABLE`) |
| anything else | `PROVIDER_ERROR` |

Every error carries `details: { provider: 'gcp', status, reason }`.

**Emulator** (`tests/support/gce-emulator.ts`): `class GceEmulator { fetch: typeof fetch; … }`.
- **State it holds:** `instances` keyed by `zone/name`, `machineTypes`, `reservations`, `futureReservations`,
  `networks`, `subnetworks`, `firewalls` and `operations`.
- **Hooks:** `failNext`, `operationDelayTicks` (operations stay `RUNNING` for N GETs) and `requests[]`.
- **Endpoints it serves:**
  - `instances` insert/get/delete/start/stop/reset/setLabels/setTags/aggregatedList, honoring `requestId` dedupe and
    `labelFingerprint` (412 on a stale fingerprint)
  - `machineTypes` aggregatedList
  - `reservations` aggregatedList
  - `futureReservations` aggregatedList
  - `networks`, `subnetworks` and `firewalls` insert/get/delete
  - `zoneOperations`, `regionOperations` and `globalOperations` get
  - `oauth2.googleapis.com/token`
  - `metadata.google.internal/…/token`
  - `iamcredentials…:generateAccessToken`
- **Pagination:** `maxResults`=2 by default, to exercise paging.

- [ ] **Step 1: Write the failing tests** in `tests/provider-gcp.test.ts`, under `describe('auth & client')`:
  - `service-account key mints a bearer token and caches it until expiry`: two requests make one POST to `/token`.
    Advance the clock by 3600 s and a second POST happens.
  - `metadata token source sends Metadata-Flavor: Google`
  - `impersonation exchanges the base token for the target's`: the request goes to
    `…/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken` and the returned token is used.
  - `maps GCE errors to ComputeError codes`: a table test over the mapping above.
  - `pages and aggregated iterate every page`: 5 instances across 3 zones with `maxResults` 2 yields 5.
  - `ids round-trip`: `parseOfferId(offerId('us-central1-a','a3-highgpu-8g','projects/o/reservations/r'))` deep-equals
    the input. `instanceName('ins_01JZ…')` matches `/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/`. `requestIdFor('k')` is
    stable across calls.
  - `never logs tokens`: a capturing logger sees no `ya29.` substring.
- [ ] **Step 2: Run to fail.** Command: `… vitest run tests/provider-gcp.test.ts`. Expected: FAIL (cannot resolve
  `@better-compute/provider-gcp`).
- [ ] **Step 3: Implement** the package, auth, client and ids. Then run
  `node node_modules/pnpm/bin/pnpm.mjs install` to link the workspace package (coordinate first, per Global
  Constraints).
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `node scripts/check-deps.mjs`. Expected: no violations.
- [ ] **Step 6: Commit:** `provider-gcp: package, token sources, Compute Engine REST client, emulator`.

### Task 3: GCP compute: offers, create, get, delete, power, list

**Files:**
- Create: `packages/provider-gcp/src/{shapes,compute,provider}.ts`
- Test: `tests/provider-gcp.test.ts` (section `compute`)

**Interfaces:**
- **Consumes:** `GceClient`, `ids.ts` (Task 2), `ProviderImpl` (Task 1).
- **Produces:**
  - `gcpProvider(options?: GcpProviderOptions): ProviderDefinition<GcpConfig>` with `id: 'gcp'`,
    `provides: ['vps']` and `capabilities: ['power','list','discover','claim','reservations','networks']`.
  - `export const gcp = gcpProvider()`.
  - `export function toMachine(i: GceInstance): ExternalMachine`
  - `export function gpuModel(acceleratorType: string): string`

**Mappings:**
- **Accelerator → model** (`gpuModel`):
  - `nvidia-h100-80gb` / `nvidia-h100-mega-80gb` → `'H100'`
  - `nvidia-h200-141gb` → `'H200'`
  - `nvidia-b200` → `'B200'`
  - `nvidia-a100-80gb` / `nvidia-tesla-a100` → `'A100'`
  - `nvidia-l4` → `'L4'`
  - `nvidia-l40s` → `'L40S'`
  - unknown → `'other'`
  - These match the pool `gpuModel` strings in use (`H100`, `H200`, `B200`, `A100`, `L40S`).
- **Status → state:**
  - `PROVISIONING`/`STAGING` → `pending`
  - `RUNNING` → `running`
  - `STOPPING`/`SUSPENDING`/`SUSPENDED`/`TERMINATED`/`STOPPED` → `stopped`
  - `REPAIRING` → `error`
  - anything else → `unknown`
- **Power:**
  - `on` → `start`
  - `graceful-off` → `stop`
  - `off` → `stop?discardLocalSsd=false`
  - `reset` / `cycle` → `reset`
  - `graceful-restart` → `stop` then `start` (two calls)
  - `nmi` → `UNSUPPORTED`
- **Offers:** `listOffers` lists `machineTypes` in the configured `zones`, keeping only accelerator-optimized
  (`a2`, `a3`, `a4`, `g2`) and general types when `!query.gpuModel`. Each offer is
  `{ kind:'vps', region: zone minus its last '-x', vcpu, memoryGiB: memoryMb/1024, gpus, available: true }`.
  Reservation offers are appended by Task 5.
- **`create` request:**
  - `POST /zones/{zone}/instances?requestId={requestIdFor(key)}`
  - `name = request.name` sanitized with `instanceName`, machine type from the offer, the boot disk from `image`
    (`projects/{imageProject}/global/images/family/…` or a full URL), and `metadata.user-data = userData`
  - labels `{ managed: 'true', instance: labelValue(request.name), ...request.labels }`
  - `networkInterfaces` from `request.network` or the config; GPU types get `scheduling.onHostMaintenance=TERMINATE`
  - when the offer has `@reservation`: `reservationAffinity { consumeReservationType:'SPECIFIC_RESERVATION',
    key:'compute.googleapis.com/reservation-name', values:[reservation] }`
- **`create` response:** returns `{ id: zone/name, state:'pending', … }` without waiting for the operation. The vps
  reconciler polls `get`.
- **`get`:** returns `undefined` on `NOT_FOUND`.
- **`delete`:** refuses with `INVALID_STATE` unless the VM has the label `managed=true`. `NOT_FOUND` counts as
  success. Attached VMs are never deleted through `delete` unless their instance chose `on_delete='delete'`; the vps
  layer passes that as `claim` first, which sets `managed=true` (see Task 10).
- **`power`:** refuses with `INVALID_STATE` unless the `instance` label is present.
- **`list`:** `aggregatedList` with `filter=labels.better-compute-managed=true`.

- [ ] **Step 1: Write the failing tests** under `describe('compute')`:
  - `runConformance(providerConformanceCases(), { provider: gcpProvider({ fetch: emu.fetch, tokenSource }),
    config: { projectId:'p', zones:['us-central1-a'] }, offerId:'us-central1-a/a3-highgpu-8g', image:'ubuntu-2404-lts' })`
    passes all cases.
  - `create retries are deduplicated by requestId`: the emulator gets two inserts with the same `requestId` and holds
    one VM.
  - `create on a reservation offer sets SPECIFIC_RESERVATION affinity`: assert
    `emu.instances.get('us-central1-a/bc-ins_x').reservationAffinity.values` deep-equals `['rsv-a']`.
  - `delete refuses a VM without the managed label`: `await expect(impl.delete('us-central1-a/legacy', ctx))
    .rejects.toMatchObject({ code: 'INVALID_STATE' })`, and the emulator still has `legacy`.
  - `power maps actions`: `graceful-restart` issues `stop` then `start`, and `nmi` gives `UNSUPPORTED`.
  - `toMachine maps a3-highgpu-8g with 8 nvidia-h100-80gb`: assert `{ gpus:{model:'H100',count:8}, vcpu:208,
    memoryGiB:1872, zone:'us-central1-a' }`.
  - `listOffers filters by gpuModel and minGpus`
- [ ] **Step 2: Run to fail.** Expected: FAIL (`gcpProvider` is not exported).
- [ ] **Step 3: Implement** `shapes.ts`, `compute.ts` and `provider.ts`.
- [ ] **Step 4: Run to pass.** Expected: PASS.
- [ ] **Step 5: Commit:** `provider-gcp: offers, create (requestId, reservation affinity), get, delete, power, list`.

### Task 4: GCP discover, claim and release

**Files:**
- Modify: `packages/provider-gcp/src/compute.ts`
- Test: `tests/provider-gcp.test.ts` (section `attach primitives`)

**Interfaces — Produces:**
- `discover`: `aggregatedList` over the configured zones, filtered by `discoverLabel` when set, yielding
  `toMachine(i)`. Populates `zone`, `machineType`, `vcpu`, `memoryGiB`, `gpus`, `labels`, `networks` (from
  `networkInterfaces[].network|subnetwork|networkIP|accessConfigs[0].natIP`, plus `tags.items`), `reservation` (from
  `resourceStatus.reservationConsumptionInfo.consumedReservation`, normalized to the `ExternalReservation.id` form),
  `createdAt` and `claimedBy` (the value of the `better-compute-instance` label).
- `claim(id, instanceId, ctx, { managed })`:
  - `GET` the VM, then `setLabels` with its `labelFingerprint`, adding `better-compute-instance=<instanceId>`, plus
    `better-compute-managed=true` when `managed`.
  - Refuses with `CONFLICT` if the label already names a different instance.
  - Retries once on 412 (stale fingerprint).
  - Returns the refreshed machine.
- `release(id, instanceId)`: removes `better-compute-instance` only when it equals `instanceId`, and never touches
  any other label. A missing VM (`NOT_FOUND`) counts as success. An attached VM never carries `managed` unless its
  instance is being deleted with `onDelete:'delete'` (Task 10), so `release` leaves the VM exactly as it was before
  the attach.

- [ ] **Step 1: Write the failing tests:**
  - `discover yields unlabeled VMs with shape, networks and consumed reservation`
  - `discover honours discoverLabel`
  - `claim writes the instance label using the fingerprint`
  - `claim refuses a VM claimed by another instance`: expect `CONFLICT`.
  - `release only removes its own label`
  - `release of a deleted VM succeeds`
  - The conformance subject sets `attachable: 'us-central1-a/legacy'`, and the claim/discover conformance cases pass.
- [ ] **Step 2: Run to fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Expected: PASS.
- [ ] **Step 5: Commit:** `provider-gcp: discover, claim and release (label-fingerprint safe)`.

### Task 5: GCP reservations

**Files:**
- Create: `packages/provider-gcp/src/reservations.ts`
- Modify: `compute.ts` (`listOffers` appends reservation offers)
- Test: `tests/provider-gcp-reservations.test.ts`

**Interfaces — Produces** `listReservations(ctx): Promise<ExternalReservation[]>`:

- **On-demand reservations** come from `GET /aggregated/reservations`, limited to the configured zones.
  - Field sources: `total` = `specificReservation.count`, `inUse` = `specificReservation.inUseCount`, and the shape
    from `specificReservation.instanceProperties` (`machineType`, `guestAccelerators[0]`, `localSsds` summed).
    `specificOnly` = `specificReservationRequired`. `shared` = `shareSettings.shareType !== 'LOCAL'`.
  - Shared reservations get the id `projects/<owner>/zones/<zone>/reservations/<name>` and their offer suffix is
    `projects/<owner>/reservations/<name>`.
  - State: `CREATING` → `creating`, `READY` → `ready`, `UPDATING` → `updating`, `DELETING` → `deleting`, else `error`.
  - A reservation using `sourceInstanceTemplate` with no `instanceProperties`: GET the template and read its
    properties.
- **Future reservations** come from `GET /aggregated/futureReservations`.
  - Field sources: `total` = `specificSkuProperties.totalCount`, `inUse` = 0, `startsAt`/`endsAt` from `timeWindow`
    (`startTime` + `endTime` or `duration`). The id gets the prefix `future:`.
  - State: `PENDING_APPROVAL`/`APPROVED`/`PROCURING`/`PROVISIONING` → `scheduled`. `FULFILLED` is dropped, because
    the auto-created reservation shows up in the on-demand list.
- **Offers:** `listOffers` also returns one offer per `ready` reservation, with
  `offerId = offerId(zone, machineType, suffix)` and `available = total - inUse > 0`.

- [ ] **Step 1: Write the failing tests:**
  - `maps a local a3 reservation`: assert `{ id:'us-central1-a/rsv-a', total:4, inUse:1, gpus:{model:'H100',count:8},
    state:'ready', offerId:'us-central1-a/a3-highgpu-8g@rsv-a' }`.
  - `maps a shared reservation with the owner project in id and offer`
  - `reads the instance template when instanceProperties is absent`
  - `maps a future reservation to scheduled with its window`
  - `ignores reservations outside configured zones`
  - `listOffers includes reservation offers with availability`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-gcp: on-demand, shared and future reservations as ExternalReservation`.

### Task 6: GCP networks

**Files:**
- Create: `packages/provider-gcp/src/networks.ts`
- Test: `tests/provider-gcp-networks.test.ts`

**Interfaces — Produces** `ProviderNetworks`:

| Method | GCE call | Notes |
|---|---|---|
| `ensureNetwork` | `GET /global/networks/{name}`, else `POST /global/networks` | `{ name, autoCreateSubnetworks:false, routingConfig:{routingMode:'REGIONAL'}, mtu }`, with `requestId = requestIdFor('net:'+name)`. |
| `ensureSubnet` | `POST /regions/{region}/subnetworks` | `{ name, network: 'global/networks/'+network, ipCidrRange: cidr, privateIpGoogleAccess }`. |
| `ensureFirewall` | `POST /global/firewalls` | `{ name, network, direction:'INGRESS'|'EGRESS', priority, allowed|denied: rules.map(r => ({ IPProtocol: r.protocol, ports })), sourceRanges, destinationRanges, targetTags, disabled }`. A firewall that exists with a different body is `PATCH`ed. |
| `delete*` | `DELETE` | `NOT_FOUND` → `{ state:'deleted' }`. `resourceInUseByAnotherResource` → `{ state:'pending', message }`, never thrown. |
| `setTags` | `GET` the VM, then `POST …/setTags { items, fingerprint }` | Keeps tags not starting with `bc-`. Refuses with `INVALID_STATE` without the instance label. |

Every `ensure*` returns `pending` while its operation is `RUNNING`, `ready` when `DONE` with no error, and `error`
with the operation's first error message otherwise. The operation name is kept in memory per call, and the next call
re-reads the resource; no operation ids are persisted.

GCE resource names come from the vps layer: `bc-<labelValue(networkId)>`, `bc-<labelValue(subnetId)>` and
`bc-<labelValue(ruleId)>`.

- [ ] **Step 1: Write the failing tests:**
  - `ensureNetwork is idempotent and pending until the operation is done`: `operationDelayTicks=2` gives `pending`,
    `pending`, then `ready`.
  - `ensureSubnet creates a custom-mode subnet`
  - `ensureFirewall creates then patches on change`
  - `deleteNetwork in use reports pending, not an error`
  - `setTags keeps foreign tags and replaces bc- tags`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-gcp: networks, subnets, firewalls and instance tags`.

---

## Phase 2 — Discovery worker and attach (R1, R3, R5)

### Task 7: `provider_machines` table and the `vps.discovery` worker

**Files:**
- Create: `packages/vps/src/discovery.ts`
- Modify:
  - `packages/vps/src/module.ts` (register the migration and reconciler; add `VpsOptions.discovery`)
  - `packages/vps/src/index.ts`
  - `packages/events/src/catalog.ts` (family `provider.machine.*`, subject `provider-account/{id}`, module `vps`)
- Test: `tests/vps-discovery.test.ts`

**Interfaces:**
- **Consumes:** `ProviderImpl.discover` (Task 1), `ProviderClients.client(account, …)` (`vps/src/accounts.ts:249`).
- **Produces:**

```ts
export const providerMachinesMigration: Migration;   // 'vps/0023_provider_machines'
export interface DiscoveryOptions {
  every?: Duration;                       // default '5m'
  autoAttach?: { ownerIdentityId: string } | false;   // default false (Task 11)
}
export const discoveryWork = 'vps.discovery';
export function discoveryReconciler(options: DiscoveryOptions): Reconciler;   // shardBy 'none'
export interface ProviderMachineView {
  accountId: string; externalId: string; name?: string; state: ExternalMachine['state'];
  zone?: string; region?: string; machineType?: string; vcpu?: number; memoryGiB?: number;
  gpus?: { model: string; count: number }; labels: Record<string, string>;
  networks: NonNullable<ExternalMachine['networks']>; reservation?: string; addresses: string[];
  instanceId?: string; tenantId?: string;       // set when attached or created by better-compute
  firstSeenAt: number; lastSeenAt: number; goneAt?: number;
}
```

**Table:**

```sql
CREATE TABLE provider_machines (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  external_id text NOT NULL,
  machine jsonb NOT NULL,                 -- the ExternalMachine as last seen
  instance_id text REFERENCES instances,  -- attached or created instance, NULL when free
  first_seen_at timestamptz NOT NULL DEFAULT compute_now(),
  last_seen_at timestamptz NOT NULL,
  gone_at timestamptz,
  PRIMARY KEY (account_id, external_id)
);
CREATE INDEX provider_machines_free ON provider_machines (account_id) WHERE instance_id IS NULL AND gone_at IS NULL;
-- Next discovery pass per account:
CREATE TABLE provider_discovery (account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL, last_ok_at timestamptz, last_error text);
```

**Algorithm** (one reconciler, two key shapes):
- **Key `all`** (periodic, every `options.every`): `INSERT … ON CONFLICT DO NOTHING` a `provider_discovery` row for
  every account whose provider implements `discover`. Then `enqueueMany(tx, 'vps.discovery', ids)` for accounts with
  `next_at <= compute_now()`. Returns `DONE`.
- **Key `<accountId>`:**
  - Read the account and build its client outside any transaction. Iterate `discover()` with a 45 s budget
    (`AbortSignal.timeout`); a timeout records `last_error`, and the next periodic pass retries.
  - Then, in one transaction (machines are written in batches of 500 when there are more):
    - Upsert each seen machine with `last_seen_at = compute_now()` and `gone_at = NULL`.
    - Link `instance_id` from `instances WHERE provider_account_id = $1 AND external_id = $2 AND state <> 'deleted'`.
    - Set `gone_at = compute_now()` on rows of this account not seen this pass.
    - Update `provider_discovery` (`next_at = now + every`, `last_ok_at`, `last_error = NULL`).
  - Events, published in the same transaction:
    - `provider.machine.discovered`, for a first sighting: `{ accountId, externalId, machineType, gpus }`
    - `provider.machine.changed`, when the state, shape, network or `claimedBy` changes: `{ accountId, externalId,
      changes: string[] }`
    - `provider.machine.gone`: `{ accountId, externalId, instanceId? }`
  - Errors: `RATE_LIMITED` → `notBefore` = `retryAfterMs`. Any other error → store `last_error`, `next_at = now + every`.
    Returns `DONE`.

- [ ] **Step 1: Write the failing tests** (`tests/vps-discovery.test.ts`, on pglite with
  `vps({ providers: [gcpProvider({ fetch: emu.fetch, tokenSource })], discovery: { every: '1m' } })`, a root-owned
  account, and `manualClock`):
  - `first pass records every VM and publishes provider.machine.discovered`: 3 emulator VMs give 3 rows and 3 outbox
    events.
  - `a VM removed in GCP is marked gone on the next pass`
  - `a changed VM publishes provider.machine.changed with the changed fields`: a stop in the emulator gives
    `changes` containing `'state'`.
  - `links machines created by instances.create to their instance`
  - `a provider without discover is skipped`: a Hetzner fake account gets no `provider_discovery` row.
  - `rate limits defer the account, not the worker`: `failNext` 429 with `Retry-After: 30` gives a work row
    `not_before` ≈ now + 30 s.
- [ ] **Step 2: Run to fail.** Command: `… vitest run tests/vps-discovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `discovery.ts`, the module wiring and the event family.
- [ ] **Step 4: Run to pass.** Expected: PASS.
- [ ] **Step 5: Commit:** `vps: provider_machines and the vps.discovery worker`.

### Task 8: `providerAccounts.machines` and `providerAccounts.discover`

**Files:**
- Modify:
  - `packages/vps/src/discovery.ts` (handlers)
  - `packages/vps/src/module.ts` (`api()` group `providerAccounts`)
  - `packages/core/src/catalog.ts` (`apiSurface` rows)
  - `apps/docs/descriptions/api/providerAccounts.md`
- Test: `tests/vps-discovery.test.ts` (section `api`)

**Interfaces — Produces** (rows to append to `group('providerAccounts', 'vps', [...])`):

```ts
['machines', 'read', 'providers:read', 'provider-account', 'v1.0'],
['discover', 'mutation', 'providers:manage', 'provider-account', 'v1.0'],
```

- `providerAccounts.machines`:
  - **Input:** `{ tenantId, accountId, filter?: 'free' | 'attached' | 'all' = 'free', includeGone?: boolean = false,
    cursor?, limit?: number ≤ 500 = 100 }`.
  - **Output:** `{ items: ProviderMachineView[], cursor?: string, discoveredAt?: number }`.
  - Results are ordered by `(zone, external_id)`.
- `providerAccounts.discover`:
  - **Input:** `{ tenantId, accountId, wait?: boolean }`.
  - It sets `next_at = compute_now()` and enqueues the account.
  - With `wait`, it polls through the method `poll` option for up to 60 s, until `last_ok_at` passes the call time.
  - **Output:** `{ queued: true, discoveredAt?: number }`.

- [ ] **Step 1: Write the failing tests:**
  - `machines lists free VMs by default and attached with filter`
  - `machines is denied without providers:read`: use `tests/support/fake-iam.ts` with no grant and expect
    `ACCESS_DENIED`.
  - `discover with wait returns after the pass`
  - `api surface has the rows`: `apiSurface.find(r => r.group==='providerAccounts' && r.method==='machines')` matches
    `{ action:'compute:providers:read', resource:'provider-account', phase:'v1.0' }`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement**, then run `node scripts/authz-matrix.mjs`. Expected: no undeclared methods.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: providerAccounts.machines and providerAccounts.discover`.

### Task 9: `instances.attach`

**Files:**
- Create: `packages/vps/src/attach.ts`
- Modify:
  - `packages/vps/src/module.ts` (`instances` group, the migration)
  - `packages/core/src/catalog.ts` (action `instances:attach` added to the `instance` kind's `a('instances', …)`,
    plus an `apiSurface` row)
  - `apps/docs/descriptions/api/instances.md`
- Test: `tests/vps-attach.test.ts`

**Interfaces — Produces:**

```ts
export const instanceAttachMigration: Migration;   // 'vps/0024_instance_attach'
// apiSurface row in group('instances', 'vps', …):
['attach', 'mutation', 'instances:attach', 'instance', 'v1.0'],
export interface AttachInstanceInput {
  tenantId: string;            // the customer tenant that will own the instance
  poolId: string;              // class:'provider' pool, owned by or offered to tenantId, backed by the machine's account
  externalId: string;          // provider machine id ("us-central1-a/legacy")
  projectId?: string;
  ownerIdentityId?: string;    // default: caller.identityId (D7)
  onDelete?: 'detach' | 'delete';   // default 'detach' (D6)
  name?: string;
  idempotencyKey: string;
}
// returns the Instance view (core domain.ts:487) with origin: 'attached'
```

**Migration `vps/0024_instance_attach`:**

```sql
ALTER TABLE instances ALTER COLUMN flavor_id DROP NOT NULL;
ALTER TABLE instances ALTER COLUMN image_id DROP NOT NULL;
ALTER TABLE instances ADD COLUMN origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'attached'));
ALTER TABLE instances ADD COLUMN on_delete text NOT NULL DEFAULT 'delete' CHECK (on_delete IN ('delete', 'detach'));
ALTER TABLE instances ADD COLUMN attached_at timestamptz;
ALTER TABLE instances ADD COLUMN claimed_at timestamptz;          -- provider label written
ALTER TABLE instances ADD COLUMN reboot_requested_at timestamptz;  -- Task 12
ALTER TABLE instances ADD COLUMN rebooted_at timestamptz;
ALTER TABLE instances ADD COLUMN reboot_hard bool NOT NULL DEFAULT false;
CREATE UNIQUE INDEX instances_external_live ON instances (provider_account_id, external_id)
  WHERE external_id IS NOT NULL AND state NOT IN ('deleted');
```

Also add optional `origin?: 'created' | 'attached'` and `onDelete?: 'delete' | 'detach'` to the core `Instance`
view; this is additive.

**Handler** (one transaction):
1. **Pool check.** Reuse `visibleVpsPool(tx, tenantId, poolId)` (`instances.ts:758`). Require `class='provider'` and
   `provider_account_id IS NOT NULL`.
2. **Machine check.** Lock `provider_machines (account_id = pool.provider_account_id, external_id)` with `FOR UPDATE`.
   - Missing or `gone_at IS NOT NULL` → `NOT_FOUND` with the hint "run providerAccounts.discover".
   - `instance_id IS NOT NULL` → `CONFLICT` with `details.instanceId`.
3. **Account ownership.** A tenant caller may attach only from an account its own tenant owns; root callers may
   attach from any account. Otherwise → `ACCESS_DENIED`.
4. **Insert the instance:**
   - `id = draftId('inst', tenantId, caller.identityId, key)` (the same prefix as `instances.ts:947`),
     `state='scheduling'`, `draft=false`, `origin='attached'`, `on_delete`, `attached_at = compute_now()`,
     `external_id`, `provider_account_id`
   - `flavor = { name: machineType, vcpu, memoryGiB, diskGiB: 0, gpus: gpus?.count }`, `flavor_id NULL`,
     `image_id NULL`, and `runtime` = the value `prepareCreateInstance` writes for provider pools (read it there; do
     not invent a new one)
   - `desired_state` = `'stopped'` if the machine is `stopped`, else `'running'`
   - `owner_identity_id = ownerIdentityId ?? caller.identityId`
   - `request_hash` over the normalized input. A replay with the same key and a different hash → `CONFLICT`.
5. **Quota.** `chargeQuota` with the flavor, exactly as `completeCreateInstance` does for provider pools. Set
   `quota_charged`. On failure → `QUOTA_EXCEEDED`, and nothing is written.
6. **Link the machine.** `UPDATE provider_machines SET instance_id = $id`.
7. **Authz.** `authz.upsert` with type `instance`, `tenantId`, `instanceAttributes(…)`, parent pool,
   `ownerId = owner_identity_id`.
8. **Event.** Publish `instance.attached` `{ instanceId, accountId, externalId, poolId, onDelete }`.
9. **Wake the reconciler.** `work.enqueue(tx, 'vps.instances', id)`.

- [ ] **Step 1: Write the failing tests** (`tests/vps-attach.test.ts`; root caller; customer tenant `t_cust` offered
  the root pool `pool_gcp`; the emulator VM `us-central1-a/legacy` is running with 8×H100; one discovery tick first):
  - `attach creates an instance owned by the customer tenant and the given owner`: assert `tenantId:'t_cust'`,
    `origin:'attached'`, `onDelete:'detach'`, and that `instances.list({tenantId:'t_cust', scope:'mine'})` as
    `usr_cust` contains it.
  - `refuses a second attach of the same machine`: a different idempotency key gives `CONFLICT`.
  - `replays the same attach idempotently`: the same key returns the same id.
  - `refuses attaching a machine discovery marked gone`: `NOT_FOUND`.
  - `refuses a pool not visible to the tenant`: `NOT_FOUND` (same as instances.create).
  - `refuses a tenant attaching from a root account`: `ACCESS_DENIED`.
  - `charges quota and refuses over quota`: `quotas.set` for gpus=4 on `t_cust` gives `QUOTA_EXCEEDED`.
  - `unique index refuses a concurrent duplicate`: two `Promise.all` attaches with different keys give exactly one
    fulfilled and one `CONFLICT`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** the migration, handler and catalog changes.
- [ ] **Step 4: Run to pass.** Also run `tests/vps-instances*.test.ts` to catch `flavor_id`-nullable fallout.
  Expected: PASS.
- [ ] **Step 5: Commit:** `vps: instances.attach for running provider machines`.

### Task 10: Reconciling attached instances, `instances.detach`, delete semantics

**Files:**
- Modify:
  - `packages/vps/src/lifecycle.ts` (`providerAction` L335-344, `reconcileProvider` L357-503, `beginDeletion`,
    `finishDeletion` L92-110)
  - `packages/vps/src/attach.ts` (`detach` handler)
  - `packages/core/src/catalog.ts` (row)
  - `apps/docs/descriptions/api/instances.md`
- Test: `tests/vps-attach.test.ts` (section `lifecycle`)

**Interfaces — Produces:**
- API row `['detach', 'mutation', 'instances:delete', 'instance', 'v1.0']`.
- **Input:** `{ tenantId, instanceId }`.
- `detach` sets `on_delete='detach'` and `desired_state='deleted'`, then enqueues. It returns the instance in
  `deleting`. It refuses with `INVALID_STATE` for `origin='created'`, because detaching a VM better-compute created
  would leave an unbilled VM running.

**Reconciler changes for `origin='attached'`:**
- **`scheduling`, `claimed_at IS NULL`:** call `client.claim(externalId, instanceId)` outside the transaction, then set
  `claimed_at` and `addresses`.
  - `CONFLICT` → state `failed` with condition `AttachConflict`, and `instance.failed` is published.
  - A provider without `claim` gets `claimed_at` set immediately, and the provider's own `delete`/`power` guards
    apply.
- **Never call `create`.** If `get` returns `undefined` for an attached instance → `lost` (the existing path). Add an
  assertion: `origin='attached'` is never passed to `client.create`.
- **`deleting` with `on_delete='detach'`:** call `client.release(externalId, instanceId)`. Never call `delete`. Then
  `finishDeletion`, which refunds quota, removes authz and publishes `instance.detached` (not `instance.deleted`).
  `UPDATE provider_machines SET instance_id = NULL`.
- **`deleting` with `on_delete='delete'` and `origin='attached'`:** call `client.claim(externalId, instanceId, ctx,
  { managed: true })`, then `client.delete`, and the normal path continues.

- [ ] **Step 1: Write the failing tests:**
  - `claims the VM label on first reconcile`: after `compute.jobs['vps.instances'].tick()`, the emulator VM has the
    label `better-compute-instance=<id>`.
  - `delete of an attached instance detaches by default`: the emulator VM is still `RUNNING`, has no instance label,
    and has no `DELETE` in `emu.requests`. The instance is `deleted`, `instance.detached` was published, quota usage
    is back to 0, and `provider_machines.instance_id` is NULL.
  - `onDelete:'delete' deletes the VM`
  - `an attached instance whose VM vanished goes lost, never recreated`: delete the VM in the emulator and tick twice.
    State is `lost` and there is no `POST …/instances` in `emu.requests`.
  - `start/stop on an attached instance call the provider`: `instances.stop` then a tick gives an emulator `stop`.
  - `detach refuses a created instance`: `INVALID_STATE`.
  - `claim conflict fails the instance`: pre-label the VM with another instance id, then attach and tick. State is
    `failed` and conditions contain `AttachConflict`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Also run `tests/vps-*.test.ts` (the provider reconciler is shared). Expected: PASS.
- [ ] **Step 5: Commit:** `vps: reconcile attached instances; instances.detach; detach-on-delete`.

### Task 11: Label-driven auto-attach

**Files:**
- Modify: `packages/vps/src/discovery.ts`
- Test: `tests/vps-discovery.test.ts` (section `auto-attach`)

**Interfaces — Consumes:** the `attach` core logic from Task 9, exported from `attach.ts` as
`attachMachine(tx, ctx, input: AttachInstanceInput & { caller: Caller }): Promise<Instance>`. Use this one function
from both the API handler and here.

**Behavior** (only when `discovery.autoAttach` is set):
- After a pass, for each free, not-gone machine with labels `better-compute-tenant=<t>` and `better-compute-pool=<p>`
  (both required), call `attachMachine` with:
  - `tenantId = t`, `poolId = p`
  - `ownerIdentityId` = the label `better-compute-owner`, else `autoAttach.ownerIdentityId`
  - `onDelete:'detach'`, `idempotencyKey = 'auto:' + externalId`
  - `caller` = a system caller `{ identityId: autoAttach.ownerIdentityId, tenantId: rootTenantId, … }`
- **Guard:** `t` must equal the account's `tenant_id`, or the account's `tenant_id` must be the root tenant.
  Otherwise skip, and publish `provider.machine.changed` with `changes:['autoAttachRefused']`.
- Failures (quota, pool not visible) never fail the pass. Each is recorded as a condition-like entry in
  `provider_machines.machine.autoAttachError`.

- [ ] **Step 1: Write the failing tests:**
  - `auto-attaches a labelled VM to its tenant and pool`
  - `ignores VMs without both labels`
  - `refuses a BYO account labelling a VM for another tenant`
  - `records quota failure without failing the pass`
  - `disabled by default`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: opt-in label-driven auto-attach in discovery`.

### Task 12: `instances.reboot`

**Files:**
- Modify:
  - `packages/vps/src/attach.ts` (handler)
  - `lifecycle.ts` (reconciler branch)
  - `catalog.ts` (row)
  - `apps/docs/descriptions/api/instances.md`
- Test: `tests/vps-attach.test.ts` (section `reboot`)

**Interfaces — Produces:**
- API row `['reboot', 'mutation', 'instances:update', 'instance', 'v1.0']`.
- **Input:** `{ tenantId, instanceId, hard?: boolean = false }`.
- It sets `reboot_requested_at = compute_now()` and `reboot_hard = hard` (columns from `0024`).
- **Reconciler:** when `reboot_requested_at > coalesce(rebooted_at, '-infinity')` and the instance is `running`, call
  `client.power(externalId, hard ? 'reset' : 'graceful-restart')`, set `rebooted_at`, and publish `instance.rebooted`.
- **Applies to:** provider pools only. Hosted pools get `UNSUPPORTED` for now (follow-up).
- Calling reboot on a stopped instance → `INVALID_STATE`.

- [ ] **Step 1: Write the failing tests:**
  - `reboot issues graceful-restart once`: two ticks give exactly one stop+start pair in `emu.requests`.
  - `hard reboot issues reset`
  - `reboot of a stopped instance is refused`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: instances.reboot for provider instances`.

---

## Phase 3 — Reservation detection and spin-up (R6)

### Task 13: `provider_reservations` table and the `vps.reservations` worker

**Files:**
- Create: `packages/vps/src/provider-reservations.ts`
- Modify:
  - `module.ts` (`VpsOptions.reservations?: { every?: Duration }`, default `'5m'`)
  - `index.ts`
  - `packages/events/src/catalog.ts` (family `provider.reservation.*`, subject `provider-account/{id}`)
- Test: `tests/vps-provider-reservations.test.ts`

**Interfaces — Produces:**

```ts
export const providerReservationsMigration: Migration;   // 'vps/0025_provider_reservations'
export const reservationsWork = 'vps.reservations';
export function providerReservationsReconciler(options: { every?: Duration }): Reconciler;   // shardBy 'none', keys 'all' | accountId
export interface ProviderReservationView extends ExternalReservation {
  accountId: string; free: number; pending: number; poolId?: string; flavorId?: string;
  observedAt: number; goneAt?: number;
}
```

```sql
CREATE TABLE provider_reservations (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  reservation_id text NOT NULL,           -- ExternalReservation.id
  reservation jsonb NOT NULL,             -- the ExternalReservation as last seen
  total int NOT NULL, in_use int NOT NULL,
  observed_at timestamptz NOT NULL,
  gone_at timestamptz,
  pool_id text REFERENCES pools,          -- bound pool (Task 14)
  flavor_id text REFERENCES flavors,      -- the flavor bindReservation created
  PRIMARY KEY (account_id, reservation_id)
);
ALTER TABLE instances ADD COLUMN provider_reservation text;   -- reservation_id the instance was admitted against
CREATE INDEX instances_provider_reservation ON instances (provider_account_id, provider_reservation)
  WHERE provider_reservation IS NOT NULL AND state NOT IN ('deleted', 'failed');
```

**Algorithm:** the same two-key pattern as Task 7, using its `provider_discovery`-style next-pass bookkeeping. Add
`reservations_next_at timestamptz` and `reservations_last_ok_at timestamptz` to `provider_discovery`; the table is
created in 0023 and altered here.
- **Upserts** set `observed_at = compute_now()`. Rows not seen this pass get `gone_at`.
- **Events:**
  - `provider.reservation.detected`, for a first sighting: `{ accountId, reservationId, machineType, gpus, total,
    state, startsAt? }`
  - `provider.reservation.changed`, when total, inUse or state changes: `{ …, free }`
  - `provider.reservation.ready`, when `scheduled` becomes `ready` (a future reservation fulfilled), or a `creating`
    reservation becomes `ready`
  - `provider.reservation.gone`
- **Bound flavors:** when a bound reservation goes `gone`, call the existing `deleteFlavor`
  (`vps/src/flavors.ts:206`). It deletes an unused flavor or archives one that instances still reference.
  `provider.reservation.gone` carries `{ poolId, flavorId }`.

- [ ] **Step 1: Write the failing tests:**
  - `detects reservations and publishes detected`: 2 emulator reservations give 2 rows and 2 events.
  - `publishes changed with free when inUse changes`
  - `a future reservation becoming fulfilled publishes ready`: the emulator moves the future reservation to
    `FULFILLED` and adds an on-demand reservation, and the next pass publishes `ready` for the new id.
  - `gone reservations are marked`
  - `skips providers without listReservations`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: provider_reservations and the vps.reservations worker`.

### Task 14: List, bind, unbind, and admission that never over-commits

**Files:**
- Modify:
  - `packages/vps/src/provider-reservations.ts`
  - `packages/vps/src/instances.ts` (`completeCreateInstance` L1168-1193: call `claimReservationSlot` for provider
    pools)
  - `packages/vps/src/flavors.ts` (the offer-id check L155 accepts `@` offers)
  - `catalog.ts` (rows)
  - `apps/docs/descriptions/api/providerAccounts.md`
- Test: `tests/vps-provider-reservations.test.ts` (section `api & admission`)

**Interfaces — Produces:**

```ts
['reservations', 'read', 'providers:read', 'provider-account', 'v1.0', list],
['bindReservation', 'mutation', 'providers:manage', 'provider-account', 'v1.0', { or: [['flavors:manage', 'pool']] }],
['unbindReservation', 'mutation', 'providers:manage', 'provider-account', 'v1.0'],

// providerAccounts.reservations
{ tenantId, accountId, includeGone?: boolean } → { items: ProviderReservationView[] }
// providerAccounts.bindReservation
{ tenantId, accountId, reservationId, poolId, flavorName?: string, idempotencyKey } → { poolId, flavorId }
// providerAccounts.unbindReservation
{ tenantId, accountId, reservationId } → { reservationId }

export async function claimReservationSlot(tx: SqlTx, input: { accountId: string; offerId: string }):
  Promise<string | undefined>;   // the reservation_id claimed, or undefined for a non-reservation offer
```

**Bind rules:**
- The pool must be `class='provider'` with `provider_account_id = accountId`.
- The reservation must be `ready` or `scheduled` and not gone.
- The flavor is created with `{ name: flavorName ?? 'rsv-' + name, vcpu, memoryGiB, diskGiB: account diskGiB, gpus:
  gpus?.count, offerId: reservation.offerId }`, through the existing flavor-creation function in `flavors.ts` (not a
  new code path).
- Set `pool_id` and `flavor_id`. Binding the same reservation to another pool → `CONFLICT`.
- Unbind calls `deleteFlavor` (deleted if unused, archived otherwise) and clears `pool_id` and `flavor_id`.

**Admission** (`claimReservationSlot`):
1. Parse `@` from `offerId`. If there is none, return `undefined`.
2. `SELECT … FROM provider_reservations WHERE account_id=$1 AND reservation_id=$2 FOR UPDATE`.
   - Missing, gone, or not `ready` → `CAPACITY_UNAVAILABLE` (`details: { reservationId, state }`).
3. Compute `pending`:

   ```sql
   SELECT count(*) FROM instances
   WHERE provider_account_id=$1 AND provider_reservation=$2
     AND state NOT IN ('deleted','failed','lost')
     AND (external_id IS NULL OR created_at > $observed_at)
   ```

4. If `total - in_use - pending < 1` → `CAPACITY_UNAVAILABLE`, with `details: { reservationId, total, inUse,
   pending }`. Otherwise return the id, and the caller stores it in `instances.provider_reservation`.

Because the row lock serializes concurrent admissions on the same reservation, two creates inside one poll window
cannot both take the last slot.

- [ ] **Step 1: Write the failing tests:**
  - `reservations lists free and pending`
  - `bindReservation creates a flavor with the reservation offer`: `flavors.list({poolId})` contains `rsv-rsv-a` with
    `offerId 'us-central1-a/a3-highgpu-8g@rsv-a'`.
  - `instances.create on a bound flavor consumes the reservation in GCP`: after a tick, the emulator VM's
    `reservationAffinity.values` is `['rsv-a']`.
  - `admits only the free slots between polls`: total 2, inUse 1. Two concurrent creates give one admitted and one
    `CAPACITY_UNAVAILABLE`.
  - `a created VM counts once observed`: after the next reservations pass (inUse 2, observed after `created_at`),
    pending is 0 and free is 0.
  - `refuses binding to a pool backed by another account`
  - `unbind removes the unused flavor`
  - `a scheduled future reservation is bindable but not admissible until ready`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Also run `tests/vps-flavors*.test.ts` and `tests/vps-instances*.test.ts`. Expected:
  PASS.
- [ ] **Step 5: Commit:** `vps: bind provider reservations to pools; DB-refereed reservation admission`.

---

## Phase 4 — Tenant networks (R4)

### Task 15: Catalog: the `network` kind and the network groups

**Files:**
- Modify: `packages/core/src/catalog.ts`
  - Append `'network'` to `computeResourceKinds`.
  - Add the resource type definition.
  - Add the `networks` and `firewallRules` groups.
- Test: `tests/core-catalog-networks.test.ts`

**Interfaces — Produces:**

```ts
network: {
  description: 'A tenant network (VPC) on a provider account, with its subnets and firewall rules',
  parent: 'tenant',
  actions: a('networks', 'create', 'read', 'update', 'delete'),
  attributes: { providerAccountId: 'string', poolId: 'string', projectId: 'string' },
},
group('networks', 'vps', [
  ['create', 'mutation', 'networks:create', 'network', 'v1.0'],
  ['list', 'read', 'networks:read', 'tenant', 'v1.0', list],
  ['get', 'read', 'networks:read', 'network', 'v1.0'],
  ['update', 'mutation', 'networks:update', 'network', 'v1.0'],
  ['delete', 'mutation', 'networks:delete', 'network', 'v1.0'],
  ['addSubnet', 'mutation', 'networks:update', 'network', 'v1.0'],
  ['removeSubnet', 'mutation', 'networks:update', 'network', 'v1.0'],
]);
group('firewallRules', 'vps', [
  ['create', 'mutation', 'networks:update', 'network', 'v1.0'],
  ['list', 'read', 'networks:read', 'network', 'v1.0', list],
  ['update', 'mutation', 'networks:update', 'network', 'v1.0'],
  ['delete', 'mutation', 'networks:update', 'network', 'v1.0'],
]);
```

- [ ] **Step 1: Write the failing test.** `network kind and rows exist` checks: `computeResourceKinds` includes
  `'network'`; every `networks`/`firewallRules` row has phase `'v1.0'` and module `'vps'`; and
  `resourceTypeLimits.attributes` is respected.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Then run `tests/core-catalog*.test.ts` and `node scripts/api-surface.mjs`. Expected:
  PASS. The surface diff shows only the additions.
- [ ] **Step 5: Commit:** `core: network resource kind; networks and firewallRules API rows (additive)`.

### Task 16: Network tables and API

**Files:**
- Create: `packages/vps/src/networks.ts`
- Modify:
  - `module.ts` (register the migration and both groups)
  - `index.ts`
  - `packages/events/src/catalog.ts` (family `network.*`, subject `network/{id}`)
  - `apps/docs/descriptions/api/networks.md` and `firewallRules.md` (create)
- Test: `tests/vps-networks.test.ts` (section `api`)

**Interfaces — Produces:**

```ts
export const networksMigration: Migration;   // 'vps/0026_networks'
export interface NetworkView {
  id: string; tenantId: string; projectId?: string; poolId: string; providerAccountId: string; name: string;
  description?: string; state: 'pending' | 'ready' | 'deleting' | 'deleted' | 'error'; message?: string;
  subnets: { id: string; name: string; region: string; cidr: string; state: NetworkView['state'] }[];
  version: number; createdAt: number;
}
export interface FirewallRuleView {
  id: string; networkId: string; name: string; direction: 'ingress' | 'egress'; action: 'allow' | 'deny';
  priority: number;                                   // 0..65535, default 1000
  rules: { protocol: 'tcp' | 'udp' | 'icmp' | 'all'; ports?: string[] }[];   // "22", "8000-8100"
  sources?: string[]; destinations?: string[];        // CIDRs; ingress defaults sources ['0.0.0.0/0'] only if given
  targets: { instanceIds?: string[] };                // empty ⇒ every instance on the network
  enabled: boolean; state: NetworkView['state']; version: number;
}
```

```sql
CREATE TABLE networks (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text, pool_id text NOT NULL REFERENCES pools,
  provider_account_id text NOT NULL REFERENCES provider_accounts, name text NOT NULL, description text,
  state text NOT NULL, desired_state text NOT NULL CHECK (desired_state IN ('present','deleted')), message text,
  idempotency_key text NOT NULL, request_hash bytea NOT NULL, version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE network_subnets (
  id text PRIMARY KEY, network_id text NOT NULL REFERENCES networks, name text NOT NULL, region text NOT NULL,
  cidr cidr NOT NULL, state text NOT NULL, desired_state text NOT NULL, message text,
  UNIQUE (network_id, name),
  EXCLUDE USING gist (network_id WITH =, cidr inet_ops WITH &&) WHERE (desired_state = 'present')
);
CREATE TABLE network_firewall_rules (
  id text PRIMARY KEY, network_id text NOT NULL REFERENCES networks, name text NOT NULL, spec jsonb NOT NULL,
  enabled bool NOT NULL DEFAULT true, state text NOT NULL, desired_state text NOT NULL, message text,
  version bigint NOT NULL, UNIQUE (network_id, name)
);
ALTER TABLE instances ADD COLUMN network_id text REFERENCES networks;
ALTER TABLE instances ADD COLUMN subnet_id text REFERENCES network_subnets;
```

The `EXCLUDE` constraint makes the database refuse overlapping subnets in one network. `btree_gist` is already
enabled. Verify that `inet_ops` gist works on PGlite 18 in Step 2; if it does not, fall back to a `FOR UPDATE` check
on the network row plus `&&` in the handler.

**Method rules:**
- **`networks.create`:**
  - **Input:** `{ tenantId, projectId?, poolId, name, description?, idempotencyKey }`.
  - The pool must be visible to the tenant (`visibleVpsPool`), `class='provider'`, and its account's provider must
    implement `networks`. Otherwise → `UNSUPPORTED`.
  - `name` matches `^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$`.
  - Authz upsert: type `network`, parent tenant, `ownerId` = caller.
  - Publishes `network.created`. Enqueues `vps.networks`.
- **`addSubnet`:**
  - **Input:** `{ tenantId, networkId, name, region, cidr }`.
  - `cidr` must be an RFC 1918 range with prefix /8 to /29, and must not overlap (the DB refuses).
  - `region` must be one of the account's configured zones' regions.
- **`removeSubnet`:** refuses while instances use the subnet (`INVALID_STATE` with `details.instanceIds`).
- **`networks.delete`:** refuses while live instances have `network_id` (`INVALID_STATE` with `details.instanceIds`).
  Otherwise it sets `desired_state='deleted'` on the network, subnets and rules.
- **`firewallRules.create`:**
  - **Input:** `{ tenantId, networkId, name, direction, action?='allow', priority?=1000, rules, sources?,
    destinations?, targets?, enabled?=true }`.
  - Every target instance must be in the same tenant and have `network_id = networkId`.
  - At most 100 rules per network (constant `maxRulesPerNetwork = 100`).
- **`firewallRules.update` / `delete`:** bump `version`, then enqueue.

- [ ] **Step 1: Write the failing tests:**
  - `create returns pending and lists for the tenant`
  - `refuses a pool whose provider has no networks`: a Hetzner fake gives `UNSUPPORTED`.
  - `refuses overlapping subnets`: `10.0.0.0/20`, then `10.0.8.0/24`, gives `CONFLICT`.
  - `refuses a public CIDR`: `8.8.0.0/16` gives `INVALID_INPUT`.
  - `refuses deleting a network with instances on it`
  - `firewall rule targets must be on the network`
  - `a different tenant cannot read the network`: `ACCESS_DENIED`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: tenant networks, subnets and firewall rules API`.

### Task 17: The `vps.networks` worker

**Files:**
- Modify: `packages/vps/src/networks.ts`, `module.ts`
- Test: `tests/vps-networks.test.ts` (section `reconcile`)

**Interfaces:**
- **Consumes:** `ProviderNetworks` (Task 1, implemented in Task 6).
- **Produces:** `networksReconciler(): Reconciler` with name `vps.networks`, `shardBy:'none'`, key = network id, and
  `periodic: [{ key: 'all', every: '5m' }]`. Key `all` enqueues every network not `ready`/`deleted`, plus every
  `ready` network for drift.

**Algorithm** for one network. Provider calls happen outside transactions; each result is written in its own short
transaction, and `network.*` events are published on state changes (`network.ready`, `network.error`,
`network.deleted`, `network.subnet.ready`, `network.rule.ready`).

- **Present:**
  1. `ensureNetwork({ name: 'bc-'+labelValue(id) })`
  2. For each present subnet, `ensureSubnet`.
  3. For each enabled present rule, compile and call `ensureFirewall`. The rule's targets compile to
     `targetTags = instanceIds.map(networkTag)`; empty targets mean no `targetTags`, so the rule applies network-wide.
     Disabled rules go to `ensureFirewall` with `disabled: true`.
  4. For each instance with `network_id = id`, `setTags(externalId, [networkTag(instanceId)])`, so tags exist before
     rules match.
  5. If anything is `pending`, re-enqueue with `notBefore` +5 s and return `DONE`. `error` → store the message and
     publish `network.error`.
- **Deleted:** delete the rules, then the subnets, then the network. Each `pending` re-enqueues. When the network
  delete returns `deleted`: set the rows `deleted`, call `authz.remove`, publish `network.deleted`.

- [ ] **Step 1: Write the failing tests:**
  - `converges a network with a subnet and a rule to ready`: tick until `state==='ready'`, at most 5 ticks with
    `operationDelayTicks=1`. The emulator has `bc-<id>`, the subnet and the firewall.
  - `deletes rules then subnets then the network`: assert the order of `DELETE` paths in `emu.requests`.
  - `a rule targeting an instance tags the VM and uses targetTags`
  - `reports a provider error on the network`: `failNext` 400 gives state `error` and a message.
  - `drift: a firewall deleted in GCP is recreated on the periodic pass`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: vps.networks worker converges networks, subnets, rules and tags`.

### Task 18: Instances on networks

**Files:**
- Modify:
  - `packages/vps/src/instances.ts` (`parseCreateInstance` L150 accepts `networkId?` and `subnetId?`;
    `prepareCreateInstance` validates them)
  - `lifecycle.ts` (`reconcileProvider` passes `network` to `create`)
  - `attach.ts` (attach accepts `networkId?`)
  - `apps/docs/descriptions/api/instances.md`
- Test: `tests/vps-networks.test.ts` (section `instances`)

**Interfaces — Produces:**
- **`instances.create`:**
  - The network must belong to the same tenant and be `ready`, and its `provider_account_id` must equal the pool's.
    Otherwise → `INVALID_INPUT`.
  - The subnet must be on the network and `ready`. If omitted, the network's only subnet in the offer's region is
    used; zero or several such subnets → `INVALID_INPUT` naming them.
  - `create` receives `network: { network: 'bc-'+labelValue(networkId), subnet: 'bc-'+labelValue(subnetId),
    tags: [networkTag(instanceId)] }`.
- **`instances.attach` with `networkId`:**
  - Allowed only when the discovered machine's `networks[].network` already names that network's GCE name. Attach
    does not re-NIC a running VM; GCE cannot move a NIC to another VPC without a stop. Otherwise → `INVALID_STATE`,
    with hint "attached VMs keep their existing network".
  - Without `networkId`, `network_id` is set automatically if the VM's NIC is on a tenant network.
- **Instance view:** `Instance` gains optional `networkId?` and `subnetId?` (additive core view edit).

- [ ] **Step 1: Write the failing tests:**
  - `create on a network places the VM in its subnet with its tag`: assert the emulator `networkInterfaces[0].subnetwork`
    ends with `bc-<subnetId>`, and `tags.items` contains `networkTag(id)`.
  - `refuses a network of another tenant`
  - `refuses a network not ready`
  - `picks the only subnet in the region`
  - `attach links a VM already on a tenant network`
  - `attach refuses moving a VM to another network`
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `vps: instances on tenant networks (create and attach)`.

---

## Phase 5 — Docs, surface and verification (R7)

### Task 19: Documentation, generated reference, CHANGELOG, final verification

**Files:**
- Create: `packages/provider-gcp/README.md` (final)
- Modify:
  - `apps/docs/content/docs/guides/vps/providers.mdx` (GCP section)
  - `apps/docs/content/docs/extending/providers.mdx` (the new optional members)
  - `apps/docs/descriptions/api/*.md` (check each new method has prose)
  - `CHANGELOG.md` (Unreleased)
  - `PLAN.md` §16 roadmap (one line per feature)
- Regenerate: `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .` and
  `node apps/docs/scripts/generate.mjs`.

The README must state:
- **GCP IAM roles the account's service account needs:** `roles/compute.instanceAdmin.v1` (instances, labels, tags,
  consuming reservations; on owner and consumer projects for shared reservations), `roles/compute.networkAdmin`
  (networks/subnets), `roles/compute.securityAdmin` (firewalls), and `roles/compute.viewer` (discovery, reservations,
  future reservations). Add `roles/iam.serviceAccountTokenCreator` on the target when `impersonate` is set.
- **The ownership labels** and what `onDelete` does.
- **Reservations:** discovery is every 5 min, so `free` lags GCP by up to one pass. Admission counts pending creates,
  and GCP remains the final referee: a create GCP refuses fails the instance with `CAPACITY_UNAVAILABLE`.
- **Example config:**
  `{ provider:'gcp', config:{ projectId, zones:['us-central1-a'], credentials:'secret://gcp/sa-key' } }`.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `node node_modules/pnpm/bin/pnpm.mjs lint:repo`. Expected: exit 0 (deps, api-surface, docs
  drift, sql-now, authz-matrix).
- [ ] **Step 3:** Announce in the coordination file, then run the full suite with
  `node node_modules/pnpm/bin/pnpm.mjs vitest run`. Expected: PASS, with no new skips beyond the Postgres-only
  suites.
- [ ] **Step 4:** Run `node node_modules/pnpm/bin/pnpm.mjs -r build`. Expected: exit 0.
- [ ] **Step 5: Commit:** `docs: GCP provider, attach, provider reservations and networks`.

---

## Integration notes for legionedge (not tasks in this plan)

legionedge embeds `betterCompute()` with `vps()`, so it gets all of this after a better-compute release. It still
needs these changes:

1. **Register the provider.** Add `gcpProvider({ tokenSource })` to the `vps({ providers })` list in
   `packages/compute/src/modules.ts`, with a `tokenSource` wrapping its `google-auth-library` WIF client. Then
   regenerate `providers.generated.ts`.
2. **Configure the workers.** Set `vps({ discovery: { every: '5m', autoAttach: { ownerIdentityId: <system id> } },
   reservations: { every: '5m' } })`.
3. **Admin console** (`apps/admin`, planned O-21):
   - a "Discovered VMs" page: `providerAccounts.machines`, plus an attach form with
     `instances.attach({ tenantId: <org tenant>, poolId, externalId, ownerIdentityId, onDelete })`
   - a "Reservations" page: `providerAccounts.reservations` plus `bindReservation`
   - an "Issue a VM" form: `instances.create({ tenantId: <org tenant>, poolId, flavor, imageId, ownerIdentityId })`
     (root callers only; the instance is then the customer's, in their `scope: 'mine'` list)
4. **Customer console** (`apps/cloud`):
   - attached VMs show up through the existing `instances.list/get`; add `reboot` and `detach` to the facade in
     `apps/cloud/lib/compute/service/api.ts`
   - replace the JSON-file firewall store (`apps/cloud/lib/firewall-store.ts`) with `networks.*` and
     `firewallRules.*`; the `FirewallRule` shape maps 1:1 except `target` (label selector) → `targets.instanceIds`
5. **IAM role templates.** New actions and the resource type they act on:
   - `compute:instances:attach` on `compute-instance`: platform roles (root tenant). In a customer tenant only
     `compute-admin` needs it, and only to attach from the tenant's own (BYO) accounts: attaching from a root account
     is the platform's alone whatever the grant.
   - `compute:instances:update` and `compute:instances:delete` now also cover `reboot` and `detach` (no new
     action); `compute-operator` keeps them, ideally conditioned on `resource.ownerId == ${principal.id}` so
     operators control what was issued to them.
   - `compute:networks:create`, `read`, `update`, `delete` on `compute-network` (a child of `compute-tenant`;
     attributes `providerAccountId`, `poolId`, `projectId`), and `compute:networks:read` on `compute-tenant`
     (`networks.list`): `compute-admin` and `compute-operator`. `firewallRules.*` decide on the network.
   - `compute:providers:read` / `manage` on `compute-provider-account` now also gate `machines`, `discover`,
     `reservations`, `bindReservation` and `unbindReservation`: platform roles for root accounts; a tenant's
     `compute-admin` for its own accounts only.
   The bridge plugin's resource types come from core's catalog (`computeResourceTypes()`), so `compute-network` is
   there once legionedge upgrades; check any hand-kept list.
6. **API changes to adopt.**
   - `instances.create` takes `ownerIdentityId` (root callers creating in another tenant only); `instances.attach`
     takes it on the same terms now (a tenant attaching from its own account owns what it attaches). With the embedded
     bridge the owner must be an active member of the tenant (`IamPort.isMember`; `INVALID_INPUT` otherwise).
   - Auto-attach owner labels (`better-compute-owner`) count only on platform accounts, for members of the labelled
     tenant; on a tenant's own account they are ignored (`AUTO_ATTACH_OWNER_IGNORED`).
   - `pools.create` refuses a provider account of another tenant (`NOT_FOUND`); `pools.get`/`list` omit
     `providerAccountId` for tenants a pool is offered to, so the customer console must not rely on it.
   - Provider-account configs of customer tenants may name only `secret://<tenant>/…` (and allow-listed
     `vault://` paths, `vps({ tenantVaultPaths })`); a customer GCP account must bring its own key.
   - `providerAccounts.machines` on a customer's own account omits other tenants' `instanceId`/`tenantId`.
   - New error and event details to surface: `ProvisionFailed`, `OwnershipLost`, `AttachConflict`,
     `QUOTA_EXCEEDED` with `details.limit` for network caps (10 networks per tenant, 16 subnets, 100 rules).
   - Before upgrading, run the CHANGELOG's query for pools on another tenant's account (0.1.x allowed them).
7. **Per-tenant projects.** `12-gcp-hosted-compute.md` (one GCP project per tenant) needs the `resolveTarget` hook
   (P-28). Until then, one root GCP account serves all tenants, and per-tenant VPCs isolate their traffic.

## Follow-ups (separate plans)

- **bcd on GCE:** cloud-iid evidence in the Go daemon, plus a production `cloudIid.resolve` that maps
  `(project, instance)` → account → pool. This makes attached GCE VMs full nodes (GPU inventory, MIG, gang
  scheduling).
- **Elastic capacity:** GPU `reservations.create` on a GCP-backed pool spins up a VM from a bound reservation and
  books it once bcd joins.
- **VM access:** an SSH-key push (GCE metadata `ssh-keys`) and serial-console tickets for provider instances
  (`instances:exec`).
- **Hosted pools:** reboot for hosted (vps-host) instances.
- **Other clouds:** an AWS provider with the same optional members (`discover`, `listReservations` for capacity
  reservations / capacity blocks, `networks` for VPCs).
