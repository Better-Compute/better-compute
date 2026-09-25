import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlacementRequest, SqlExecutor, SqlTx } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  inlinePlacer,
  lockPool,
  placeFromIndex,
  placeQueued,
  poolLeasePlacer,
  PoolIndexCache,
  type ReservationDeps,
} from '@better-compute/capacity';
import { checkI1 } from '@better-compute/testing';

// The v0.1 placements/s measurement (PLAN.md §16, bench/REFERENCE.md "placements"): the inline placer
// on one pool of BENCH_PLACE_NODES nodes × 8 GPUs. Each placement is an admission-shaped transaction
// (place + commit). Reports placements/s, latency and how long the pool row lock is held (from the
// `pools … FOR UPDATE` row coming back to the commit), which bounds one pool's throughput.
//
//   pnpm bench:scale                                          PGlite, sequential (indicative)
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale  Postgres, concurrency steps
//
// Knobs: BENCH_PLACE_NODES (1000), BENCH_PLACE_COUNT per step (300), BENCH_PLACE_CONCURRENCY ("1,8,32" on pg),
// BENCH_PLACE_GPUS per placement (1), BENCH_PLACE_PROFILE=1 for time per statement.
//
// After every step I1 is checked over device_bookings (no atom booked twice at once; every live
// allocation holds exactly its bookings). The result records the v0.4 gate (§16: ≥200 placements/s
// through the pool-lease placer, end to end = the placeQueued step) as `gate.met`; setting
// BENCH_PLACE_GATE (placements/s) also fails the run below it — on the reference hardware and
// Postgres, not PGlite, whose numbers are indicative.

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const nodes = Number(process.env.BENCH_PLACE_NODES ?? 1000);
const count = Number(process.env.BENCH_PLACE_COUNT ?? 300);
const gpus = Number(process.env.BENCH_PLACE_GPUS ?? 1);
const concurrencies = (process.env.BENCH_PLACE_CONCURRENCY ?? (postgresUrl ? '1,8,32' : '1'))
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

const gateTarget = Number(process.env.BENCH_PLACE_GATE ?? 200);
const gateEnforced = process.env.BENCH_PLACE_GATE !== undefined;

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;

/** I1 over the bookings a step left behind, plus allocations that disagree with their bookings. */
async function assertI1(db: SqlExecutor, step: string): Promise<void> {
  const { rows } = await db.query<{
    allocation_id: string;
    device_id: string;
    start_ms: number;
    end_ms: number;
  }>(
    `SELECT allocation_id, device_id, (extract(epoch FROM lower(during)) * 1000)::float8 AS start_ms,
            (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms FROM device_bookings`,
  );
  const violations = checkI1({
    bookings: rows.map((row) => ({
      allocationId: row.allocation_id,
      deviceId: row.device_id,
      start: Number(row.start_ms),
      end: Number(row.end_ms),
    })),
  });
  expect(violations, `I1 after ${step}`).toEqual([]);
  const mismatched = await db.query<{ id: string }>(
    `SELECT a.id FROM allocations a LEFT JOIN device_bookings b ON b.allocation_id = a.id
      WHERE a.released_at IS NULL GROUP BY a.id, a.atoms
     HAVING count(b.device_id) <> cardinality(a.atoms)`,
  );
  expect(mismatched.rows, `allocations whose bookings disagree after ${step}`).toEqual([]);
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
  };
};

interface Step {
  concurrency: number;
  placements: number;
  pending: number;
  errors: number;
  seconds: number;
  placementsPerSecond: number;
  latencyMs: ReturnType<typeof summary>;
  lockHeldMs: ReturnType<typeof summary>;
}

