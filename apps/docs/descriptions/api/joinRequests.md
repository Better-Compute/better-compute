Join requests are the approval queue for joins an attestor deferred: a machine with placeholder hardware identifiers, a machine the `discovery` attestor did not know, or a TPM whose endorsement key is on no allow-list. An approval admits exactly one join, which the machine's retry with the same CSR consumes. The group is decided on `compute-pool/{poolId}` with the join-token actions. See [Joining nodes](/docs/guides/nodes/joining).

## list

Lists the join requests a pool can decide: its own, and its site's requests that no pool has claimed yet.

Decided as `compute:join-tokens:read`. `state` defaults to `pending`; `all` lists every state. A pending or approved request past its expiry reads as `expired`, whether or not retention has marked it yet. Pages hold up to 200 requests (100 by default). A pool the tenant does not own is `NOT_FOUND`.

## approve

Approves a pending join request, assigns it to the pool and returns it with a new expiry of `ttlSeconds` (60 to 86,400, one hour by default).

Decided as `compute:join-tokens:create`. Approving a request that is already approved for this pool returns the approval unchanged. Any other decided state (`rejected`, `expired`, `consumed`) is `INVALID_STATE`, and so is an archived pool. A pool the tenant does not own, or a request the pool cannot see, is `NOT_FOUND`.

Publishes `security.join-request.approved` with the new `expiresAt`.

## reject

Rejects a pending join request, or withdraws an approval the machine has not used yet, and returns the request.

Decided as `compute:join-tokens:create`. Rejecting a request that is already rejected returns it unchanged. An `expired` or `consumed` request is `INVALID_STATE`. A later retry with the request's CSR fails.

Publishes `security.join-request.rejected`, with `reason` when one is given.
