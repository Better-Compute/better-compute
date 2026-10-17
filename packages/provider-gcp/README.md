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

## Authentication

`serviceAccountTokenSource(keyJson)` signs a JWT with the key and exchanges it at the OAuth token endpoint. `metadataTokenSource()` reads the metadata server. `impersonatedTokenSource(base, email)` exchanges a base token through IAM Credentials. Each caches its token until a minute before expiry. A host that has its own workload-identity client passes `tokenSource` in the provider options. Tokens are never logged.

## Errors

Compute Engine errors map to `ComputeError` codes (404 `NOT_FOUND`, 409 `alreadyExists` `CONFLICT`, 429 or a rate-limit 403 `RATE_LIMITED` with `retryAfterMs`, `quotaExceeded` `QUOTA_EXCEEDED`, other 403 `ACCESS_DENIED`, 400 `INVALID_INPUT`, 5xx `UNAVAILABLE`). Each carries `details: { provider: 'gcp', status, reason }`.

## Tests

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/gce-emulator.ts`), plugged in through the `fetch` option.
