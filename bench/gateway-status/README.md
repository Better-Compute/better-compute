# gateway-status

The gateway's status path at fleet size. bcd sends a full `StatusReport` after every converge pass, so at least once
per 10-minute drift pass. When a spec reaches a whole pool, or a gateway takes over, every node reports at once. The
gateway coalesces each session's reports, and its `status` job applies them in turn, one transaction each. Each
transaction runs `store.status`: it moves `observed_generation`, publishes the `node.status` event, and runs the
status handlers. Here the handler is the production `xidStatusHandler`, which covers XIDs, host pressure and bcd's node
conditions.

The suite is [`tests/bench/gateway-status.bench.ts`](../../tests/bench/gateway-status.bench.ts). It runs these passes
over `BENCH_STATUS_NODES` nodes:

| Pass | Report |
|---|---|
| warm-up | the first report: pressure conditions and `observed_generation` written |
| drift, every report published | the steady report (gauges aside, unchanged), with `node.status` on every report as before `statusKey` |
| drift | the same, as the gateway runs it now: `node.status` only when `statusKey` changes on the session |
| raise | every node raises `RebootRequired` and `HostManagedExternally` (condition writes, events) |
| clear | the same conditions clear |

For each pass it reports reports/s, latency percentiles and SQL statements per report. With
`BENCH_STATUS_PROFILE=1` it also reports time per statement. The need is nodes/600 reports/s steady, and a
fleet-wide burst drains in nodes/rate seconds.

```
node node_modules/pnpm/bin/pnpm.mjs bench:scale -- tests/bench/gateway-status.bench.ts
BETTER_COMPUTE_POSTGRES_URL=postgres://… node node_modules/pnpm/bin/pnpm.mjs bench:scale -- tests/bench/gateway-status.bench.ts
```

Results land in `results/`.

## 10k nodes, PGlite, sequential (not reference hardware)

| Pass | reports/s | p50 | p99 | statements/report |
|---|---|---|---|---|
| drift, every report published (before) | 480 | 2.04 ms | 4.47 ms | 6 |
| drift (after: `statusKey`) | 662 | 1.52 ms | 3.27 ms | 5 |
| raise | 253 | 3.84 ms | 8.10 ms | 10 |
| clear | 343 | 2.73 ms | 6.02 ms | 9 |

- **Need.** The steady need is 16.7 reports/s at 10k nodes, a 40× headroom. A fleet-wide burst drains in about 15 s.
- **Scaling.** Going from 1k to 10k nodes changes neither the rate nor the latency: every statement is keyed by node.
- **What the profile showed.** The most expensive statement was the `node.status` outbox insert (0.40 ms/report,
  about 1.2 KB of JSON). It was published for every report, although steady reports differ only in their gauges. At 10k nodes that
  was 1.44M events a day (~1.7 GB) of no news, each fanned out to subscribers; the console re-reads the node on each.
  The gateway now publishes a report only when its `statusKey` (the report without pressure and volume storage)
  changes within the session. Every report still reaches the handlers, so conditions and pressure stay level-triggered.
- **Left alone.** Each report reads `node_conditions` twice, once for host pressure (inventory) and once for bcd's
  conditions (gateway), about 0.55 ms together. Merging the reads is possible, but the headroom does not ask for it.
