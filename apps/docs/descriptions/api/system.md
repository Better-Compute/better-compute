The `system` group answers questions about the deployment itself. `whoami` and `version` are public and answer without a credential, which makes them a quick connectivity and credential check; `selfCheck` is a fleet administrator's health report and `workQueue` the work queue's backlog. See [Observability](/docs/operations/observability).

## whoami

Reports who is calling: `authenticated: false` without a credential, or the authenticated identity.

Public; no IAM decision. When the call carries a credential, IAM authenticates it once and the answer holds the identity id and kind, the tenant, the session kind, whether the session used MFA, and the agent and delegation ids when present. The session id is never returned.

## version

Returns the server's name, release version, API base path and the agent protocol versions it speaks.

Public; no IAM decision and no input. The JoinService public keys appear only in the `.well-known/better-compute` document, not in this answer.

## selfCheck

Runs the deployment's read-only health checks and returns the findings, with `ok` false when any finding is an `error`.

Decided as `compute:fleet:admin` on `compute-fleet/global`, which resolves only in the root tenant. The report covers the method catalog, applied migrations, the `btree_gist` extension, `compute_now()` against the database clock, the operations checks (overdue work, command sweeper lag, usage dead letters and backlog, gateway headroom, stale heartbeats, daemon protocol skew, expiring node certificates) and every module's own `selfCheck`. A failing check becomes an `error` finding rather than a failed call.

## workQueue

Returns the work queue's backlog per kind: how many rows are queued, due, overdue and held by a worker, how many are backing off after failures, and when the next one is due, with how many workers are alive.

Decided as `compute:fleet:admin` on `compute-fleet/global`, which resolves only in the root tenant. `kinds` (1 to 100) answers those kinds in that order, a kind with no rows as zeros; without it, every kind with rows, sorted. A row is due once its `not_before` passed and no worker holds it, and overdue when that was more than `overdueAfterMs` ago (default 5 minutes, as `selfCheck`'s `workers.queue` check counts it). `nextDueAt` (epoch ms) is the earliest `not_before` of the rows no worker holds, absent when there is none; `at` is the database clock (`compute_now()`) the counts were taken at. It only reads, in one statement.
