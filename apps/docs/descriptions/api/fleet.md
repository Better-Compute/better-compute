The fleet group manages a tenant's platform objects as one FleetConfig document: sites, provider accounts, pools, owner quotas, offers and flavors. `plan` diffs a document against what exists, `apply` runs the plan through the owning modules' own methods, and the applied document is kept so that drift from it is reported. Every method decides `compute:fleet:admin` on the fleet scope. See [Fleet configuration](/docs/guides/fleet-config).

## export

Returns the tenant's current sites, provider accounts, pools, owner quotas, offers and flavors as a FleetConfig document, with `missing` listing the tables of modules this deployment does not run.

Objects that fleet never named appear under their ids. Archived pools and archived flavors are left out.

## plan

Diffs a FleetConfig document against the tenant's current state; returns the changes for people, the exact API calls `apply` would make, a summary, `blocked`, and a `planHash`.

- The call changes nothing. With `prune: true` the plan also deletes what the document no longer lists: flavors and offers are removed, pools archived, and unused provider accounts deleted. Sites are never changed or pruned.
- A change that cannot be applied (an immutable field such as a pool's class or an account's provider, an unknown reference, an offer to the pool's owner) is marked `blocked` with the reason.
- The ids of planned creates derive from the caller's identity, so the call needs an authenticated caller (`UNAUTHENTICATED` otherwise).

## apply

Plans the document again and runs every planned call as the caller, all in one transaction; returns the plan and the number of calls applied.

- **Decisions.** Each call is authorized first, as the caller and with no transaction open, by the method it invokes; a refusal stops the apply before anything changes.
- **Consistency.** Pass the `planHash` from `plan` to apply exactly that plan: if the plan has changed, the call is `CONFIG_DRIFT`. The plan is made once more inside the transaction, and a change there is also `CONFIG_DRIFT`, with nothing applied.
- **Idempotency.** Creates carry keys derived from the tenant, the kind and the name, so repeating an apply creates nothing twice. A plan with no calls still records the document.
- **Errors.** `INVALID_STATE` with `details.blocked` when any change is blocked. `UNSUPPORTED` when the host cannot run composite methods. Errors of the invoked methods pass through.
- The document becomes the one that `status` and the `fleet.drift` reconciler compare against.

## status

Returns the tenant's last applied document's plan hash, who applied it and when, and, while the fleet differs from it, the drift found at the last check.

`applied` is absent when the tenant never applied a document. The `fleet.drift` reconciler re-plans each applied document every 15 minutes by default and publishes `fleet.drifted` or `fleet.converged` when the answer changes.
