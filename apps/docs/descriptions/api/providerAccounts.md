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
