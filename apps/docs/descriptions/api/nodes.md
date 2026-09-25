Nodes are machines that joined the control plane, as their tenant sees them: a tenant sees the nodes the authorization projection holds for it. Every method except `list` is decided on `compute-node/{nodeId}`. Mutations take an optional `version`; when the node has moved past it, the call is `CONFLICT`. See [Operating nodes](/docs/guides/nodes/operating-nodes).

## list

Lists the nodes visible to the tenant in id order, filtered by pool, site, `cordoned` or `provisionState`.

The call is decided once on `compute-tenant/{tenantId}`, then each node is checked for `compute:nodes:read`; nodes the caller may not read are left out, so a page can hold fewer than `limit` items. Pages hold up to 50 nodes.

## get

Returns one node with its labels, conditions and session (epoch, gateway and connection times).

A node the tenant cannot see is `NOT_FOUND`.

## events

Returns a node's events from the event outbox, oldest first.

`type` keeps only events whose type starts with the given prefix, such as `node.` or `security.`. Pages hold up to 200 events (100 by default). A node the tenant cannot see is `NOT_FOUND`.

## cordon

Marks the node cordoned so placement puts no new work on it; existing allocations stay.

Cordoning a cordoned node returns it unchanged and publishes nothing. Otherwise the node's version goes up, its reconciler is queued, and `node.cordoned` is published.

## uncordon

Clears `cordoned` and ends a drain in progress, so the node is placeable again.

Decided as `compute:nodes:cordon`. A node that is neither cordoned nor draining is returned unchanged. Otherwise the `draining` reason is removed and `node.uncordoned` is published.

## drain

Cordons the node, adds the `draining` NoSchedule reason and hands the node to the Drain controller.

The Drain controller releases nothing in this release: it waits until the node holds no live allocation, then removes `draining` and publishes `node.drained`. The node stays cordoned until `uncordon`. Draining a node that is already draining returns it unchanged. A new drain publishes `node.draining`.

## label

Sets and removes operator labels on the node and returns the node with its labels.

`set` takes up to 64 labels and `remove` up to 64 keys. The call is `INVALID_INPUT` when it names nothing, names a key in both `set` and `remove`, or sets a key that inventory or the system owns. `remove` removes only operator labels. The node's version goes up and `node.labeled` is published.

## taint

Adds and removes operator NoSchedule taints, stored in `noScheduleReasons` as `taint:<key>`.

`add` and `remove` take up to 32 keys each. The call is `INVALID_INPUT` when it names nothing or names a key in both lists. Only operator taints change; conditions, `unreachable` and `draining` belong to their controllers. When the result equals the current reasons the node is returned unchanged; otherwise `node.tainted` is published.

## adopt

Re-runs acceptance checks on a node in `adopting` or `adopted`, moving it to `adopting`.

Decided as `compute:nodes:provision`. Any other provision state is `INVALID_STATE`. The node leaves placement until acceptance passes. Publishes `node.adopting`.

## revokeIdentity

Revokes every live certificate of the node and raises its identity generation, so no certificate of the old generation can renew.

Returns the node and `revokedCertificates`, the number of certificates revoked; the revocation reason is `reason`, or `identity revoked`. Each call raises the generation again. The machine comes back only by joining again. Publishes `security.node.identity-revoked`.

## delete

Tombstones a node that is `retired`, `adopting` or `enrolling` (or failed from `adopting` or `enrolling`) and has no open allocation.

Any other state, or an open allocation, is `INVALID_STATE`; a node that changed pools during the call is `CONFLICT`. The node's devices stop being bookable, its scalar resources are removed, its certificates are revoked, its hardware key and attestor bindings are freed so the machine can join again as a new node, and its pending commands are cancelled. The node leaves its pool and the projection, so nobody sees it; audit rows and past allocations keep referencing it.

A retry after the delete returns `deleted: false`. Publishes `node.deleted`.

## issueSshCert

Issues a short-lived break-glass OpenSSH user certificate for one node, bound to the principal `<account>@<nodeId>`.

Decided as `compute:nodes:ssh-root`. The method comes from the tunnels module (v0.3) and is `UNSUPPORTED` when no compute SSH CA is configured. It needs an MFA session by default (`ACCESS_DENIED` with reason `mfa-required`), and a session that ends within a minute is `ACCESS_DENIED`. `publicKey` must be an Ed25519 or ECDSA P-256 key, and `principal` (default `root`) one of the configured accounts; otherwise `INVALID_INPUT`.

The lifetime is `ttlSeconds` (60 to 3,600, default 900), never past the caller's session. Issuance is rate-limited per identity (20 per hour by default, then `RATE_LIMITED`). Every certificate is recorded and `node.ssh-cert.issued` is published.

## revokeSshCert

Revokes a break-glass SSH certificate before it expires; the node's revocation list carries it from the next NodeSpec on.

Decided as `compute:nodes:ssh-root` and hosted by the tunnels module (v0.3). Revoking again returns the same revocation. A serial not issued for this node is `NOT_FOUND`. Publishes `node.ssh-cert.revoked`.
