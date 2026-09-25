The `system` group answers questions about the deployment itself. `whoami` and `version` are public and answer without a credential, which makes them a quick connectivity and credential check; `selfCheck` is a fleet administrator's health report. See [Observability](/docs/operations/observability).

## whoami

Reports who is calling: `authenticated: false` without a credential, or the authenticated identity.

Public; no IAM decision. When the call carries a credential, IAM authenticates it once and the answer holds the identity id and kind, the tenant, the session kind, whether the session used MFA, and the agent and delegation ids when present. The session id is never returned.

## version

Returns the server's name, release version, API base path and the agent protocol versions it speaks.

Public; no IAM decision and no input. The JoinService public keys appear only in the `.well-known/better-compute` document, not in this answer.

## selfCheck

Runs the deployment's read-only health checks and returns the findings, with `ok` false when any finding is an `error`.

Decided as `compute:fleet:admin` on `compute-fleet/global`, which resolves only in the root tenant. The report covers the method catalog, applied migrations, the `btree_gist` extension, `compute_now()` against the database clock, the operations checks (overdue work, command sweeper lag, usage dead letters and backlog, gateway headroom, stale heartbeats, daemon protocol skew, expiring node certificates) and every module's own `selfCheck`. A failing check becomes an `error` finding rather than a failed call.
