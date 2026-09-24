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

The shortlist (`packages/capacity/src/shortlist.ts`):

- It counts free and bookable atoms per schedulable node in SQL, then loads and plans only the best 48 nodes, ranked
  by the count-derived part of the score.
- It is exact. It answers only when no node outside the shortlist could reach the top N, and otherwise the placer
  plans the whole pool.
- The lock is taken only for the guarded commit, which re-validates the node, the atoms (EXCLUDE) and the scalars.
