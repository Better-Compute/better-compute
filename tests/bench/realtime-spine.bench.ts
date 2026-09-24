import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { createRealtimeFleet, type RealtimeFleet } from '@better-compute/testing';

// The §16 v0.1 acceptance run: "place-to-active p99 < 2 s with 1k FakeDaemons in the real-time harness". The whole
// spine on the wall clock: a real control plane with its workers, a real gateway, and FakeDaemons that Join with
// sealed tokens, pass diag.nvml acceptance and apply their NodeSpec; then whole-node reservations bind on them and
// turn active on the daemons' AllocationBound reports.
//
//   pnpm bench:scale                                              PGlite, 1k nodes
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale      a disposable Postgres (the fleet migrates it)
//
// The gate phase places BENCH_SPINE_RESERVATIONS (200) whole-node reservations at a steady BENCH_SPINE_RATE (5/s);
// a burst phase then fires BENCH_SPINE_BURST (100) at once, reported but not gated. Knobs: BENCH_SPINE_NODES (1000),
// BENCH_SPINE_JOIN_CONCURRENCY (32), BENCH_SPINE_PLACE_CONCURRENCY (8), BENCH_SPINE_GATE=1 to fail the run when the
// paced place-to-active p99 ≥ 2 s.

const nodes = Number(process.env.BENCH_SPINE_NODES ?? 1_000);
const reservations = Number(process.env.BENCH_SPINE_RESERVATIONS ?? Math.min(200, nodes));
const rate = Number(process.env.BENCH_SPINE_RATE ?? 5);
const burst = Number(
  process.env.BENCH_SPINE_BURST ?? Math.min(100, Math.max(0, nodes - reservations)),
);
const joinConcurrency = Number(process.env.BENCH_SPINE_JOIN_CONCURRENCY ?? 32);
const placeConcurrency = Number(process.env.BENCH_SPINE_PLACE_CONCURRENCY ?? 8);
const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;

function commit(): string {
  const git = `${process.env.LOCALAPPDATA ?? ''}\\GitHubDesktop\\app-3.6.5\\resources\\app\\git\\cmd\\git.exe`;
  for (const bin of ['git', git])
    try {
      return execFileSync(bin, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // try the next one
    }
  return 'unknown';
}

let fleet: RealtimeFleet | undefined;
afterAll(async () => {
  await fleet?.close();
});

describe('realtime-spine', () => {
  it(`joins ${nodes} FakeDaemons to adopted and times place-to-active`, async () => {
    fleet = await createRealtimeFleet({ joinConcurrency, ...(postgresUrl ? { postgresUrl } : {}) });
    const joined = await fleet.join(nodes, { timeoutMs: 30 * 60_000 });
    const placed = await fleet.place(reservations, {
      ratePerSecond: rate,
      concurrency: placeConcurrency,
      timeoutMs: 30 * 60_000,
    });
    const burstPlaced =
      burst > 0
        ? await fleet.place(burst, { concurrency: placeConcurrency, timeoutMs: 30 * 60_000 })
        : undefined;
    const result = {
      suite: 'realtime-spine',
      commit: commit(),
      date: new Date().toISOString(),
      referenceHardware: false,
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        memoryGiB: Math.round(totalmem() / 2 ** 30),
      },
      node: process.version,
      database: postgresUrl ? 'postgres' : 'pglite',
      config: { nodes, reservations, rate, burst, joinConcurrency, placeConcurrency },
      join: {
        elapsedMs: joined.elapsedMs,
        rpc: joined.join,
        connected: joined.connected,
        adopted: joined.adopted,
        missing: joined.missing.length,
        missingSample: joined.missing.slice(0, 10),
      },
      place: {
        elapsedMs: placed.elapsedMs,
        create: placed.place,
        active: placed.active,
        missing: placed.missing.length,
        missingSample: placed.missing.slice(0, 10),
      },
      ...(burstPlaced
        ? {
            burst: {
              elapsedMs: burstPlaced.elapsedMs,
              create: burstPlaced.place,
              active: burstPlaced.active,
              missing: burstPlaced.missing.length,
            },
          }
        : {}),
      gate: {
        placeToActiveP99Ms: 2_000,
        met:
          joined.missing.length === 0 && placed.missing.length === 0 && placed.active.p99 < 2_000,
      },
    };
    const dir = new URL('../../bench/realtime-spine/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL(`${result.date.replace(/[:.]/g, '-')}-${result.database}-${nodes}.json`, dir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(
      JSON.stringify(
        { join: result.join, place: result.place, burst: result.burst, gate: result.gate },
        null,
        2,
      ),
    );
    if (process.env.BENCH_SPINE_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
