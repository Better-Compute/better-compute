# realtime-spine

The §16 v0.1 acceptance run ([REFERENCE.md](../REFERENCE.md), PLAN.md §15 "Real-time harness"): place-to-active p99 < 2 s with 1k FakeDaemons, on the wall clock, with the whole spine running:

- a real control plane (`betterCompute`, workers started, JoinService on real PKI);
- a real gateway wired to it over cleartext HTTP/2 (its `GatewayServices`, `gatewayReportHandlers`, work queue and outbox, and pokes through an in-process notifier);
- FakeDaemons, each on its own connection.

Each daemon Joins with a sealed token bound to its CSR, passes `diag.nvml` acceptance and applies its NodeSpec. Then whole-node (8-GPU) reservations for another tenant bind on the adopted nodes. They turn active when the daemons report AllocationBound.

```sh
node node_modules/pnpm/bin/pnpm.mjs bench:scale
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/rt_spine node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

The suite is [`tests/bench/realtime-spine.bench.ts`](../../tests/bench/realtime-spine.bench.ts); the harness is `createRealtimeFleet` in [`packages/testing/src/realtime/fleet.ts`](../../packages/testing/src/realtime/fleet.ts).

- **`join(n)`** times each node from its Join call to three points: a live session, and adopted with `observed_generation = generation ≥ 1`.
- **`place(n, { ratePerSecond })`** times each reservation from `reservations.create` answering `placed` to `active`. The fleet polls while the creates are still arriving.

The gated phase places `BENCH_SPINE_RESERVATIONS` (default 200) at a steady `BENCH_SPINE_RATE` (default 5/s). A burst of `BENCH_SPINE_BURST` (default 100) then fires at once; it is reported but not gated. Other knobs: `BENCH_SPINE_NODES` (1000), `BENCH_SPINE_JOIN_CONCURRENCY` (32), `BENCH_SPINE_PLACE_CONCURRENCY` (8), and `BENCH_SPINE_GATE=1` to fail the run when the paced p99 is 2 s or more.

## First numbers (2026-09-24, development machine, PGlite, one process, 1k nodes)

| placement rate | create p50 / p99 | place → active p50 / p99 | gate |
| -------------- | ---------------- | ------------------------ | ---- |
| 2/s (60) | 143 / 179 ms | 72 / 133 ms | met |
| 5/s (100) | 174 / 353 ms | 776 ms / 1.02 s | met |
| 10/s (150) | 1.61 / 2.04 s | 17.1 / 29.4 s | missed (saturated) |
| burst of 50 after the 10/s phase | 1.89 / 2.09 s | 6.5 / 11.9 s | not gated |

When the system isn't saturated, placed → active is quick. In a trace on an idle fleet, binding follows `placed` within about 20 ms, NodeSpec generation 2 follows about 30 ms later, AllocationBound arrives about 20 ms after that, and the reservation is active about 70 ms after `placed`. The limit is the inline placer. At 1k nodes, each placement holds the pool's `FOR UPDATE` fence for about 150 ms on PGlite, so one pool saturates between 5 and 10 placements/s. Beyond that, create latency and the reconciler backlog grow without bound. At saturation, lease renewals starve too: the `singleton:capacity.reservations` lease lapses, and its runs fail with "Lease … is no longer held" and back off 1 s. That is a warning for the v0.4 `PoolLeasePlacer`.

Joining 1k nodes at 32 concurrent Joins takes about 80–95 s. The Join RPC's p50 is 2.3–2.9 s, and nodes are adopted at a p50 of 38–50 s. Every Join goes through JoinService, the node CA and acceptance on the one PGlite. A real deployment staggers boot, and it runs on Postgres with daemons in other processes.
