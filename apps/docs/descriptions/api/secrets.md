Secrets are write-only: `put` hands a value to the configured secret store and returns its `secret://` reference and version, and no method ever reads a value back. Events and audit rows carry only the reference, name and version; values reach agents through the secret broker, never through the API. Methods are decided on `compute-tenant/{tenantId}`, or on `compute-fleet/global` for platform secrets with `scope: 'fleet'` in the root tenant. See [Security](/docs/operations/security) and [BMC credentials](/docs/guides/bare-metal/bmc).

## put

Stores a secret value under a name and returns its reference and version; a second put with the same name writes a new version.

The value is at most 64 KiB. A retry whose `idempotencyKey` equals the key of the put that wrote the current version returns that version and writes nothing; the key is not scoped to the calling identity. `scope: 'fleet'` outside the root tenant is `INVALID_INPUT`. The call is `UNAVAILABLE` when no secret store is configured, and `INVALID_STATE` when the existing secret lives in another store than the configured one.

Publishes `security.secret.put` with the reference, name and version, never the value.

## delete

Deletes a secret's value from the store and its reference, returning `deleted: true`, or `deleted: false` when no such secret exists.

`scope: 'fleet'` outside the root tenant is `INVALID_INPUT`. The call is `UNAVAILABLE` when no secret store is configured, and `INVALID_STATE` when the secret lives in another store than the configured one. Publishes `security.secret.deleted`.
