import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { createRealtimeHarness, type RealtimeHarness } from '@better-compute/testing';

// The v0.1 real-time acceptance run (PLAN.md §15 "Real-time harness", §16): 1k FakeDaemons on the wall clock,
// each on its own HTTP/2 connection to a real gateway. Until W5a's placement path lands, the measured lane is
// dispatch → CommandUpdate (acknowledgement) and → terminal for diag.nvml (the fake takes 2 s); the
// place-to-active p99 < 2 s gate joins this file with it.
//
//   pnpm bench:scale                                        PGlite, 1k nodes
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale   a disposable Postgres (the harness migrates it)
//
// Knobs: BENCH_RT_NODES (1000), BENCH_RT_PER_NODE (1), BENCH_RT_SHARED=1 (one connection for all daemons),
// BENCH_RT_POLL_MS (50; how often the harness reads states, which bounds resolution), BENCH_RT_STORM (1: the share of the\n// fleet dropped at once after the dispatch; 0 skips it), BENCH_RT_LOAD_RATE (100/s of inventory.refresh; 0 skips the\n// steady phase) for BENCH_RT_LOAD_MS (30 s), BENCH_RT_GATE=1 to fail the run when acknowledgement p99 ≥ 2 s or any command fails.

const nodes = Number(process.env.BENCH_RT_NODES ?? 1_000);
const perNode = Number(process.env.BENCH_RT_PER_NODE ?? 1);
const shared = process.env.BENCH_RT_SHARED === '1';
const pollMs = Number(process.env.BENCH_RT_POLL_MS ?? 50);
const stormFraction = Number(process.env.BENCH_RT_STORM ?? 1);
const loadRate = Number(process.env.BENCH_RT_LOAD_RATE ?? 100);
const loadMs = Number(process.env.BENCH_RT_LOAD_MS ?? 30_000);
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

let harness: RealtimeHarness | undefined;
afterAll(async () => {
  await harness?.close();
});

describe('realtime-fleet', () => {
  it(`connects ${nodes} FakeDaemons and times dispatch → CommandUpdate`, async () => {
    harness = await createRealtimeHarness({
      nodes,
      sharedConnection: shared,
      pollMs,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
    const connect = await harness.connectAll(10 * 60_000);
    const dispatch = await harness.dispatch({ kind: 'diag.nvml', perNode, timeoutMs: 10 * 60_000 });
    // Steady state (G5: command p99 < 1.5 s with polling only), after the burst and before any storm.
    const load =
      loadRate > 0
        ? await harness.load({ ratePerSecond: loadRate, durationMs: loadMs, drainMs: 10 * 60_000 })
        : undefined;
    // Then the whole fleet loses its sessions at once (a gateway or network blip) and redials.
    const storm =
      stormFraction > 0
        ? await harness.storm({ fraction: stormFraction, timeoutMs: 10 * 60_000 })
        : undefined;

    const result = {
      suite: 'realtime-fleet',
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
      config: { nodes, perNode, sharedConnection: shared, pollMs, stormFraction, loadRate, loadMs },
      connect: { elapsedMs: connect.elapsedMs },
      ack: dispatch.firstUpdate,
      terminal: dispatch.terminal,
      failed: dispatch.failed.length,
      failures: dispatch.failed.slice(0, 20),
      ...(load
        ? {
            load: {
              kind: 'inventory.refresh',
              enqueued: load.enqueued,
              offeredPerSecond: load.offeredPerSecond,
              completedPerSecond: load.completedPerSecond,
              ack: load.firstUpdate,
              terminal: load.terminal,
              failed: load.failed.length,
            },
          }
        : {}),
      ...(storm
        ? {
            storm: {
              nodes: storm.nodes,
              reconnect: storm.reconnect,
              elapsedMs: storm.elapsedMs,
              missing: storm.missing.length,
            },
          }
        : {}),
      gate: {
        ackP99Ms: 2_000,
        met: dispatch.failed.length === 0 && dispatch.firstUpdate.p99 < 2_000,
        steadyAckP99Ms: 1_500,
        steadyMet: load ? load.failed.length === 0 && load.firstUpdate.p99 < 1_500 : undefined,
        placeToActive: 'pending W5a',
      },
    };
    const dir = new URL('../../bench/realtime-fleet/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL(`${result.date.replace(/[:.]/g, '-')}-${result.database}-${nodes}.json`, dir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(
      JSON.stringify(
        {
          connect: result.connect,
          ack: result.ack,
          terminal: result.terminal,
          load: result.load,
          storm: result.storm,
          gate: result.gate,
        },
        null,
        2,
      ),
    );
    if (process.env.BENCH_RT_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
