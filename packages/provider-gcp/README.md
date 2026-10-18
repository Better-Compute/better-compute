# @better-compute/provider-gcp

A Google Compute Engine provider for better-compute: VMs as VPS instances and offers (including GPU machine types), with attach, reservations and tenant networks. It talks to the Compute Engine REST v1 API over plain `fetch` and has no npm dependencies beyond `@better-compute/core` and `@better-compute/vps`.

It is not part of the `better-compute` umbrella: install it next to `better-compute`.

```sh
npm install @better-compute/provider-gcp
```

## Configuration

An account is data, validated by the provider's manifest:

| Field               | Meaning                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `projectId`         | The Google Cloud project id.                                                                          |
| `zones`             | At least one zone. Offers, discovery and reservations are limited to these.                           |
| `credentials`       | A secret reference to a service-account key JSON. Absent: the host identity (platform accounts only). |
| `impersonate`       | A service-account email to impersonate with the base credentials.                                     |
| `network`, `subnet` | Used by `create` when no tenant network is given (default network `default`).                         |
| `imageProject`      | Where image families resolve (default `ubuntu-os-cloud`).                                             |
| `diskGiB`           | Boot disk size (default 100).                                                                         |
| `discoverLabel`     | `key=value`: discovery yields only VMs carrying this label.                                           |

## Usage

```ts
import { vps } from 'better-compute/vps';
import { gcp } from '@better-compute/provider-gcp';

vps({
  providers: [gcp],
  discovery: { every: '5m' }, // the vps.discovery worker (attach)
  reservations: { every: '5m' }, // the vps.reservations worker
});

// An account is data. The key is a SecretRef, never a value.
await client.providerAccounts.create({
  tenantId,
  provider: 'gcp',
  name: 'main',
  // A tenant's account names its own key: secret://<tenantId>/… (see Authentication).
  config: {
    projectId: 'my-project',
    zones: ['us-central1-a'],
    credentials: `secret://${tenantId}/gcp-sa-key`,
  },
});
```

`gcpProvider({ fetch, endpoint, tokenSource, operationPollMs })` swaps the transport, the API endpoint, the token source (a host's workload-identity client, used only by platform accounts that name no key) and the in-call operation poll interval (default 2 s, used only for waits of at most 20 s).

**Universe domains.** `gcpProvider({ universeDomain: 'example-tpc.goog' })` runs the provider in another Google Cloud universe (a Trusted Partner Cloud or sovereign deployment; default `googleapis.com`). The compute endpoint becomes `https://compute.<universe>/compute/v1` (an explicit `endpoint` still wins), impersonation calls `iamcredentials.<universe>`, and a service-account key may name only `https://oauth2.<universe>/token` as its `token_uri`. The universe is host configuration and never comes from a key: a key's own `universe_domain` must equal it (absent means `googleapis.com`), or the key is `INVALID_CONFIG` (`details.reason` `universeDomain`). A malformed universe is `INVALID_CONFIG` (`details.reason` `endpoint`) when the provider is built.

## IAM roles

The account's service account (the key's, the metadata server's, or the impersonated one) needs:

| Role                             | For                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `roles/compute.instanceAdmin.v1` | Creating, deleting and powering instances, writing their labels and network tags, and consuming reservations. For shared reservations: on the owner and the consumer projects. |
| `roles/compute.networkAdmin`     | Tenant networks and subnets.                                                                                                                                                   |
| `roles/compute.securityAdmin`    | Firewall rules.                                                                                                                                                                |
| `roles/compute.viewer`           | Discovery, reservations and future reservations, machine types and operations.                                                                                                 |

With `impersonate` set, the base credentials also need `roles/iam.serviceAccountTokenCreator` on the impersonated service account.

## Ownership labels

better-compute marks the VMs it owns with labels, and acts only on VMs that carry them:

| Label                                      | Written by                                                        | Means                                           |
| ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| `better-compute-instance=<id>`             | `create`, and `claim` when an instance is attached                | The instance this VM belongs to.                |
| `better-compute-managed=true`              | `create`, and `claim` with `managed` (an `onDelete: 'delete'`)    | better-compute may delete the VM.               |
| `better-compute-tenant`, `-pool`, `-owner` | you, on VMs to auto-attach (`vps({ discovery: { autoAttach } })`) | The tenant, pool and owner an auto-attach uses. `-owner` counts only on a platform account, and only for an active member of the tenant (when the IAM port can say); on a tenant's own account it is ignored and the configured owner gets the instance. |

