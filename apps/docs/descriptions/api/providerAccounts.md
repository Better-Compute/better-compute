Provider accounts connect a tenant to an external provider registered with `vps({ providers })`, such as a cloud or a dedicated-server host. Each account's `config` is validated by its provider's manifest and holds secret references, never secret values. Provider pools create instances through an account, and `bootstrap` turns one of its machines into a bcd host. See [Providers](/docs/guides/vps/providers).

## create

Stores a provider account for the tenant after validating its `config` with the provider's manifest; returns the account.

- **Idempotency.** `idempotencyKey` is optional. With a key, the account id derives from the tenant, the caller and the key, and a repeat returns the stored account without a second IAM decision; a different `provider` or `name` under the same key is `CONFLICT`. A name the tenant already uses for another account is also `CONFLICT`.
- **IAM.** Decided as `compute:providers:manage` on the tenant.
- **Secret references.** An account of the root (platform) tenant may name any `secret://`, `vault://` or `env://` reference. An account of any other tenant, for every provider, may name only `secret://<its tenant>/…` references (secrets it put with `secrets.put`), plus the `vault://` paths the host allows that tenant with `vps({ tenantVaultPaths })` (an entry ending in `/` allows every path under it). It may never name `env://`, which reads the control plane's own environment, nor another tenant's or the platform's secrets: the account would run on the platform's credentials. The same rule holds when the provider resolves the account's credentials: a stored account that names a reference it may not use (written before this rule, or around the API) fails that call with `ACCESS_DENIED` and the value is never read, and a tenant's `secret://` reference is resolved for that tenant, so the store refuses a secret whose stored tenant is another.
- **Errors.** `INVALID_INPUT` for an unknown provider (`details.known` lists the registered ones), a config the manifest rejects (`details.issues`), or a field ending in `token`, `secret`, `password` or `key` whose value is not a `secret://`, `vault://` or `env://` reference. `INVALID_CONFIG` for a secret reference the account may not use (see above; `details.path` names the field, `details.reason` is `secretRefScope`), or when the provider refuses to build a client for the account: a Google Cloud account of a tenant other than the root (platform) tenant must name its own service-account key in `credentials`, or instead sign in keyless with `federationAudience` (its workload identity pool provider, `//iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`; see `federationSetup`), because without either it would run on the control plane's own identity (the metadata server or the host's token source).
- **Pass-through (`billing`).** `billing.passThrough` (at most 50 rules of `{ skuPattern, meter, multiplier }`) passes the account's provider costs through to tenants (D11). The `vps.costs` worker reads the account's cost rows (for Google Cloud, the BigQuery billing export named by `billingExport`) and attributes each to a tenant by its `better-compute-instance` label (the instance's tenant), else its `better-compute-tenant` label. A regular-usage row attributed to a tenant other than the platform (and, for a row of an instance, an instance root bills: not `billing: none`, in a pool whose billing mode is `metered`), in the deployment currency (`vps({ billing: { currency } })`), whose SKU id or description contains `skuPattern` (case-insensitive; the first matching rule wins) and whose net cost (cost + credits) is positive becomes one usage event on `meter` for that tenant: `quantity` the row's usage, `cost` = net cost × `multiplier`, `occurredAt` the usage start (or, for a row whose usage month has already closed, `vps({ billing: { closeGraceHours } })` hours after the month ends, default 6, the first hour of the current UTC month: a late charge on the next statement, with the same key; the stored row keeps its usage start), tags `region`, `provider`, `source: cost` and the instance's `pool`, key `costx:<accountId>:<rowId>`. It is written as a `cost` usage window and recorded by the normal usage flush, once: a later correction of the row is published as `billing.cost-corrected` with `passedThrough: true` for a root credit note, never billed again. Rules are allowed only on the root (platform) tenant's accounts (another tenant's account is `INVALID_INPUT`: its costs are its own and are never passed through) and only for providers that declare which SKUs compute meters itself. `meter` must be a `reported` meter on the IAM root tenant (create it on the root tenant with `pricing: 'reported'`, through better-iam's `billing.createMeter` or the IAM port's `ensureMeters`: `billing.syncMeters` creates only the catalog's rate-card meters; otherwise `INVALID_INPUT`, and `UNSUPPORTED` when the IAM port cannot list meters); `multiplier` is 1 to 10. A `skuPattern` that matches a SKU family compute meters itself (for Compute Engine, `core`, `ram`, `gpu` and `instance` SKUs, and persistent disk and Hyperdisk capacity, local SSD storage (`SSD backed Local Storage`) and external IP charges) is `INVALID_CONFIG` (`details.reason` `meteredSku`), and a row of such a SKU is never passed through whatever the pattern, so nothing is billed twice.
- **Keyless Google Cloud accounts.** For an account with `federationAudience`, `create` and `update` exchange tokens with Google before the account is stored, with no transaction open, and refuse it with `INVALID_CONFIG` and `details.reason`: `credentialsAndFederation` (both `credentials` and `federationAudience`), `noWorkloadIssuer` (the host runs no workload issuer), `federationAudience` (not a workload identity pool provider's resource name), `federationTrustsAnySubject` (the pool provider also accepts a subject that is not this account's: its attribute condition must be exactly `federationSetup`'s), `federationRefused` (Google STS refuses the account's own subject), `impersonationRefused` (the account may not impersonate the `impersonate` service account) or `projectAccess` (the resulting token cannot read the project). An audience another provider account already uses, of this tenant or any other, is `CONFLICT` with the message `Another provider account already uses this gcp identity` and no `details`. Google being unreachable, slow or throttling is `UNAVAILABLE` or `RATE_LIMITED`, retryable: nothing is stored, and a retry with the same `idempotencyKey` runs the checks again.

## list

Returns the tenant's provider accounts, sorted by name.

Each `config` holds only secret references.

## connectSetup

Returns the provider's authorization URL for connecting an account with OAuth (`{ authorizeUrl }`): the person's browser goes there, signs in at the provider and comes back to `redirectUri` with a code and the caller's `state`. See [Connect a DigitalOcean account](/docs/operations/digitalocean).

- **Input.** `tenantId`, `provider`, `redirectUri` (one the platform registered for the provider's OAuth app, exactly as written) and `state` (16 to 256 URL-safe characters: the caller's anti-forgery value, which it keeps and compares on the way back). Nothing is stored and no provider is called.
- **IAM.** Decided as `compute:providers:read` on the tenant.
- **Errors.** `UNSUPPORTED` for a provider without a connect flow (DigitalOcean has one only when the host registers at least one redirect URI). `INVALID_INPUT` for an unknown provider, an invalid `state`, or a redirect URI the platform did not register.

## connect

Stores a provider account whose credential comes from an OAuth authorization code; returns the account, as `create` does.

- **Input.** `tenantId`, `provider`, `name`, `code` (the code the redirect carried; single use), `redirectUri` (the one `connectSetup` was given), `config` (the rest of the account's config, without the credential field: naming it is `INVALID_INPUT`) and an optional `idempotencyKey`.
- **Flow.** With no transaction open, the provider trades the code for a credential (DigitalOcean: a refresh token), which is sealed in the deployment's secret store for the tenant and named in the provider's credential field (`refreshToken`); the account's config is then checked as in `create` and the account stored. The credential is never stored elsewhere, logged or answered. When the account is not stored (a refused check, a name the tenant already uses, a failed transaction, or a request that never reaches the store) the sealed credential is deleted again.
- **Idempotency.** As `create`: with a key, a repeat returns the stored account without spending another code; a different `provider` or `name` under the same key is `CONFLICT`. A retry without the key needs a new code.
- **IAM.** Decided as `compute:providers:manage` on the tenant.
- **Errors.** `UNSUPPORTED` for a provider without a connect flow. `INVALID_INPUT` for a code the provider refuses, a redirect URI the platform did not register, or a config naming the credential field. `INVALID_CONFIG` when the host runs no secret broker, or as in `create`. `CONFLICT` for a name the tenant already uses.

## check

Asks the provider what a stored account's credential may do, read-only at the provider; returns `{ accountId, provider, checkedAt, ok, missing, optional?, details? }`.

- **Output.** `ok` is true when the credential may do everything instances need (`missing` is empty). `missing` lists the permissions instances need that it lacks, `optional` those only optional features need (costs, metrics, security findings), in the provider's own names (DigitalOcean: token scopes such as `droplet:read`). `details` is the provider's own detail (DigitalOcean: the account's status and per-family results), never a secret.
- **Reads.** The stored config is validated and its secret references checked again, exactly as for a client. A provider with no probe but an account check answers `ok` when the check passes. The call stops reaching the provider when the request is cancelled.
- **IAM.** Decided as `compute:providers:read` on the provider account.
- **Errors.** `NOT_FOUND` for a missing account. `UNSUPPORTED` for a provider that cannot check an account. `INVALID_CONFIG` when the provider refuses the credential outright (a revoked DigitalOcean token, or an OAuth grant that must be connected again, `details.reason` `oauthGrant`); `UNAVAILABLE` or `RATE_LIMITED` when the provider cannot be asked (an OAuth refresh token another process may still be rotating is `UNAVAILABLE`, `oauthRace`, the first time).

## findings

Returns what the provider says an operator should look at on a stored account (DigitalOcean: its latest security scan), read-only at the provider: `{ accountId, provider, readAt, items }`.

- **Items.** Each is `{ id, kind, severity, title, detail?, at?, group? }`: `id` is stable across reads (the provider's rule id) and unique in one answer, `kind` says what it is about (`security`), `severity` is `critical`, `warning` or `info`, and `group` joins findings that read as one. Malformed findings and repeated ids are left out, and at most 200 are kept. A part of the account the credential may not read is itself a finding (DigitalOcean without `security:read`: `security:unreadable`), never an empty answer that looks clean. Never a secret.
- **Reads.** With the account's own credential, as `check`; the call stops reaching the provider when the request is cancelled. The admin panel reads it at most every ten minutes per account.
- **IAM.** Decided as `compute:providers:read` on the provider account.
- **Errors.** `NOT_FOUND` for a missing account; `UNSUPPORTED` for a provider that reports no findings; the provider's errors as in `check`.

## federationSetup

Returns what a tenant sets up at its cloud to give a provider account keyless sign-in (Google Cloud workload identity federation), for the account it is about to create: `{ issuer, jwksUri, subject, attributeCondition, allowedAudienceHint }`.

- **Input.** `tenantId`, `provider` and `name`: the `provider` and `name` the tenant will give `create`. Nothing is stored and no provider is called.
- **Output.** `issuer` is the control plane's workload issuer and `jwksUri` its keys (`<issuer>/jwks.json`). `subject` is `compute-account:<tenantId>/<provider>/<name>`, exactly the subject `create` gives the account (vps builds it in one place). `attributeCondition` is the CEL condition `assertion.sub == "<subject>"` to set on the tenant's workload identity pool provider, so it trusts that account and no other. `allowedAudienceHint` is the shape of the pool provider's resource name as an `https://` URL, with `<PROJECT_NUMBER>`, `<POOL>` and `<PROVIDER>` left for the tenant to fill in. See [Keyless GCP accounts](/docs/guides/vps/providers#keyless-gcp-accounts).
- **IAM.** Decided as `compute:providers:read` on the tenant.
- **Errors.** `INVALID_INPUT` for an invalid `name` or `provider`, or an unknown provider (`details.known` lists the registered ones), as in `create`. `INVALID_CONFIG` (`details.reason` `noWorkloadIssuer`) when the host runs no workload issuer.

## get

Returns one provider account of the tenant.

An account of another tenant, or none, is `NOT_FOUND`.

## offers

Asks the provider, through the account, for the machine types it offers; returns them as `items`.

The optional `query` filters by `kind` (`metal` or `vps`), `region`, `gpuModel`, `minGpus`, `minVcpu` and `minMemoryGiB`. The call reaches the provider live. A missing account is `NOT_FOUND`; a stored account naming a secret reference its tenant may not use is `ACCESS_DENIED` (see `create`).

## update

Replaces the account's `config`, validated as in `create`, and increments its version; returns the account. `billing` replaces the pass-through rules (see `create`); absent keeps them, `{}` clears them. Rows already passed through are never passed through again, whatever the new rules say. New rules apply to the account's rows not passed through yet whose usage started within the cost lookback (`vps({ costs: { lookbackDays } })`, default 3): whether each may be passed through is decided again in the same transaction.

The provider and the name cannot change. The next provider call builds a new client from the new config. A missing account is `NOT_FOUND`; an invalid config is `INVALID_INPUT`, and a secret reference the account may not use, or a config the provider refuses to build a client for, is `INVALID_CONFIG`, as in `create`. A keyless Google Cloud account's new config is checked with Google as in `create`, with the same `INVALID_CONFIG` reasons, `CONFLICT` for an audience another account uses, and retryable `UNAVAILABLE` or `RATE_LIMITED`; a refused update changes nothing.

## delete

Deletes a provider account that no pool, no instance and no network uses; returns `deleted: true`.

Archived pools, deleted instances and deleted networks do not count: deleted instances keep their history but drop the reference, and deleted networks, with their subnets and rules, are removed with the account. A pool that is not archived, an instance that is not deleted, or a network that is not deleted (named in the message, ids in `details.networkIds`) on the account makes the call `INVALID_STATE`. A missing account is `NOT_FOUND`.

## bootstrap

Records a request to turn one of the account's machines into a bcd host of a `vps-host` or `metal-host` pool; returns the bootstrap, which the `vps.bootstraps` reconciler then drives to `joined` or `failed`.

- **Input.** Name exactly one of `machineId` (a machine the account already has; starts in `identifying`) or `offerId` (a machine to claim or order; starts in `claiming`). The pool must be owned by the tenant, not archived, and run the `bcd` agent.
- **Idempotency.** `idempotencyKey` is required. A repeat returns the bootstrap's current status; a different request under the same key is `CONFLICT`.
- **Errors.** `INVALID_CONFIG` when `vps()` has no `bootstrap` options or the host has no PKI. `UNSUPPORTED` when the provider cannot identify and bootstrap machines. `NOT_FOUND` for a missing account or a pool the tenant does not own, `INVALID_STATE` for an archived pool, `INVALID_INPUT` for a pool of another class or agent.
- **Events.** `provider.bootstrap.started`; the reconciler later publishes `provider.bootstrap.installed`, `provider.bootstrap.joined` or `provider.bootstrap.failed`. The join token it mints is single-use, bound to the machine, and never returned or stored.

## machines

Lists the machines the `vps.discovery` worker last saw in the account, ordered by zone and machine id; returns `items`, a `cursor` when more remain, and `discoveredAt`, the time of the account's last successful pass.

- **Input.** `filter` is `free` (the default: machines no instance holds), `attached` (machines attached to, or created as, an instance) or `all`. `includeGone` also lists machines the provider stopped reporting, with `goneAt`. `limit` is 1 to 500 (default 100).
- **Output.** Each machine has its state, zone, region, machine type, vCPU, memory, GPUs, labels, networks, addresses and any reservation it consumes. An attached or created machine has `instanceId` and the instance's `tenantId`, unless that instance is another tenant's (the account's pool is offered to it): then both are left out, except for the platform (root callers). A machine bound to a pool (`pools.bindMachines`) has `poolId`.
- **Errors.** An account of another tenant, or none, is `NOT_FOUND`. The worker lists accounts every 5 minutes by default (`vps({ discovery: { every } })`) and never changes a machine.

## discover

Makes the account's next discovery pass due now and wakes the worker; returns `queued: true`.

- **Input.** With `wait: true`, the answer is held, for at most 30 seconds, until a pass that started after the call has finished, and then carries that pass's time as `discoveredAt`. A timeout is not an error: the answer then has no `discoveredAt`.
- **Errors.** `UNSUPPORTED` when the account's provider cannot list its machines. An account of another tenant, or none, is `NOT_FOUND`.
- **Events.** The pass publishes `provider.machine.discovered`, `provider.machine.changed` (with `changes`) and `provider.machine.gone`.

## reservations

Returns the account's provider capacity reservations (for example GCE reservations) as the `vps.reservations` worker last saw them, as `items`.

- **Input.** `includeGone` also lists reservations the provider no longer reports (`goneAt` is set); by default they are left out.
- **Fields.** Each item is the provider's reservation (`id`, `name`, `zone`, `state`, `machineType`, `vcpu`, `memoryGiB`, `gpus`, `total`, `inUse`, `specificOnly`, `shared`, `startsAt`, `endsAt`, `offerId`) plus `pending` (instances admitted against it that the last scan may not have counted yet), `free` (`total - inUse - pending`, never below 0), `observedAt`, and `poolId` and `flavorId` while it is bound.
- **Freshness.** The worker asks each account's provider every `vps({ reservations: { every } })` (default `5m`); accounts whose provider cannot list reservations have none. The call itself does not reach the provider.
- **Events.** The worker publishes `provider.reservation.detected`, `changed`, `ready` (a scheduled or creating reservation became ready) and `gone`.
- **Errors.** `NOT_FOUND` for a missing account.

## bindReservation

Makes a reservation usable from a provider pool: creates a flavor in the pool whose offer is the reservation's, and remembers the binding; returns `poolId` and `flavorId`.

- **Input.** The pool must be a provider pool of this account that the tenant owns. The reservation must be `ready` and not gone: a `scheduled` future reservation is listed but cannot be bound, because the provider fulfils it under a new id; bind it once it is ready. The flavor is named `flavorName`, default `rsv-<reservation name>`, and takes the reservation's `vcpu`, `memoryGiB` and GPU count; its disk is the account's `config.diskGiB` (default 100).
- **Idempotency.** `idempotencyKey` is required. Binding a reservation to the pool it is already bound to returns the existing binding; binding it to another pool is `CONFLICT`, as is a flavor name the pool already uses.
- **Admission.** `instances.create` on the flavor locks the reservation and takes one free slot, so concurrent creates cannot over-commit it. Between two scans a create counts the instances it admitted that the provider has not reported yet (`pending`). With no free slot, or a reservation that is not `ready` (a reservation that went away or is not ready cannot be bound, so this only happens after a binding was made and the reservation then changed), the create fails with `CAPACITY_UNAVAILABLE` and `details` naming `reservationId`, and `total`, `inUse`, `pending` or `state`.
- **Errors.** `NOT_FOUND` for a missing account, reservation, or a pool the tenant does not own. `INVALID_INPUT` for a pool that is not a provider pool of this account. `INVALID_STATE` for an archived pool, a gone reservation, or one that is not `ready` (`details` names `reservationId` and `state`).
- **IAM.** Decided as `compute:providers:manage` on the provider account.

## unbindReservation

Removes a reservation's binding; returns `reservationId`.

The flavor `bindReservation` created is deleted if no instance uses it, and archived otherwise (instances that use it keep running; no new instance can use it). Unbinding a reservation that is not bound succeeds. The worker does the same when a bound reservation is no longer reported, and then publishes `provider.reservation.gone` with `poolId` and `flavorId`. A missing account or reservation is `NOT_FOUND`.
