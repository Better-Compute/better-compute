# @better-compute/gcp-common

Shared Google Cloud plumbing for better-compute: token sources, workload identity, REST client, errors, paging and operations. The Google providers (`@better-compute/provider-gcp` today) build on it; a host that needs a Google access token for its own calls can use it directly.

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

Each caches its token until a minute before expiry. A key's `token_uri` is pinned to Google's token endpoint (or its older alias), so a tenant-supplied key can never steer the POST elsewhere; anything else is `INVALID_CONFIG` (`details.reason` `tokenUri`) and nothing is fetched.

Tokens are never logged, and never put in an error message.
