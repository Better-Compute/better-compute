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
- Then comes the reconnect storm (§7.8), which `BENCH_GW_STORM=0` skips. A second gateway starts, and the first one's transport is destroyed with commands in flight. Every daemon redials with full-jitter back-off (1 s doubling to 30 s) and retries the handshake bucket. The run records when 99% and 100% are back, and checks that every command ends `succeeded`.
- The simulated daemon keeps a journal, as `bcd` does. A command runs once, and a replayed one gets its stored result again. Results are kept until acked and returned in `Hello.unacked_results`.
- Each run writes `results/<date>-<adapter>.json` with the fields REFERENCE.md asks for, including `closeReasons` (why every stream ended). `BENCH_GW_GATE=1` fails the run when the gate is missed on Postgres.

- `BENCH_GW_TLS=1` runs it over mTLS as in production. Each daemon has its own node certificate from a bench node CA (SPIFFE SAN, role `node`), so it has its own TLS 1.3 connection with one stream. The gateway authenticates with the production `certificateAuthenticate`. Dials that fail before Welcome, such as a full accept queue, count as `ramp.dialRetries`, not as drops.

**What a run here is not.** The load generator shares the gateway's process. So RSS and event-loop numbers include the generator, and with mTLS that means its 5,000 client TLS sessions too. Without `BENCH_GW_TLS=1`, TLS handshake CPU is also absent. A gate result needs the reference gateway host, mTLS, the generator on its own host, Postgres 17 and 30 minutes. `referenceHardware` is false unless `BENCH_REFERENCE=1`.

**Windows accept queue.** Windows client editions cap a listener's backlog (about 200) whatever `listen()` asks for. On them, thousands of simultaneous dials are refused and redialed with back-off, so the mTLS ramp and storm times below measure that cap, not the gateway. `serveGateway` asks for a backlog of 4096 (`backlog`), and Linux honours it up to `net.core.somaxconn`.

## Results so far

| Date | Where | Sessions | Ramp | Dispatch p50 / p99 / max | RSS max | Drops | Gate |
|---|---|---|---|---|---|---|---|
| 2026-09-24 | dev workstation (64 vCPU), PGlite, h2c, generator in-process, 60 s | 5,000 held | 24.8 s (bucket-bound) | 4 / 22 / 381 ms | 1,115 MiB | 0 | indicative: every criterion met except the 30 min duration and the reference setup |
| 2026-09-24 | same, 30 s, before admission control | 5,000 → 9,880 opens | 58 s | 15 / 924 / 7,606 ms | 871 MiB | 5,464 | **failed**: see below |
| 2026-09-24 | same, 60 s + storm, with `maxPendingHellos` | 5,000 held | 25.5 s | 5 / 32 / 101 ms | 924 MiB | 0 | indicative pass; storm: 5,000/5,000 back, p99 32.5 s, all 33.2 s, 3,056/3,056 commands `succeeded` |
| 2026-09-25 | same, **mTLS** (one TLS 1.3 connection per daemon), 60 s + storm | 5,000 held | 83.8 s (50,037 refused dials: the Windows accept queue) | 12 / 27 / 99 ms | 2,183 MiB | 0 | indicative. RSS includes the generator's 5,000 client TLS sessions, so the gateway's share needs a split run. Storm: 5,000/5,000 back (all 88.8 s, bound by the accept queue), 3,156/3,156 commands `succeeded`. Event-loop p99 26 ms. |
| 2026-09-25 | same, mTLS, **split** (`BENCH_GW_SPLIT=1`: the gateway and PGlite in their own process), 60 s + storm | 5,000 held | 32.1 s (120 refused dials) | 14 / 26 / 94 ms | **1,240 MiB** (the gateway process, PGlite included) | 0 | indicative: sessions, dispatch p99 and RSS criteria met. Missing are the 30 min duration, Postgres and the reference host. Storm: 5,000/5,000 back (p99 38.8 s, all 39.0 s), 3,464/3,464 commands `succeeded`. Gateway event-loop p99 25 ms, max 98 ms. |
| 2026-09-25 | same, mTLS, split, **30 min** + storm | 5,000 held | 30.4 s | 14 / 24 / 422 ms (90,000 commands) | 2,016 MiB (JS heap 235 MiB) | 0 | every criterion met on PGlite, but RSS only just. It grew from 1,240 MiB (1 min) to 2,016 MiB (30 min) while the JS heap stayed at 235 MiB, so the growth is outside the heap. The likely cause is PGlite's WASM memory holding 90,000 commands and their outbox rows in the gateway process. A Postgres run (the database out of process) is needed to call the RSS criterion. Storm: 5,000/5,000 back (all 40.4 s), 90,480/90,480 commands `succeeded`. |
| 2026-09-25 | same, mTLS, split, 5 min, no storm, **memory attributed** (`arrayBuffersMiB`: WebAssembly memory, where PGlite's database lives) | 5,000 held | — | 13 / 23 / 133 ms (15,000 commands) | 1,127 → 1,355 MiB; `arrayBuffers` 86 → 310 MiB | 0 | RSS grew 228 MiB, and 224 MiB of that is `arrayBuffers`, so the growth is PGlite's database in the gateway process, not the gateway's own. With Postgres out of process the gateway's RSS should stay near its first-minute level (about 1.1 GiB at 5,000 mTLS sessions). |

**Finding (fixed): a storm could make the gateway fence itself.** The 200/s handshake bucket admits Hellos faster than a slow store commits them (PGlite does ≈140/s). The Hello transactions queued without bound, and the gateway's own `gateway:<id>` lease renewal waited behind them past its 20 s TTL. Every fenced transaction then dropped all streams: 4,437 `gateway fenced`, 584 `lease no longer held`, and 443 missed heartbeats from event-loop stalls of up to 5 s. The fix is `maxPendingHellos` (default 64): Hellos beyond it are refused `RESOURCE_EXHAUSTED` and retried with jitter, so the database queue stays short. The same starvation can happen on Postgres with a small pool, so the bound applies there too. The storm's reconnect time is bound by the handshake bucket (5,000 ÷ 200/s ≈ 25 s) plus back-off. The old gateway's shutdown disconnect writes also queue ahead of the new gateway's Hellos on PGlite's single connection.
