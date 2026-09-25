A sandbox is a hosted VPS instance with a template and a lifetime: `create` admits it after one IAM decision, then claims a warm instance of its template or creates one through the instance lifecycle, and the `vps.sandboxes` reconciler, which runs every 15 seconds, deletes it once `expiresAt` passes. A sandbox's `state` follows its instance: `starting`, `ready` while the instance runs, `failed` when it is in `error` or `lost`, `deleting` once deletion was asked, and `deleted` when the instance is gone. The instance belongs to the sandbox: `instances.start`, `stop`, `resize` and `delete` refuse it with `INVALID_STATE`, and `instances.get` still returns it. See [Sandboxes](/docs/guides/vps/sandboxes).

## create

Starts a sandbox from a template after one IAM decision on the draft, claiming a warm instance when the template holds one and creating a new instance otherwise; the lifetime starts at once.

- **Idempotency.** `idempotencyKey` is required. The sandbox id derives from the tenant, the caller's identity and the key: a retry of an admitted request returns the stored sandbox without a second decision, and a different request under the same key is `CONFLICT` with `details.sandboxId`. `wait` is not part of the compared request.
- **IAM.** `compute:sandboxes:create` is decided on `compute-sandbox/` plus the draft id, whose parent is the template's pool. Policies can test `templateId`, `vcpu`, `memoryGiB`, `gpus`, `ttlSeconds` and `warm` (true when the template keeps a warm pool). A refusal deletes the draft; a delegated session can get `CONFIRMATION_REQUIRED`. After an allow, the pool's budget check can answer `SPEND_LIMIT_REACHED` and keep the draft for a retry with the same key.
- **Start.** The oldest stopped or paused warm instance of the template is claimed: it changes owner to the caller, is set to run, and publishes `instance.starting`; the claim places nothing new. Without one, a new instance is created and placed as `instances.create` would, publishing `instance.created` and, once placed, `instance.scheduled`; when no host fits it waits in scheduling and the sandbox stays `starting`. `warm` in the answer tells which path was taken.
- **Restore.** `fromSnapshot` starts the sandbox from one of the tenant's own `ready` snapshots taken on the template's runtime (another tenant's is `NOT_FOUND`, one not ready is `INVALID_STATE`). A restore never claims a warm instance, and a snapshot that includes memory places only on nodes with the same `cpu.model`. Policies see it as the `fromSnapshot` attribute.
- **Lifetime.** `ttlSeconds` defaults to the template's `defaultTtlSeconds` and may not exceed its `maxTtlSeconds` (`INVALID_INPUT`). `expiresAt` is set when the sandbox is admitted.
- **Errors.** `NOT_FOUND` for a template missing or deleted in the tenant. `INVALID_STATE` when the template's flavor has been archived or removed. On the new-instance path the template's pool, flavor and image are checked again, with the errors of `sandboxTemplates.create`; `QUOTA_EXCEEDED` when the shape does not fit the tenant's quota and `CAPACITY_UNAVAILABLE` when the pool has no free IP address, both keeping the draft.
- **Waiting.** `wait.timeoutMs` (at most 30 seconds) holds the answer until the sandbox leaves `starting`; a timeout returns it still `starting`, not an error.

Publishes `sandbox.created` with `warm` and `expiresAt`. `sandbox.ready` follows from the reconciler once the instance first runs.

## list

Returns a page of the tenant's sandboxes, newest first, with a `cursor` when more remain.

`scope` defaults to `mine`, the caller's own sandboxes, which needs no per-item check. `all` lists every sandbox of the tenant, each one checked for `compute:sandboxes:read`; those the caller may not read are left out, so a page can hold fewer than `limit` items. Deleted sandboxes are left out unless `deleted` is true, and `templateId` keeps one template's sandboxes. `limit` is 1 to 200 (default 50); `cursor` is the last sandbox id of the previous page. Drafts are never listed.

## get

Returns one sandbox of the tenant with its state, its instance's state, addresses and node, and its `expiresAt`.

`readyAt` is set once the reconciler saw the instance run, and `expiredAt` when the sandbox ended by reaching `expiresAt`. `snapshots` lists the sandbox's snapshots with their state. Drafts and sandboxes of other tenants are `NOT_FOUND`.

## extend

Moves a sandbox's `expiresAt` later after one IAM decision, within its template's `maxTtlSeconds` counted from creation; returns the sandbox.

- Give exactly one of `until` (the new expiry, epoch milliseconds) or `by` (added to the current expiry: `30m`, `8h`, `7d`, or milliseconds, at most 30 days); both or neither is `INVALID_INPUT`. A lifetime past the template's `maxTtlSeconds` is `INVALID_INPUT`, and a sandbox whose deletion has started, by `delete` or by expiry, is `INVALID_STATE`.
- **IAM.** `compute:sandboxes:update` is decided on the sandbox with a pending `ttlSeconds` equal to the whole lifetime after the change, so a policy that caps `ttlSeconds` on `create` also caps extensions. A refusal is `ACCESS_DENIED` and clears the pending change.
- **Idempotency.** An `until` that is not later than the current expiry returns the sandbox unchanged without a decision, so a retried `until` is safe. There is no `idempotencyKey`: a repeated `by` extends again.
- While another extend of the same sandbox is being decided, the call is `CONFLICT` with `details.reason: 'extend-in-flight'` and `retryAfterSeconds`. A spent budget is `SPEND_LIMIT_REACHED`.

The stored `ttlSeconds` becomes the new whole lifetime. Publishes `sandbox.extended` with the new `expiresAt`.

## snapshot

Saves a running or paused sandbox's state (disk, and memory unless `includeMemory` is false) as a tenant-private snapshot; returns it `pending` until the host's `instance.snapshot` command settles.

- **Where.** The deployment's snapshot store (`vps({ snapshots })`) presigns an https upload URL, and the host uploads straight to it. Without a store the call is `INVALID_CONFIG`. A sandbox that is not running or paused, or whose deletion has started, is `INVALID_STATE`.
- **Settling.** The `vps.sandboxes` reconciler, woken when the command settles, makes the snapshot `ready` (with its sha256, size, runtime and CPU model) and publishes `sandbox.snapshot.ready`, or makes it `failed` and publishes `sandbox.snapshot.failed`.
- **Idempotency.** With `idempotencyKey`, a retry returns the same snapshot; the key used for another sandbox is `CONFLICT`. Without one, every call takes a new snapshot.
- **Lifetime.** A snapshot is deleted with its sandbox unless `keep` is true. A tenant teardown deletes all of them, kept ones included. Snapshots are never promoted to shared images.

## exec

Opens SSH into a running sandbox: returns a single-use `ssh` tunnel ticket for its instance and a short OpenSSH user certificate from the deployment's sandbox SSH CA for the principal `<account>@<instanceId>`.

- **How.** A sandbox has no in-guest agent: the node's daemon dials the instance's own address, and the instance's sshd trusts the sandbox CA and accepts only its own principal, so a certificate for one sandbox opens no other. Open `GET` on the returned `path` with the ticket before `expiresAt`, then speak SSH over it. `better-compute sandbox exec` does both.
- **Host key.** The answer tells whether the guest can be pinned. `hostCertificate` is `valid` when the guest presents a host certificate from the sandbox CA, still good for at least a minute (then pin it with `@cert-authority` for `hostPrincipal` and `HostKeyAlias`). It is `expired` when that certificate ended, and `none` when the instance was never certified. `hostCertified` is true only when `valid`.
- **Certificate.** `publicKey` must be an Ed25519 or ECDSA P-256 key. `ttlSeconds` is 60 to 900 (default 600) and never past the caller's session. Guests receive no revocation list, so the short lifetime is the revocation control, and tunnel re-authorization closes the transport.
- **Errors.** `UNSUPPORTED` when the deployment has no sandbox SSH CA (`tunnels.sandboxSsh`). `ACCESS_DENIED` for an API key (reason `session-required`) or a session ending within a minute. `INVALID_STATE` when the sandbox is not running or is being deleted. The node must be connected and advertise `tunnel.instance-dial`. Exec shares the per-identity tunnel rate limit with `tunnels.open` (`RATE_LIMITED`).

Hosted by the tunnels module. Publishes `tunnel.issued`.

## delete

Asks for the sandbox's instance to be deleted and marks the sandbox `deleting`; returns the sandbox at once.

The instance's `desiredState` becomes `deleted` and the `vps.instances` reconciler releases its allocation, IP lease and quota as for any instance, publishing `instance.deleting` with the `sandboxId`. The call is idempotent: a sandbox already deleting is returned in its current state. Drafts and missing sandboxes are `NOT_FOUND`.

When the instance is gone, the `vps.sandboxes` reconciler marks the sandbox deleted, removes it from the authorization projection and publishes `sandbox.deleted` with `expired: false`. Expiry takes the same path after publishing `sandbox.expired`, and its `sandbox.deleted` carries `expired: true`.
