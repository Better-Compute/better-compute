# @better-compute/provider-gcp

A Google Compute Engine provider for better-compute: VMs as VPS instances and offers (including GPU machine types), with attach, reservations and tenant networks. It talks to the Compute Engine REST v1 API over plain `fetch` and has no npm dependencies beyond `@better-compute/core` and `@better-compute/vps`.

It is not part of the `better-compute` umbrella: install it next to `better-compute`.

## Configuration

An account is data, validated by the provider's manifest:

| Field               | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `projectId`         | The Google Cloud project id.                                                   |
| `zones`             | At least one zone. Offers and discovery are limited to these.                  |
| `credentials`       | A secret reference to a service-account key JSON. Absent: the metadata server. |
| `impersonate`       | A service-account email to impersonate with the base credentials.              |
| `network`, `subnet` | Used by `create` when no tenant network is given (default network `default`).  |
| `imageProject`      | Where image families resolve (default `ubuntu-os-cloud`).                      |
| `diskGiB`           | Boot disk size (default 100).                                                  |
| `discoverLabel`     | `key=value`: discovery yields only VMs carrying this label.                    |

## Usage

```ts
import { vps } from 'better-compute/vps';
import { gcp } from '@better-compute/provider-gcp';

vps({ providers: [gcp] });

// An account is data. The key is a SecretRef, never a value.
await client.providerAccounts.create({
  tenantId,
  provider: 'gcp',
  name: 'main',
  config: { projectId: 'my-project', zones: ['us-central1-a'], credentials: 'vault://kv/gcp-key' },
});
```

`gcpProvider({ fetch, endpoint, tokenSource, operationPollMs })` swaps the transport, the API endpoint, the token source (a host's workload-identity client) and the in-call operation poll interval (default 2 s, used only for waits of at most 20 s).

## Machines

A VM's id is `zone/name`. An offer's id is `zone/machineType`, or `zone/machineType@reservation` for capacity held by a reservation.

- **Offers** come from the machine types of the configured zones. A `gpuModel`/`minGpus` query keeps accelerator-optimized types (`a2`, `a3`, `a4`, `g2`) that match. Accelerators map to the pool `gpuModel` strings (`H100`, `H200`, `B200`, `A100`, `L4`, `L40S`).
- **`create`** is idempotent through GCE's `requestId` (a UUIDv5 of the idempotency key) and does not wait for the operation: the reconciler polls `get`. It labels the VM `better-compute-managed=true` and `better-compute-instance=<name>`, boots from an image family in `imageProject` (or a full image URL), passes user data as the `user-data` metadata key, and uses the given `NetworkRef` or the account's `network`/`subnet`. GPU types are set to terminate on host maintenance. An offer with `@reservation` consumes that reservation by name (`SPECIFIC_RESERVATION`).
- **`delete`** only deletes VMs carrying `better-compute-managed=true`; **`power`** only acts on VMs carrying `better-compute-instance`. `graceful-restart` is a stop (waited for, at most 20 s) then a start.
- **`list`** yields the managed VMs in the configured zones.

## Attach

`discover` yields every VM of the configured zones (optionally only those with `discoverLabel`), with shape, GPUs, labels, networks, the reservation it consumes and its creation time. `claim` writes `better-compute-instance=<instance id>` under the VM's label fingerprint (one retry on a stale fingerprint; `CONFLICT` if another instance holds the label), and with `{ managed: true }` also `better-compute-managed=true`. `release` removes only its own label and leaves every other one.

## Reservations

`listReservations` reads on-demand reservations (own and shared in) and future reservations that are still to be fulfilled, limited to the configured zones.

- Own reservations have the id `zone/name`. A reservation shared in has `projects/<owner>/zones/<zone>/reservations/<name>`, and its offer suffix is `projects/<owner>/reservations/<name>`. Future reservations get the prefix `future:`.
- The shape comes from `instanceProperties`, else from the machine type, else from the `sourceInstanceTemplate`.
- `listOffers` adds one offer per ready reservation, available while it has unused capacity.

## Networks

`networks` creates custom-mode VPC networks, subnets and firewall rules, and sets managed network tags. The names and tags come from the caller and are used as given.

- Every `ensure*`/`delete*` call returns at once. It answers `pending` (`deleting`) while the GCE operation runs and the reconciler calls again. Nothing is persisted: a call re-reads the resource.
- A firewall that exists with a different body is patched. A subnet that exists with another range, or a firewall with the opposite action, is reported as `error`.
- A network or subnet that is still in use reports `pending` with a message, never an error.
- `setTags` replaces the tags starting with `bc-` and keeps every other tag. It refuses VMs without the instance label.

## Authentication

`serviceAccountTokenSource(keyJson)` signs a JWT with the key and exchanges it at the OAuth token endpoint. `metadataTokenSource()` reads the metadata server. `impersonatedTokenSource(base, email)` exchanges a base token through IAM Credentials. Each caches its token until a minute before expiry. A host that has its own workload-identity client passes `tokenSource` in the provider options. Tokens are never logged.

## Errors

Compute Engine errors map to `ComputeError` codes (404 `NOT_FOUND`, 409 `alreadyExists` `CONFLICT`, 429 or a rate-limit 403 `RATE_LIMITED` with `retryAfterMs`, `quotaExceeded` `QUOTA_EXCEEDED`, other 403 `ACCESS_DENIED`, 400 `INVALID_INPUT`, 5xx `UNAVAILABLE`). Each carries `details: { provider: 'gcp', status, reason }`.

## Tests

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/gce-emulator.ts`), plugged in through the `fetch` option.
