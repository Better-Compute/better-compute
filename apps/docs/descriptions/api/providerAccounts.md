Provider accounts connect a tenant to an external provider registered with `vps({ providers })`, such as a cloud or a dedicated-server host. Each account's `config` is validated by its provider's manifest and holds secret references, never secret values. Provider pools create instances through an account, and `bootstrap` turns one of its machines into a bcd host. See [Providers](/docs/guides/vps/providers).

## create

Stores a provider account for the tenant after validating its `config` with the provider's manifest; returns the account.

- **Idempotency.** `idempotencyKey` is optional. With a key, the account id derives from the tenant, the caller and the key, and a repeat returns the stored account without a second IAM decision; a different `provider` or `name` under the same key is `CONFLICT`. A name the tenant already uses for another account is also `CONFLICT`.
- **IAM.** Decided as `compute:providers:manage` on the tenant.
- **Errors.** `INVALID_INPUT` for an unknown provider (`details.known` lists the registered ones), a config the manifest rejects (`details.issues`), or a field ending in `token`, `secret`, `password` or `key` whose value is not a `secret://`, `vault://` or `env://` reference.

## list

Returns the tenant's provider accounts, sorted by name.

Each `config` holds only secret references.

## get

Returns one provider account of the tenant.

An account of another tenant, or none, is `NOT_FOUND`.

## offers

Asks the provider, through the account, for the machine types it offers; returns them as `items`.

The optional `query` filters by `kind` (`metal` or `vps`), `region`, `gpuModel`, `minGpus`, `minVcpu` and `minMemoryGiB`. The call reaches the provider live. A missing account is `NOT_FOUND`.

## update

Replaces the account's `config`, validated as in `create`, and increments its version; returns the account.

The provider and the name cannot change. The next provider call builds a new client from the new config. A missing account is `NOT_FOUND`; an invalid config is `INVALID_INPUT`.

## delete

Deletes a provider account that no pool and no instance uses; returns `deleted: true`.

Archived pools and deleted instances do not count: deleted instances keep their history but drop the reference. A pool that is not archived, or an instance that is not deleted, on the account makes the call `INVALID_STATE`. A missing account is `NOT_FOUND`.

## bootstrap

Records a request to turn one of the account's machines into a bcd host of a `vps-host` or `metal-host` pool; returns the bootstrap, which the `vps.bootstraps` reconciler then drives to `joined` or `failed`.

- **Input.** Name exactly one of `machineId` (a machine the account already has; starts in `identifying`) or `offerId` (a machine to claim or order; starts in `claiming`). The pool must be owned by the tenant, not archived, and run the `bcd` agent.
- **Idempotency.** `idempotencyKey` is required. A repeat returns the bootstrap's current status; a different request under the same key is `CONFLICT`.
- **Errors.** `INVALID_CONFIG` when `vps()` has no `bootstrap` options or the host has no PKI. `UNSUPPORTED` when the provider cannot identify and bootstrap machines. `NOT_FOUND` for a missing account or a pool the tenant does not own, `INVALID_STATE` for an archived pool, `INVALID_INPUT` for a pool of another class or agent.
- **Events.** `provider.bootstrap.started`; the reconciler later publishes `provider.bootstrap.installed`, `provider.bootstrap.joined` or `provider.bootstrap.failed`. The join token it mints is single-use, bound to the machine, and never returned or stored.

## reservations

Returns the account's provider capacity reservations (for example GCE reservations) as the `vps.reservations` worker last saw them, as `items`.

- **Input.** `includeGone` also lists reservations the provider no longer reports (`goneAt` is set); by default they are left out.
- **Fields.** Each item is the provider's reservation (`id`, `name`, `zone`, `state`, `machineType`, `vcpu`, `memoryGiB`, `gpus`, `total`, `inUse`, `specificOnly`, `shared`, `startsAt`, `endsAt`, `offerId`) plus `pending` (instances admitted against it that the last scan may not have counted yet), `free` (`total - inUse - pending`, never below 0), `observedAt`, and `poolId` and `flavorId` while it is bound.
- **Freshness.** The worker asks each account's provider every `vps({ reservations: { every } })` (default `5m`); accounts whose provider cannot list reservations have none. The call itself does not reach the provider.
- **Events.** The worker publishes `provider.reservation.detected`, `changed`, `ready` (a scheduled or creating reservation became ready) and `gone`.
- **Errors.** `NOT_FOUND` for a missing account.

## bindReservation

Makes a reservation usable from a provider pool: creates a flavor in the pool whose offer is the reservation's, and remembers the binding; returns `poolId` and `flavorId`.

- **Input.** The pool must be a provider pool of this account that the tenant owns. The reservation must be `ready` or `scheduled` and not gone. The flavor is named `flavorName`, default `rsv-<reservation name>`, and takes the reservation's `vcpu`, `memoryGiB` and GPU count; its disk is the account's `config.diskGiB` (default 100).
- **Idempotency.** `idempotencyKey` is required. Binding a reservation to the pool it is already bound to returns the existing binding; binding it to another pool is `CONFLICT`, as is a flavor name the pool already uses.
- **Admission.** `instances.create` on the flavor locks the reservation and takes one free slot, so concurrent creates cannot over-commit it. Between two scans a create counts the instances it admitted that the provider has not reported yet (`pending`). With no free slot, or a reservation that is not `ready` (a `scheduled` future reservation is bindable but not usable until it is fulfilled), the create fails with `CAPACITY_UNAVAILABLE` and `details` naming `reservationId`, and `total`, `inUse`, `pending` or `state`.
- **Errors.** `NOT_FOUND` for a missing account, reservation, or a pool the tenant does not own. `INVALID_INPUT` for a pool that is not a provider pool of this account. `INVALID_STATE` for an archived pool, a gone reservation, or one that is not `ready` or `scheduled`.
- **IAM.** Decided as `compute:providers:manage` on the provider account.

## unbindReservation

Removes a reservation's binding; returns `reservationId`.

The flavor `bindReservation` created is deleted if no instance uses it, and archived otherwise (instances that use it keep running; no new instance can use it). Unbinding a reservation that is not bound succeeds. The worker does the same when a bound reservation is no longer reported, and then publishes `provider.reservation.gone` with `poolId` and `flavorId`. A missing account or reservation is `NOT_FOUND`.
