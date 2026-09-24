# realtime-fleet

The v0.1 real-time acceptance run ([REFERENCE.md](../REFERENCE.md), PLAN.md §15 "Real-time harness", §16). It connects 1k FakeDaemons on the wall clock to a real gateway served over cleartext HTTP/2, each daemon on its own connection, backed by a real database. The §16 gate is place-to-active p99 < 2 s, and it joins this suite when W5a's placement path lands. Until then the suite measures dispatch → CommandUpdate for `diag.nvml`:

- **ack**: from the enqueue commit to the command leaving `pending`/`dispatched` (the daemon acknowledged it).
- **terminal**: from the enqueue commit to a terminal state. The fake's work time for `diag.nvml` is 2 s, so this is about ack + 2 s.

```sh
node node_modules/pnpm/bin/pnpm.mjs bench:scale
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/rt_bench node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

The suite is [`tests/bench/realtime-fleet.bench.ts`](../../tests/bench/realtime-fleet.bench.ts), and the harness is `createRealtimeHarness` in [`packages/testing/src/realtime`](../../packages/testing/src/realtime). All commands commit in one transaction and are timed from that commit, after which the gateway is poked for every node. The harness then reads command states every `BENCH_RT_POLL_MS` (default 50 ms), which sets the resolution.

Knobs: `BENCH_RT_NODES` (1000), `BENCH_RT_PER_NODE` (1), `BENCH_RT_SHARED=1` (one HTTP/2 connection for every daemon), `BENCH_RT_POLL_MS`, and `BENCH_RT_GATE=1` (fail the run when ack p99 ≥ 2 s or any command fails). Each run writes `results/<date>-<database>-<nodes>.json`. Commit only runs on the reference hardware, or ones labeled as not on it (`referenceHardware: false`).

## First numbers (2026-09-24, development machine, PGlite, 1k nodes, one process)

| poll | connect | ack p50 | ack p99 | terminal p99 |
| ---- | ------- | ------- | ------- | ------------ |
| 50 ms | 17.0 s | 1.78 s | 2.59 s | 4.61 s |
| 100 ms | 17.0 s | 1.70 s | 2.50 s | 4.47 s |

The poll interval does not move ack, so the ~1.7 s median comes from the gateway's dispatch and ack writes on single-threaded PGlite, which shares one event loop with 1k daemons. The harness is not the cause. PGlite misses the 2 s ack bar, so the gate belongs on Postgres with the daemons in a separate process.

## After group commit (24544d7), with a full-fleet reconnect storm

| nodes | connect | ack p50 | ack p99 | terminal p99 | storm reconnect p50 | storm reconnect p99 |
| ----- | ------- | ------- | ------- | ------------ | ------------------- | ------------------- |
| 1000 | 18.9 s | 1.07 s | 1.13 s | 3.69 s | 6.9 s | 10.3 s |
| 2000 | 47.0 s | 1.61 s | 1.83 s | 4.25 s | 19.6 s | 28.1 s |

Batched CommandUpdate ingestion more than halved ack p99 at 1k, and ack now grows sub-linearly with the fleet. Handshakes are the next bottleneck. A storm (`BENCH_RT_STORM`, default 1: every session drops at once and the daemons redial with backoff) costs about what the initial connect does, roughly 10–20 ms per handshake serialized on PGlite, so time to reconnect grows faster than the fleet. Admission control and jitter (§15 scale risk 3) keep that time bounded but don't shorten it.
