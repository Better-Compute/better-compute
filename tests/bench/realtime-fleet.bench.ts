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
// BENCH_RT_POLL_MS (50; how often the harness reads states, which bounds resolution), BENCH_RT_GATE=1 to fail the run when acknowledgement p99 ≥ 2 s or any command fails.

const nodes = Number(process.env.BENCH_RT_NODES ?? 1_000);
const perNode = Number(process.env.BENCH_RT_PER_NODE ?? 1);
const shared = process.env.BENCH_RT_SHARED === '1';
const pollMs = Number(process.env.BENCH_RT_POLL_MS ?? 50);
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
      config: { nodes, perNode, sharedConnection: shared, pollMs },
      connect: { elapsedMs: connect.elapsedMs },
      ack: dispatch.firstUpdate,
      terminal: dispatch.terminal,
      failed: dispatch.failed.length,
      failures: dispatch.failed.slice(0, 20),
      gate: {
        ackP99Ms: 2_000,
        met: dispatch.failed.length === 0 && dispatch.firstUpdate.p99 < 2_000,
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
        { connect: result.connect, ack: result.ack, terminal: result.terminal, gate: result.gate },
        null,
        2,
      ),
    );
    if (process.env.BENCH_RT_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
