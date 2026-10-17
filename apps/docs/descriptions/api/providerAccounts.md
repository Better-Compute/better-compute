Provider accounts connect a tenant to an external provider registered with `vps({ providers })`, such as a cloud or a dedicated-server host. Each account's `config` is validated by its provider's manifest and holds secret references, never secret values. Provider pools create instances through an account, and `bootstrap` turns one of its machines into a bcd host. See [Providers](/docs/guides/vps/providers).

## create

Stores a provider account for the tenant after validating its `config` with the provider's manifest; returns the account.

- **Idempotency.** `idempotencyKey` is optional. With a key, the account id derives from the tenant, the caller and the key, and a repeat returns the stored account without a second IAM decision; a different `provider` or `name` under the same key is `CONFLICT`. A name the tenant already uses for another account is also `CONFLICT`.
- **IAM.** Decided as `compute:providers:manage` on the tenant.
- **Errors.** `INVALID_INPUT` for an unknown provider (`details.known` lists the registered ones), a config the manifest rejects (`details.issues`), or a field ending in `token`, `secret`, `password` or `key` whose value is not a `secret://`, `vault://` or `env://` reference. `INVALID_CONFIG` when the provider refuses to build a client for the account: a Google Cloud account of a tenant other than the root (platform) tenant must name its own service-account key in `credentials`, because without one it would run on the control plane's own identity (the metadata server or the host's token source).

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

The provider and the name cannot change. The next provider call builds a new client from the new config. A missing account is `NOT_FOUND`; an invalid config is `INVALID_INPUT`, and one the provider refuses to build a client for is `INVALID_CONFIG`, as in `create`.

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
- **Output.** Each machine has its state, zone, region, machine type, vCPU, memory, GPUs, labels, networks, addresses and any reservation it consumes. An attached or created machine has `instanceId` and the instance's `tenantId`.
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
