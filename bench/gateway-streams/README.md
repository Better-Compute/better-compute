# gateway-streams

The v0.1 gateway gate ([REFERENCE.md](../REFERENCE.md), PLAN.md §16): one Node gateway process
holds **≥5,000 sessions at 10 s heartbeats for 30 min, with dispatch p99 <500 ms and RSS
<2 GiB**. If it misses, D20 (rewrite the gateway in Go on the same proto) is decided before v0.2.

```sh
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/compute_bench \
BENCH_GW_DURATION_MS=1800000 BENCH_GW_GATE=1 \
  node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

The suite is [`tests/bench/gateway-streams.bench.ts`](../../tests/bench/gateway-streams.bench.ts).

- It seeds `BENCH_GW_SESSIONS` nodes (default 5,000) and starts `createGateway` + `serveGateway`. Then it opens one gRPC `Session` per node over HTTP/2 (`BENCH_GW_STREAMS_PER_CONNECTION` streams per connection, default 100).
- Each simulated daemon sends a real `Hello`, then `Heartbeat` every `BENCH_GW_HEARTBEAT_MS` with a jittered phase. It answers every `Command` with `SUCCEEDED`. A `RESOURCE_EXHAUSTED` from the 200/s handshake bucket is retried with jitter, as bcd does, so the ramp time is part of the result.
- In steady state, commands are enqueued at `BENCH_GW_COMMANDS_PER_S` (default 50, the §8.6 steady rate) to random nodes. Dispatch latency runs from the enqueue commit to the frame's arrival at the daemon, through the real dispatch-by-join path (`poke` + the 1 s loop).
- The run samples RSS and heap every second, and the event-loop delay throughout. Unexpected stream closes count against the gate.
- Each run writes `results/<date>-<adapter>.json` with the fields REFERENCE.md asks for. `BENCH_GW_GATE=1` fails the run when the gate is missed on Postgres.

**What a run here is not.** The load generator shares the gateway's process and uses h2c. So RSS and event-loop numbers include the generator, and TLS handshake CPU is absent. A gate result needs the reference gateway host, mTLS, the generator on its own host, Postgres 17 and 30 minutes. `referenceHardware` is false unless `BENCH_REFERENCE=1`.

## Results so far

| Date | Where | Sessions | Ramp | Dispatch p50 / p99 / max | RSS max | Drops | Gate |
|---|---|---|---|---|---|---|---|
| 2026-09-24 | dev workstation (64 vCPU), PGlite, h2c, generator in-process, 60 s | 5,000 held | 24.8 s (bucket-bound) | 4 / 22 / 381 ms | 1,115 MiB | 0 | indicative: every criterion met except the 30 min duration and the reference setup |
