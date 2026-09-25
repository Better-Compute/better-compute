# placements

Placements/s of the v0.1 inline placer (PLAN.md §10.3, §16) on one pool of `BENCH_PLACE_NODES` nodes × 8 GPUs.
Every placement is an admission-shaped transaction. The suite reports:

- `placementsPerSecond` and `latencyMs`, from BEGIN to COMMIT;
- `lockHeldMs`, from the pool's `FOR UPDATE` row coming back to COMMIT. This critical section is what bounds one
  pool's throughput on Postgres.

```
node node_modules/pnpm/bin/pnpm.mjs bench:scale
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/placements node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

Knobs:

| Variable | Meaning | Default |
|---|---|---|
| `BENCH_PLACE_NODES` | nodes in the pool | 1000 |
| `BENCH_PLACE_COUNT` | placements per step | 300 |
| `BENCH_PLACE_GPUS` | GPUs per placement | 1 |
| `BENCH_PLACE_CONCURRENCY` | concurrency steps | `1,8,32` on Postgres, `1` on PGlite |
| `BENCH_PLACE_PROFILE=1` | prints time per SQL statement | off |

The suite is [`tests/bench/placements.bench.ts`](../../tests/bench/placements.bench.ts). Results land in `results/`.

## History (PGlite, 1k nodes, 1 GPU, sequential)

| | placements/s | p50 latency | p50 lock held |
|---|---|---|---|
| Baseline: whole pool loaded under the pool lock | 12.4 | 79 ms | 78 ms |
| SQL shortlist, planned before the lock | 35.7 | 27 ms | 2.3 ms |
| v0.4 pool-lease batches of 64 (in-memory `PoolIndex`) | 118.1 | queued, then ~540 ms per batch | the whole batch |
| + in-memory shortlist, index kept between batches (5 s) | 350.2 | queued, then ~170 ms per batch | the whole batch |

At 10k nodes × 8 GPUs (PGlite, 1 GPU per placement):

| | placements/s |
|---|---|
| inline | 7.8 |
| pool-lease, index rebuilt every batch, whole-pool plans | 21.1 |
| pool-lease, in-memory shortlist, index kept between batches | 93.3 |

End to end through `placeQueued`, with reservation rows, one event and one work-queue write each,
set-based commits give:

| | 1k nodes | 10k nodes |
|---|---|---|
| one reservation at a time | 224 | not measured |
| set-based: one bookings INSERT, one allocations INSERT and one reservations UPDATE per batch | 1,092 | 161 |

PLAN's G5 target is ≥200 placements/s per region on Postgres. Pools batch independently on the
workers that own their shards.

With the pool-lease placer (`capacityModule({ placer: 'pool-lease' })`), admission only queues the request and never
takes the pool lock. The worker that owns the pool's shard locks the pool once per batch and plans up to 64 requests
against one in-memory index. The commits are the same guarded statements, so a stale index costs a replan, never a
double booking.

The shortlist (`packages/capacity/src/shortlist.ts`):

- It counts free and bookable atoms per schedulable node in SQL, then loads and plans only the best 48 nodes, ranked
  by the count-derived part of the score.
- It is exact. It answers only when no node outside the shortlist could reach the top N, and otherwise the placer
  plans the whole pool.
- The lock is taken only for the guarded commit, which re-validates the node, the atoms (EXCLUDE) and the scalars.