describe('placements', () => {
  let db: SqlExecutor;
  const steps: Step[] = [];
  let gate:
    | { placementsPerSecond: number; step: string; measured: number; met: boolean }
    | undefined;

  beforeAll(async () => {
    db = postgresUrl
      ? (await import('@better-compute/postgres')).postgres({ url: postgresUrl, max: 40 })
      : pglite();
    await db.migrate([...capacityMigrations]);
    await useSimClock(db, T0);
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version)
       VALUES ('site_bench', 'root', 'shared', 'eu', 1) ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_bench', 'root', 'site_bench', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)
       ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT 'n_' || lpad(i::text, 5, '0'), 'site_bench', 'pool_bench', 'root', 'host', 'adopted', false, false,
              'connected', 'platform', 1, 1, 1, 1, 0, 1
         FROM generate_series(1, $1::int) i ON CONFLICT DO NOTHING`,
      [nodes],
    );
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source)
       SELECT 'n_' || lpad(i::text, 5, '0'), 'fabric.domain', 'd' || (i % 16), 'inventory'
         FROM generate_series(1, $1::int) i ON CONFLICT DO NOTHING`,
      [nodes],
    );
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       SELECT 'n_' || lpad(i::text, 5, '0') || '-g' || g, 'n_' || lpad(i::text, 5, '0'), 'gpu', true, true, '{}'
         FROM generate_series(1, $1::int) i, generate_series(0, 7) g ON CONFLICT DO NOTHING`,
      [nodes],
    );
  }, 600_000);

  afterAll(async () => {
    if (steps.length) {
      const result = {
        suite: 'placements',
        time: new Date().toISOString(),
        database: postgresUrl ? 'postgres' : 'pglite',
        nodes,
        gpusPerPlacement: gpus,
        host: { cpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) },
        steps,
        ...(gate ? { gate } : {}),
      };
      mkdirSync('bench/placements/results', { recursive: true });
      writeFileSync(
        `bench/placements/results/${result.time.replace(/[:.]/g, '-')}-${result.database}-${nodes}.json`,
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.log(JSON.stringify(result, null, 2));
    }
    await db?.close();
  });

  for (const concurrency of concurrencies)
    it(`places ${count} × ${gpus} GPU at concurrency ${concurrency}`, async () => {
      await db.query(`DELETE FROM device_bookings`);
      await db.query(`DELETE FROM allocations`);
      await db.query(`DELETE FROM pool_capacity_rollup`);
      const placer = inlinePlacer();
      const profile = process.env.BENCH_PLACE_PROFILE ? new Map<string, number>() : undefined;
      let sequence = 0;
      const latencies: number[] = [];
      const held: number[] = [];
      let placed = 0;
      let pending = 0;
      let errors = 0;
      const request = (): PlacementRequest => ({
        tenantId: 'acme',
        poolId: 'pool_bench',
        reservationId: `rsv_${concurrency}_${++sequence}`,
        devices: [{ class: 'gpu', count: gpus }],
        during: { start: T0, end: T0 + HOUR },
      });
      const context = {
        clock: { now: () => T0 },
        random: Math.random,
        plugins: [],
        weights: {},
        topN: 5,
      };
      const one = async () => {
        const started = performance.now();
        let locked: number | undefined;
        try {
          const outcome = await db.transaction((tx) => {
            const timed: SqlTx = {
              async query(text, params) {
                const before = performance.now();
                const result = await tx.query(text, params);
                if (profile) {
                  const key = text.replace(/\s+/g, ' ').trim().slice(0, 70);
                  profile.set(key, (profile.get(key) ?? 0) + performance.now() - before);
                }
                if (locked === undefined && /FROM pools WHERE id = \$1 FOR UPDATE/.test(text))
                  locked = performance.now();
                return result;
              },
            };
            return placer.place(timed, request(), context);
          });
          if (outcome.status === 'placed') placed++;
          else pending++;
        } catch {
          errors++;
        }
        const ended = performance.now();
        latencies.push(ended - started);
        if (locked !== undefined) held.push(ended - locked);
      };
      const started = performance.now();
      let issued = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (issued < count) {
            issued++;
            await one();
          }
        }),
      );
      const seconds = (performance.now() - started) / 1000;
      const step: Step = {
        concurrency,
        placements: placed,
        pending,
        errors,
        seconds: Math.round(seconds * 100) / 100,
        placementsPerSecond: Math.round((placed / seconds) * 10) / 10,
        latencyMs: summary(latencies),
        lockHeldMs: summary(held),
      };
      steps.push(step);
      if (profile)
        console.log(
          [...profile]
            .sort((a, b) => b[1] - a[1])
            .map(([key, ms]) => `${(ms / count).toFixed(2).padStart(8)} ms/placement  ${key}`)
            .join('\n'),
        );
      console.log(`placements c=${concurrency}`, JSON.stringify(step));
      expect(errors).toBe(0);
      expect(placed).toBe(count);
      await assertI1(db, `inline c=${concurrency}`);
    });

  // The v0.4 pool-lease placer's batch: one transaction per ≤64 requests, one in-memory index each.
  it(`places ${count} × ${gpus} GPU in pool-lease batches of 64`, async () => {
    await db.query(`DELETE FROM device_bookings`);
    await db.query(`DELETE FROM allocations`);
    await db.query(`DELETE FROM pool_capacity_rollup`);
    const context = {
      clock: { now: () => T0 },
      random: Math.random,
      plugins: [],
      weights: {},
      topN: 5,
    };
    let sequence = 0;
    let placed = 0;
    const batches: number[] = [];
    const loads: number[] = [];
    // One batch per simulated second, so the index is rebuilt every fifth batch.
    const indexes = new PoolIndexCache();
    const started = performance.now();
    for (let done = 0; done < count; done += 64) {
      const size = Math.min(64, count - done);
      const batchStart = performance.now();
      let keep: (() => void) | undefined;
      placed += await db.transaction(async (tx) => {
        const pool = await lockPool(tx, 'pool_bench');
        // As the capacity.placer worker does: the index is kept between batches (5 s max age).
        const loadStart = performance.now();
        const checkout = await indexes.checkout(tx, pool, T0 + Math.floor(done / 64) * 1_000);
        const index = checkout.index;
        keep = checkout.keep;
        loads.push(performance.now() - loadStart);
        let ok = 0;
        for (let i = 0; i < size; i++) {
          const outcome = await placeFromIndex(
            tx,
            index,
            {
              tenantId: 'acme',
              poolId: 'pool_bench',
              reservationId: `rsv_batch_${++sequence}`,
              devices: [{ class: 'gpu', count: gpus }],
              during: { start: T0, end: T0 + HOUR },
            },
            context,
          );
          if (outcome.status === 'placed') ok++;
        }
        return ok;
      });
      keep?.();
      batches.push(performance.now() - batchStart);
    }
    const seconds = (performance.now() - started) / 1000;
    const step: Step = {
      concurrency: 0,
      placements: placed,
      pending: count - placed,
      errors: 0,
      seconds: Math.round(seconds * 100) / 100,
      placementsPerSecond: Math.round((placed / seconds) * 10) / 10,
      latencyMs: summary(batches),
      // The batch holds the pool lock for its whole transaction.
      lockHeldMs: summary(batches),
    };
    steps.push(step);
    console.log(
      'placements pool-lease batch',
      JSON.stringify(step),
      'index load ms',
      summary(loads),
    );
    expect(placed).toBe(count);
    await assertI1(db, 'pool-lease batches');
  });

  // End to end: the capacity.placer worker's placeQueued over queued reservation rows, with an event
  // and a work-queue write per reservation (one INSERT each, standing in for outbox and work_queue).
  /** Queued (pool-lease) reservation rows `from + 1 … from + n`, as admission leaves them. */
  const queueReservations = (from: number, n: number) =>
    db.query(
      `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, owner_identity_id,
                                 idempotency_key, version, conditions)
       SELECT 'rsv_q' || lpad(i::text, 9, '0'), 'acme', 'pool_bench', 'pending',
              jsonb_build_object('poolId', 'pool_bench', 'devices', jsonb_build_array(
                jsonb_build_object('class', 'gpu', 'count', $3::int)), 'duration', '3600000ms', 'binding', 'hold'),
              '\\x00'::bytea, 'usr_bench', 'k' || i, 1,
              '[{"type": "Queued", "status": "true", "reason": "PoolPlacer", "since": 0}]'::jsonb
         FROM generate_series($1::int + 1, $1::int + $2::int) i`,
      [from, n, gpus],
    );
  /** The capacity.placer worker's deps, with an INSERT per event and work item (outbox, work_queue). */
  const placerDeps = async (): Promise<ReservationDeps> => {
    await db.query(`CREATE TABLE IF NOT EXISTS bench_side (kind text, key text)`);
    const side = async (tx: SqlTx, kind: string, key: string) => {
      await tx.query(`INSERT INTO bench_side VALUES ($1, $2)`, [kind, key]);
    };
    return {
      clock: { now: () => T0 },
      events: {
        publish: (tx: SqlTx, event: { type: string; subject: string }) =>
          side(tx, event.type, event.subject),
      },
      work: { enqueue: (tx: SqlTx, kind: string, key: string) => side(tx, kind, key) },
      authz: {},
      desired: { async invalidate() {} },
      placer: poolLeasePlacer(),
      inline: inlinePlacer(),
      placement: { random: Math.random, plugins: [], weights: {}, topN: 5 },
    } as unknown as ReservationDeps;
  };

  it(`places ${count} queued reservations through placeQueued`, async () => {
    for (const table of ['device_bookings', 'allocations', 'pool_capacity_rollup', 'reservations'])
      await db.query(`DELETE FROM ${table}`);
    await queueReservations(0, count);
    const deps = await placerDeps();
    const indexes = new PoolIndexCache();
    let placed = 0;
    const batches: number[] = [];
    const held: number[] = [];
    const started = performance.now();
    for (let more = true; more; ) {
      const batchStart = performance.now();
      let locked: number | undefined;
      const result = await db.transaction((tx) => {
        // The pool row lock, from `pools … FOR UPDATE` to the commit.
        const timed: SqlTx = {
          async query(text, params) {
            const answer = await tx.query(text, params);
            if (locked === undefined && /FROM pools WHERE id = \$1 FOR UPDATE/.test(text))
              locked = performance.now();
            return answer;
          },
        };
        return placeQueued(deps, timed, 'pool_bench', { cache: indexes });
      });
      const ended = performance.now();
      batches.push(ended - batchStart);
      if (locked !== undefined) held.push(ended - locked);
      placed += result.placed;
      more = result.more;
      result.keep?.();
    }
    const seconds = (performance.now() - started) / 1000;
    const step: Step = {
      concurrency: -1,
      placements: placed,
      pending: count - placed,
      errors: 0,
      seconds: Math.round(seconds * 100) / 100,
      placementsPerSecond: Math.round((placed / seconds) * 10) / 10,
      latencyMs: summary(batches),
      lockHeldMs: summary(held),
    };
    steps.push(step);
    console.log('placements placeQueued', JSON.stringify(step));
    expect(placed).toBe(count);
    await assertI1(db, 'placeQueued');
    gate = {
      placementsPerSecond: gateTarget,
      step: 'placeQueued',
      measured: step.placementsPerSecond,
      met: step.placementsPerSecond >= gateTarget,
    };
    console.log(`placements gate ${gate.met ? 'MET' : 'NOT MET'}`, JSON.stringify(gate));
    if (gateEnforced) expect(step.placementsPerSecond).toBeGreaterThanOrEqual(gateTarget);
  });

  // The v0.4 acceptance shape (§16: ≥200 placements/s for 30 min with I1 intact), opt-in with
  // BENCH_PLACE_SUSTAIN_SECONDS (1800 for the real thing): reservations keep arriving through
  // placeQueued while the oldest allocations are released to make room, and every 10 s window's
  // rate is recorded. With a sustained run the gate is judged on the slowest window.
  const sustainSeconds = Number(process.env.BENCH_PLACE_SUSTAIN_SECONDS ?? 0);
  it.skipIf(!(sustainSeconds > 0))(
    `sustains pool-lease placements for ${sustainSeconds} s`,
    async () => {
      for (const table of [
        'device_bookings',
        'allocations',
        'pool_capacity_rollup',
        'reservations',
      ])
        await db.query(`DELETE FROM ${table}`);
      const deps = await placerDeps();
      let indexes = new PoolIndexCache();
      // Keep at most half the pool's GPUs booked: release the oldest allocations beyond that.
      const keepLive = Math.floor((nodes * 8) / 2 / gpus);
      const wave = 256;
      let queued = 0;
      let placed = 0;
      let live = 0;
      const windows: number[] = [];
      let windowStart = performance.now();
      let windowPlaced = 0;
      const started = performance.now();
      const deadline = started + sustainSeconds * 1000;
      while (performance.now() < deadline) {
        await queueReservations(queued, wave);
        queued += wave;
        for (let more = true; more; ) {
          const result = await db.transaction((tx) =>
            placeQueued(deps, tx, 'pool_bench', { cache: indexes }),
          );
          placed += result.placed;
          live += result.placed;
          windowPlaced += result.placed;
          more = result.more;
          result.keep?.();
        }
        if (live > keepLive) {
          // Early release, set-based (the bench stands in for many releaseReservation calls): the
          // bookings go, the allocations and reservations are marked released.
          const excess = live - keepLive;
          await db.transaction(async (tx) => {
            const { rows } = await tx.query<{ id: string; owner_id: string }>(
              `SELECT id, owner_id FROM allocations WHERE released_at IS NULL ORDER BY id LIMIT $1`,
              [excess],
            );
            const ids = rows.map((row) => row.id);
            await tx.query(`DELETE FROM device_bookings WHERE allocation_id = ANY($1::text[])`, [
              ids,
            ]);
            await tx.query(
              `UPDATE allocations SET released_at = compute_now() WHERE id = ANY($1::text[])`,
              [ids],
            );
            await tx.query(
              `UPDATE reservations SET state = 'released' WHERE id = ANY($1::text[])`,
              [rows.map((row) => row.owner_id)],
            );
          });
          live = keepLive;
          // The cached index never saw these releases, and the bench clock never ages it: rebuild
          // (the worker's does at 5 s).
          indexes = new PoolIndexCache();
        }
        const now = performance.now();
        if (now - windowStart >= 10_000) {
          windows.push(Math.round((windowPlaced / ((now - windowStart) / 1000)) * 10) / 10);
          windowStart = now;
          windowPlaced = 0;
        }
      }
      const seconds = (performance.now() - started) / 1000;
      const sorted = [...windows].sort((a, b) => a - b);
      const step: Step = {
        concurrency: -2,
        placements: placed,
        pending: queued - placed,
        errors: 0,
        seconds: Math.round(seconds * 100) / 100,
        placementsPerSecond: Math.round((placed / seconds) * 10) / 10,
        latencyMs: summary([]),
        lockHeldMs: summary([]),
      };
      steps.push(step);
      console.log(
        'placements sustained',
        JSON.stringify(step),
        'windows/s',
        JSON.stringify({ min: sorted[0] ?? 0, p50: percentile(sorted, 50), count: windows.length }),
      );
      await assertI1(db, 'sustained placeQueued');
      const slowest = sorted[0] ?? step.placementsPerSecond;
      gate = {
        placementsPerSecond: gateTarget,
        step: `sustained ${sustainSeconds} s (slowest 10 s window)`,
        measured: slowest,
        met: slowest >= gateTarget,
      };
      console.log(`placements gate ${gate.met ? 'MET' : 'NOT MET'}`, JSON.stringify(gate));
      if (gateEnforced) expect(slowest).toBeGreaterThanOrEqual(gateTarget);
    },
    (sustainSeconds + 600) * 1000,
  );
});
