# cold-start

The v0.4 cold start (PLAN.md §15 "10k cold start ≤3 min", §16 acceptance "cold start <3 min" at 10k nodes): every
node of a fresh deployment is **connected, adopted and schedulable within 3 minutes** of the fleet powering on,
with no node marked unreachable. The run then power-cycles everything and times the way back.

```sh
COLD_START_NODES=10000 node node_modules/vitest/vitest.mjs run --config vitest.nightly.config.ts tests/nightly/cold-start.nightly.ts
```

The suite is [`tests/nightly/cold-start.nightly.ts`](../../tests/nightly/cold-start.nightly.ts), run by
`pnpm sim:nightly`. [`tests/sim/cold-start.test.ts`](../../tests/sim/cold-start.test.ts) is the same scenario at CI
size (24 nodes). Both call `runColdStart` from `@better-compute/testing`.

- **Setup (not timed).** The real control plane (`betterCompute`, PGlite) and 3 real gateways run under the fleet
  simulator (`createControlPlaneSim`). `COLD_START_NODES` FakeDaemons join through JoinService with sealed tokens
  into a pool whose acceptance is `diag.nvml`.
- **Boot.** Every node powers on at a random time within `COLD_START_SPREAD_MS` (30 s). Each node's first session
  (`node.connected`) and its adoption (`node.adopted`, after passing acceptance) are timed from the outbox
  (`payload.time` is `compute_now()`, the simulated time). The fleet is ready when every node is connected,
  adopted, and has no NoSchedule reason. The gateways admit sessions through their real handshake bucket
  (200/s each) and `maxPendingHellos`.
- **Restart.** Every gateway dies for 10 s and every node reboots (new boot id), coming back within the spread.
  Each node's first session afterwards is timed.
- **Checks.** Invariants I1–I5 and I8 are checked at the end. Any unreachable mark during boot fails the run.
- **Output.** Each run writes `results/<date>-<nodes>.json`, including `wall.loops` (wall ms per part of the loop).

**The worker model.** A real worker loops without sleeping while its queue has work (§8: batches of 32, 4 at a
time). The simulator ticks the control plane once per simulated second, so `workerPasses` (default 10) lets each
job run up to ten batches per tick while it keeps finding work. That models one worker draining about 320 keys a
second, which is conservative for Postgres. With `workerPasses: 1` (one batch per second), a queue of 10k keys
takes minutes to drain in simulated time, and the run measures the simulator rather than the product.

**What a run here is not.** Times are simulated and PGlite stands in for Postgres. The run shows that the protocol
and the control plane's pipeline (admission, Hello, acceptance, adoption, liveness) converge in time at this size.
It does not measure Postgres CPU; that is the §16 "Postgres CPU <50% on the reference Postgres" criterion, which
needs the reference setup.

## Results so far

| Date       | Commit  | Nodes                    | Connected p99 / all | Adopted p99 / all ready | Power cycle, all back | Unreachable | Violations | Wall              |
| ---------- | ------- | ------------------------ | ------------------- | ----------------------- | --------------------- | ----------- | ---------- | ----------------- |
| 2026-09-25 | 5b03790 | 1,000 (`workerPasses` 1) | 29.8 s / 30.0 s     | 79 s / 80 s             | 40 s                  | 0           | 0          | 73 s              |
| 2026-09-25 | 6670778 | 10,000                   | 29.7 s / 30.0 s     | 79 s / 80 s             | 40 s                  | 0           | 0          | 641 s (join 80 s) |
| 2026-09-25 | 4b3740e | 10,000, all at once      | 32.1 s / 65.1 s     | 86 s / 95 s             | 40 s                  | 23          | 0          | 631 s             |
| 2026-09-25 | 6067791 | 10,000, all at once      | 16.1 s / 18.7 s     | 75 s / 80 s             | 30 s                  | 0           | 0          | 603 s             |

Connection is bound by the power-on spread (30 s). Adoption takes the same time at 1k and 10k (p50 55 s): it is
paced by the acceptance command and the node pass, not by throughput. Of the 10k run's wall time, 327 s went to
the reconcilers and 46 s to the gateways' jobs, both on the one PGlite.

**The power-on herd** (`COLD_START_SPREAD_MS=0`: every node starts at the same instant). The first run was ready in 95 s but marked 23 nodes unreachable. All 23 had not connected yet (`unreachableBeforeConnect`): liveness counted a node with no session activity from -infinity, and daemons refused by the 200/s handshake bucket backed off towards 60 s. Two fixes took the tail from 65 s to 19 s and the marks to 0: the gateway's refusals carry `grpc-retry-pushback-ms` scaled to the backlog, which FakeDaemon and bcd follow (a54aae6, 825897d), and liveness counts a never-connected node from its join (f5ba478).
