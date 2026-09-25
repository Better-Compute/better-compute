Destructive-command batches (v1.0 quorum). A batch fixes a set of (subject, kind) leaves, optionally bound to exact payloads, under one Merkle root when it is created (modules create them through `commands.createBatch`). When the deployment publishes approver keys (`pki.approvers`), the batch's commands wait until enough approvers, holding keys off the control plane, have signed its root for the trust domain. The gateway then sends each command with the approval and its leaf's proof, and the daemon verifies both. Without approver keys a batch is recorded for audit and its commands go out at once. See [Security](/docs/operations/security).

## get

Returns one batch of the tenant: its reason, state, scope root and size, the approvals it needs and has, and how many of its commands are in each state.

The state is `expired` as soon as `notAfter` passes, even before the minute sweep writes it. A batch of another tenant is `NOT_FOUND`.

## list

Returns the tenant's batches, newest first, filtered by `state`.

`limit` is 1 to 200 (default 50); `next`, when present, is the `cursor` for the following page.

## scope

Returns a batch's leaves in leaf order, for approvers to review before signing: each leaf's index, subject, kind and `payloadSha256`.

An empty `payloadSha256` marks a leaf that admits any payload of its kind, which approvers should look at closely. Pages hold 1 to 5,000 leaves (1,000 by default); `next` is the leaf index to pass as `cursor`.

## approve

Adds one approver's signature over the batch's root; once the signatures meet the threshold for its size, the batch becomes `approved` and its held commands are released at once.

- `signature` is `{ kid, sig }`: the approver key id and a base64url P-256 signature over the batch (id, root, size, end, trust domain), made off the control plane. A signature by a key outside the published set, or over anything else, is `ACCESS_DENIED`. The same approver twice counts once.
- Decided as `compute:batches:approve`, on top of the signature, never instead of it.
- `INVALID_STATE` for a batch that is not `pending`, or one that needs no approvals (no approver keys, or a size the tiers exempt). `INVALID_CONFIG` when the deployment has no trust domain (no `pki.join`).

Publishes `command.batch.approved` with the approver key ids when the batch completes.

## cancel

Ends a pending batch: it becomes `cancelled` and its held commands are cancelled with it.

A batch that is not `pending` is `INVALID_STATE`. Decided as `compute:batches:approve`.
