# iam-lane

The v0.1 IAM-lane gate ([REFERENCE.md](../REFERENCE.md), PLAN.md §16). Embedded better-iam on adapter-postgres takes `pg_advisory_xact_lock(1647206759, 1)` in every transaction, so every admission queues on one lane. An admission is `IamPort.authenticate` + `IamPort.require`, which is ≈3 lock acquisitions. The gate is ≥50 admissions/s (≈150 acquisitions/s) with lock wait <50%. The run also records the measured ceiling. If that ceiling is below G5's 200 admissions/s, R1 is proposed (D18).

```sh
BETTER_COMPUTE_IAM_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/iam_bench \
  node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

The suite is [`tests/bench/iam-lane.bench.ts`](../../tests/bench/iam-lane.bench.ts). It runs a better-iam carrying the bridge's plugin and resolver, with 32 members of one organization and a grant on `compute:reservations:create`. It then sweeps concurrency (`BENCH_IAM_CONCURRENCY`, default `1,4,16,32`) for `BENCH_IAM_DURATION_MS` per step. 10% of admissions are denials (`BENCH_IAM_DENY_SHARE`), because denials write to the tenant's audit chain.

- Lock wait is sampled from `pg_locks` every 25 ms: the mean number of sessions waiting on the IAM advisory lock, divided by the concurrency.
- Each run writes `results/<date>-<adapter>.json` with the fields REFERENCE.md asks for. Commit only runs on the reference hardware, or ones labeled as not on it.
- `BENCH_IAM_GATE=1` fails the run when the gate is missed on Postgres.
- Without a Postgres URL the suite runs on SQLite. That run is indicative only, and it never meets the gate, which is defined on adapter-postgres.
