# inventory-ingest

Inventory ingestion at fleet size (PLAN.md §10.1). A Hello, and every 10th heartbeat, reports the node's section
hashes. The gateway batches the reports (`recordInventoryHashesMany`) and the sections it pulls
(`ingestInventorySections`). The Inventory reconciler then applies each node's set in its own transaction
(`applyInventory`): snapshot, diff, devices, health, labels, conditions and events.

The suite is [`tests/bench/inventory-ingest.bench.ts`](../../tests/bench/inventory-ingest.bench.ts). It covers
`BENCH_INV_NODES` HGX H100 nodes (8 GPUs, 6 sections each) in three phases:

| Phase | What happens |
|---|---|
| join storm | every node reports, is asked for every section, sends them, and is applied |
| steady | every node reports the same hashes again: nothing to pull, nothing to apply |
| change | one section changes on every node (a fleet-wide driver update): report, pull `gpus`, apply |

Each step reports its rate, latency percentiles and SQL statements per node. With `BENCH_INV_PROFILE=1` it also
reports the time per statement. `BENCH_INV_BATCH` (500) is the gateway's batch size. The steady need is a hash
report per node every 100 s (10 s heartbeats): nodes/100 reports/s.

```
node node_modules/pnpm/bin/pnpm.mjs bench:scale -- tests/bench/inventory-ingest.bench.ts
BETTER_COMPUTE_POSTGRES_URL=postgres://… node node_modules/pnpm/bin/pnpm.mjs bench:scale -- tests/bench/inventory-ingest.bench.ts
```

Results land in `results/`.

## 10k nodes, PGlite, one sequential reconciler (not reference hardware)

| Step | nodes/s | p50 | p99 | statements/node |
|---|---|---|---|---|
| report (batched hashes, 500) | 12,663 | – | – | 0.002 |
| ingest (batched sections, 500) | 2,445 | – | – | 0.02 |
| apply (join storm) | 87 | 10.8 ms | 22.2 ms | 18 |
| steady report | 12,508 | – | – | 0.002 |
| change: report + ingest `gpus` | 14,251 / 9,232 | – | – | – |
| change: apply | 88 | 10.9 ms | 20.4 ms | 19 |

- **Steady state:** 125× the need, which is 100 reports/s at 10k nodes. Unchanged hashes cost one set-based
  statement per batch, and nothing is applied.
- **A fleet-wide change, or the first join of 10k machines:** about 2 minutes with a single sequential
  reconciler. Workers on Postgres apply shards in parallel. A gateway takeover re-Hellos every node with
  unchanged hashes, so it applies nothing.
- **Scaling:** the numbers at 1k and 10k are the same (apply 92–105 vs 87–88 nodes/s). Every statement is keyed
  by node; none scans the fleet.
- **Profile of apply:** 18–19 statements, spread evenly at 0.4–0.85 ms each. The largest are the label
  replace, the device upsert, the two work_queue enqueues, the node lock, the booked-devices check and the
  snapshot insert. There is no outlier to remove; batching all of it would change the reconciler's
  one-transaction-per-node design for no need the numbers show. Nothing was changed.
