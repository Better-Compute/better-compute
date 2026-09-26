Join tokens are single-purpose credentials that let a limited number of daemons join one pool for a limited time. The bearer form `bcjt_<id>.<secret>` is returned once, when the token is created; the control plane stores only the SHA-256 of the secret. Every method is decided on `compute-pool/{poolId}`. See [Joining nodes](/docs/guides/nodes/joining).

## create

Mints a role-`node` join token for one pool and returns its record with the bearer `token`, which is never shown again.

Only the pool's owner tenant can mint tokens for it; another tenant gets `NOT_FOUND`. A pool whose machines run no daemon (its `agent` is not `bcd`) answers `INVALID_STATE`. `expect` pins the token to one machine and must name at least one identifier, otherwise the call is `INVALID_INPUT`. `ttlSeconds` runs from 60 to 86,400 and `maxUses` defaults to 1.

`hosted: 'kubernetes'` marks a token for `bcd` running as a DaemonSet on a Kubernetes cluster. That cluster's admins have root on its machines, so a node joining with it becomes `tenant-controlled`, with a `node-tenant` certificate that never receives platform secrets. The exception is a pool whose `policy.kubernetes.platformOperated` is true, and only when the platform owns that pool (it is the pool's site's owner, on a site that is not `custom`): anyone who can edit a pool's policy could otherwise vouch for their own cluster, so set it only on pools whose clusters the platform runs. The token decides this, never the machine's claims, and it only ever lowers `platform` trust: a tenant's own site stays `tenant-owned`.

The token id derives from the tenant, the calling identity and `idempotencyKey`. A retry with the same key returns the stored record without `token` and without a new IAM decision. The same key with a different pool, `expect`, `allowReclaim` or `hosted` is `CONFLICT`.

Publishes `security.join-token.created`, whose `pinned` field says whether the token has an `expect` binding; `hosted` is included when set.

## list

Lists a pool's join tokens in id order, never with their secrets.

By default only live tokens appear: not revoked, with uses left and not expired. `includeInactive: true` adds used-up, expired and revoked tokens. Pages hold up to 200 tokens (100 by default); pass the returned `cursor` to read the next page.

## revoke

Revokes a join token at once and returns its record with `revokedAt` set.

Revoking a token that is already revoked returns it unchanged and publishes nothing. A token that does not exist in the tenant and pool is `NOT_FOUND`. A first revocation publishes `security.join-token.revoked`.
