# @better-compute/gcp-common

Shared Google Cloud plumbing for better-compute: token sources, a REST client, error mapping, paging, long-running operations and universe-aware endpoints. The Google providers (`@better-compute/provider-gcp` today) build on it; a host that needs a Google access token or a Google REST call of its own can use it directly.

It depends only on `@better-compute/core`. It is not in the `better-compute` umbrella: install it where you use it.

```sh
pnpm add @better-compute/gcp-common
```

## Token sources

| Source                                 | Use                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `serviceAccountTokenSource(keyJson)`   | Signs a JWT with the key and exchanges it at the OAuth token endpoint.                                                   |
| `metadataTokenSource()`                | Reads the GCE/GKE metadata server.                                                                                       |
| `impersonatedTokenSource(base, email)` | Exchanges a base token through IAM Credentials for the target service account's.                                         |
| `cachedTokenSource(inner, skewMs)`     | Caches `inner`'s token until `skewMs` (default a minute) before expiry. The three sources above already cache their own. |

Each caches its token until a minute before expiry, and concurrent callers share one request. That request does not belong to any one caller: a caller whose own signal aborts stops waiting with its own abort reason, and the request is cancelled only when every caller has gone.

A refused token request is `UNAUTHENTICATED` for a 4xx and `UNAVAILABLE` for a 5xx. `details.reason` is the OAuth error code (`invalid_grant`) or, for a `google.rpc.Status` body (IAM Credentials), the `ErrorInfo` reason and then `error.status`; `SERVICE_DISABLED` also carries `details.activationUrl`. Every configuration error is `INVALID_CONFIG` with `details: { provider: 'gcp', reason }`, where `reason` is one of `keyJson`, `keyFields`, `keySign`, `impersonateEmail`, `universeDomain`, `tokenUri` or `endpoint`.

Tokens are never logged, and never put in an error message.

## Universe domains and the `token_uri` pin

Google Cloud hosts its APIs in a universe: `googleapis.com` for the public cloud, another domain for a Trusted Partner Cloud or other sovereign deployment. The universe is host configuration. It comes from the `universeDomain` option the host passes (`serviceAccountTokenSource`, `impersonatedTokenSource`, `googleEndpoint`, `tokenEndpoint`), never from a tenant's key.

- `resolveUniverse(domain?)` validates a universe (`undefined` is `defaultUniverse`, `googleapis.com`) and returns it. A malformed one is `INVALID_CONFIG`, reason `endpoint`.
- `googleEndpoint('compute', { universeDomain })` is `https://compute.<universe>`.
- `tokenEndpoint(universeDomain?)` is the OAuth token endpoint, `https://oauth2.<universe>/token`.

A tenant supplies the service-account key and the control plane POSTs to its `token_uri`, so the URI is pinned and nothing else is ever fetched (anything else would be SSRF into the platform's network). In the default universe a key may name Google's token endpoint or its older alias (`https://accounts.google.com/o/oauth2/token`). In another universe it may name exactly `tokenEndpoint(universe)`. A key's own `universe_domain` must equal the configured universe. Anything else is `INVALID_CONFIG` (`details.reason` `tokenUri` or `universeDomain`).

## REST client

```ts
const client = googleClient({ fetch, tokens, quotaProject: 'billing-project' });
const instance = await client.request<Instance>({
  method: 'GET',
  url: `${googleEndpoint('compute')}/compute/v1/projects/p/zones/z/instances/i`,
  signal,
});
```

`googleClient` sends the bearer token in the `authorization` header, JSON-encodes `body`, appends `query` (an array value repeats the key), and maps a failure through `mapGoogleError`. A network failure is `UNAVAILABLE` (reason `network`); an aborted `signal` rethrows the abort.

**Never pass a server-supplied URL (`selfLink`, `nextPageLink`) to `googleClient`.** It sends the bearer token to whatever absolute URL it is given, so build every URL with `googleEndpoint` and the ids you hold.

### `mapGoogleError(status, body, headers, what)`

Reads the `google.rpc.Status` form first (`error.status`, and `ErrorInfo` and `RetryInfo` in `error.details`), then the legacy Compute Engine form (`error.errors[0].reason`), then the HTTP status. `details.reason` is the `ErrorInfo` reason, else `errors[0].reason`, else `error.status`, else `unknown`. `details` always has `provider: 'gcp'` and `status`.

| Google answer                                                      | Code                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| 404                                                                | `NOT_FOUND`                                           |
| 409 `ALREADY_EXISTS`, `ABORTED`, any other 409                     | `CONFLICT`                                            |
| 409 or 400 `resourceInUseByAnotherResource`                        | `INVALID_STATE`                                       |
| 400 `FAILED_PRECONDITION`                                          | `INVALID_STATE`                                       |
| 400 `INVALID_ARGUMENT`, `OUT_OF_RANGE`, any other 400              | `INVALID_INPUT`                                       |
| 401                                                                | `UNAUTHENTICATED`                                     |
| 403 `SERVICE_DISABLED`                                             | `INVALID_CONFIG` (`details.activationUrl` when given) |
| 403 or 429 with a quota reason (`QUOTA_EXCEEDED`, `quotaExceeded`) | `QUOTA_EXCEEDED`                                      |
| 429, or 403 with a rate-limit reason                               | `RATE_LIMITED` (`details.retryAfterMs`)               |
| 400 `resourceNotReady`                                             | `UNAVAILABLE` (`details.retryAfterMs`)                |
| 403 `PERMISSION_DENIED`, VPC Service Controls                      | `ACCESS_DENIED`                                       |
| 501                                                                | `UNSUPPORTED`                                         |
| 499, `CANCELLED`, any other 5xx (an HTML proxy page)               | `UNAVAILABLE`                                         |
| rpc status `UNKNOWN`, any other 4xx                                | `PROVIDER_ERROR`                                      |

`retryAfterMs` comes from `RetryInfo.retryDelay`, then the `Retry-After` header, then `defaultRetryAfterMs` (10 s). `mapGoogleError` agrees with provider-gcp's `mapGceError` on Compute Engine's legacy bodies except for a small, tested list of deliberate differences (401, 499, 501, other 409s, and bodies that mix the two shapes).

## Paging and long-running operations

`paginate(client, { ...request, field, pageSize? })` is an async generator over a list endpoint: one GET per page, following `nextPageToken`, and stopping on an abort between pages.

Operations are never awaited in a call. Store the operation name, poll it on each reconciler run, and read the outcome with `settledOperation(operation, what)`: the response when `done`, `undefined` while running, and a thrown `ComputeError` (mapped as the same failure over HTTP would be) when it ended in an error. `rpcCodeToHttp(code)` converts a `google.rpc.Code` to `[httpStatus, 'CANONICAL_NAME']`.

## Public surface

Everything exported from the package root is public API, and `src/index.ts` lists it name by name. `src/internal/` is not public API: nothing in it is exported (apart from the `TokenContext` type), and it may change in any release.