- **`delete`** deletes only VMs labelled `better-compute-managed=true`; any other is `INVALID_STATE`. **`power`** acts only on VMs carrying `better-compute-instance`.
- **`onDelete`** is chosen when a VM is attached (`instances.attach`). `detach`, the default, removes `better-compute-instance` when the instance is deleted and leaves the VM running with every other label. `delete` first writes `better-compute-managed=true` and then deletes the VM.
- **Ownership is re-checked on every read.** Once vps has claimed a VM, a read that shows the instance label gone or naming another instance fails the instance with an `OwnershipLost` condition. vps then never powers, deletes or relabels that VM again, and deleting the instance finishes as a detach with no call to GCE.

## Machines

A VM's id is `zone/name`. An offer's id is `zone/machineType`, or `zone/machineType@reservation` for capacity held by a reservation.

- **Offers** come from the machine types of the configured zones. A `gpuModel`/`minGpus` query keeps accelerator-optimized types (`a2`, `a3`, `a4`, `g2`) that match. Accelerators map to the pool `gpuModel` strings (`H100`, `H200`, `B200`, `A100`, `L4`, `L40S`).
- **`create`** is idempotent through GCE's `requestId` (a UUIDv5 of the idempotency key) and does not wait for the operation: the reconciler polls `get`. The VM is named `bc-` plus the lower-cased instance id. It boots from an image family in `imageProject` (or a full image URL), passes user data as the `user-data` metadata key, and uses the given `NetworkRef` (a tenant network's VPC, subnet and tags) or the account's `network`/`subnet`. GPU types are set to terminate on host maintenance. An offer with `@reservation` consumes that reservation by name (`SPECIFIC_RESERVATION`).
- **`get`** of a VM GCE does not show yet reads the VM's newest insert operation: still running is a `pending` machine; failed throws the operation's error (`ZONE_RESOURCE_POOL_EXHAUSTED` is `CAPACITY_UNAVAILABLE`, a quota is `QUOTA_EXCEEDED`); no operation is no machine.
- **A failed create ends the instance.** When GCE refuses an insert for capacity or quota, at once or after accepting it, vps moves the instance to `error` with a `ProvisionFailed` condition (reason `CAPACITY_UNAVAILABLE` or `QUOTA_EXCEEDED`) and publishes `instance.failed`. It does not retry and asks GCE nothing more about it. The quota stays charged until the instance is deleted, and deleting it finishes without a VM to delete.
- **`power`:** `graceful-restart` is a stop (waited for, at most 20 s) then a start; `reset` is a reset; `nmi` is `UNSUPPORTED`.
- **`list`** yields the managed VMs in the configured zones.

## Attach

`discover` yields every VM of the configured zones (optionally only those with `discoverLabel`), with shape, GPUs, labels, networks, the reservation it consumes and its creation time. vps's `vps.discovery` worker stores them for `providerAccounts.machines`, and `instances.attach` turns a free one into an instance of a customer tenant.

`claim` writes `better-compute-instance=<instance id>` under the VM's label fingerprint (one retry on a stale fingerprint; `CONFLICT` if another instance holds the label), and with `{ managed: true }` also `better-compute-managed=true`. `release` removes only its own label and leaves every other one.

## Reservations

`listReservations` reads on-demand reservations (own and shared in) and future reservations that are still to be fulfilled, limited to the configured zones.

- Own reservations have the id `zone/name`. A reservation shared in has `projects/<owner>/zones/<zone>/reservations/<name>`, and its offer suffix is `projects/<owner>/reservations/<name>`. Future reservations get the prefix `future:`.
- The shape comes from `instanceProperties`, else from the machine type, else from the `sourceInstanceTemplate`.
- `listOffers` adds one offer per ready reservation, available while it has unused capacity.

How vps uses them:

- **Detection lags.** The `vps.reservations` worker asks every 5 minutes by default (`vps({ reservations: { every } })`), so `free` in `providerAccounts.reservations` can be up to one pass behind GCP.
- **Binding.** `providerAccounts.bindReservation` turns a `ready` reservation into a flavor of a provider pool. A future reservation is listed but can be bound only once it is ready, because GCP fulfils it as a new reservation.
- **Admission.** `instances.create` on a bound flavor takes a free slot under a database lock and counts the creates admitted since the last scan, so concurrent creates never over-commit what the scan saw. GCP remains the final referee: a create GCP refuses fails the instance with `ProvisionFailed`/`CAPACITY_UNAVAILABLE` (see above), and its slot is free again at once.

