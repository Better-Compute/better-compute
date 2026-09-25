Site tokens are join tokens with the role `site`: they enroll `bcd site` agents on one site, which then contend for the site's boot lease. They share the join-token bearer format `bcjt_<id>.<secret>` and storage, so the secret is shown once and only its hash is kept. Both methods are decided as `compute:sites:manage` on `compute-site/{siteId}`. See [Sites](/docs/guides/bare-metal/sites).

## create

Mints a role-`site` join token for one site and returns its record with the bearer `token`, which is never shown again.

Only the site's owner tenant can mint tokens (the root tenant for platform sites); another tenant gets `NOT_FOUND`, and a deleted site is `INVALID_STATE`. `ttlSeconds` runs from 60 to 86,400, and `maxUses` from 1 to 16 (default 1).

The token id derives from the tenant, the calling identity and `idempotencyKey`. A retry with the same key returns the stored record without `token` and without a new IAM decision; the same key for a different site is `CONFLICT`. Publishes `security.site-token.created`.

## revoke

Revokes a site token at once and returns its record with `revokedAt` set.

Revoking a token that is already revoked returns it unchanged and publishes nothing. A token that is not a site token of this tenant and site is `NOT_FOUND`. A first revocation publishes `security.site-token.revoked`.