## Networks

`networks` creates custom-mode VPC networks, subnets and firewall rules, and sets managed network tags. The names and tags come from the caller (vps names each resource `bc-` plus its id, and tags each VM `bc-` plus 16 hex digits of the sha256 of its instance id) and are used as given.

- Every `ensure*`/`delete*` call returns at once. It answers `pending` (`deleting`) while the GCE operation runs and the reconciler calls again. Nothing is persisted: a call re-reads the resource.
- A firewall that exists with a different body is patched. A subnet that exists with another range, or a firewall with the opposite action, is reported as `error`.
- A network or subnet that is still in use reports `pending` with a message, never an error.
- `setTags` replaces the tags starting with `bc-` and keeps every other tag. It refuses VMs without the instance label.

## Authentication

`serviceAccountTokenSource(keyJson)` signs a JWT with the key and exchanges it at the OAuth token endpoint. `metadataTokenSource()` reads the metadata server. `impersonatedTokenSource(base, email)` exchanges a base token through IAM Credentials. Each caches its token until a minute before expiry. A host that has its own workload-identity client passes `tokenSource` in the provider options. Tokens are never logged.

**Tenant accounts bring their own key.** An account without `credentials` runs on the host's own identity (`tokenSource`, else the metadata server), which is the control plane's. vps tells the provider whose account it builds a client for (`ProviderContext.account`), and only an account of the root (platform) tenant may do that: a tenant's account without `credentials`, or with `impersonate` but no `credentials`, is `INVALID_CONFIG` at `providerAccounts.create` and `update` (and on every use, for a row stored before). Otherwise a tenant naming the platform's project would list, attach and delete the platform's VMs. `tokenSource` never overrides an account's `credentials`.

**The key must be the tenant's own.** `credentials` on a tenant's account is a `secret://<its tenant>/…` reference (or a `vault://` path `vps({ tenantVaultPaths })` allows it); `env://`, another tenant's and the platform's secrets are `INVALID_CONFIG`, as for every provider (see `providerAccounts.create` in the API reference).

**A pool runs only on its own tenant's account.** A provider pool must be backed by an account of the pool's owner tenant (`pools.create` refuses another's, and vps never uses one), so a tenant cannot reach the platform's project by pointing a pool of its own at the platform's account. The platform reaches tenants by offering its pools, attaching VMs to them and issuing new ones (`instances.create` with `ownerIdentityId`); see "Platform-issued compute" in the providers guide.

**The key's `token_uri` is pinned.** The key JSON comes from the tenant, and the control plane POSTs the signed JWT to its `token_uri`. So `token_uri` must be absent (the default, `https://oauth2.googleapis.com/token`), that URL, or its older alias `https://accounts.google.com/o/oauth2/token`, compared exactly. Anything else, such as an address inside the platform's network, is `INVALID_CONFIG` (`details.reason` `tokenUri`) on the first call that needs a token, and nothing is fetched.

## Errors

Compute Engine errors map to `ComputeError` codes (404 `NOT_FOUND`, 409 `alreadyExists` `CONFLICT`, 429 or a rate-limit 403 `RATE_LIMITED` with `retryAfterMs`, `quotaExceeded` `QUOTA_EXCEEDED`, other 403 `ACCESS_DENIED`, 400 `resourceNotReady` (a VM mid-transition) `UNAVAILABLE` with `retryAfterMs`, other 400 `INVALID_INPUT`, 5xx `UNAVAILABLE`). A failed operation maps by its error code (`ZONE_RESOURCE_POOL_EXHAUSTED` `CAPACITY_UNAVAILABLE`, `QUOTA_EXCEEDED`, `RESOURCE_IN_USE_BY_ANOTHER_RESOURCE` `INVALID_STATE`, …). Each carries `details: { provider: 'gcp', status, reason }`.

## Tests

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/gce-emulator.ts`), plugged in through the `fetch` option. `tests/gcp-end-to-end.test.ts` runs the provider and the emulator through vps: attach, stop and detach (also a detach GCE first refuses with `resourceNotReady`); reservation admission; a tenant network with a firewall rule; and a create GCE fails after accepting it.
