import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createControlPlaneSim,
  summarize,
  type ControlPlaneSim,
} from '@better-compute/testing';

// The v0.4 gateway-kill exit at scale, in simulation (PLAN.md §16: "gateway-kill recovery < 60 s"): N FakeDaemons
// joined through JoinService behind 3 real gateways and the real control plane, on the fleet simulator's clock.
// One gateway dies; the run records how long its nodes take to hold a session on another gateway (simulated
// time), the heap each gateway's sessions cost, and that nothing ran twice (I2).
//
//   pnpm bench:scale      BENCH_MG_NODES (1000; the v0.4 claim is 10000), BENCH_MG_GATEWAYS (3), BENCH_MG_GATE=1
//
// Wall time grows with N (every join and every tick runs on the one PGlite); simulated time is what is measured.

const nodes = Number(process.env.BENCH_MG_NODES ?? 1_000);
const gateways = Number(process.env.BENCH_MG_GATEWAYS ?? 3);
const MIN = 60_000;

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

let rig: ControlPlaneSim | undefined;
afterAll(async () => {
  await rig?.close();
});

describe('multi-gateway', () => {
  it(`re-homes a killed gateway's share of ${nodes} nodes`, async () => {
    const wallStart = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    rig = await createControlPlaneSim({
      seed: 'multi-gateway-bench',
      nodes,
      gateways,
      startSpreadMs: Math.max(5_000, nodes * 20),
    });
    const joinedMs = Date.now() - wallStart;
    await rig.run(Math.max(3 * MIN, nodes * 30));
    const connected = rig.nodes.filter(({ nodeId }) => rig!.homeOf(nodeId) !== undefined).length;
    global.gc?.();
    const heapConnected = process.memoryUsage().heapUsed;
    const sessionsPerGateway = rig.gateways.map((gateway) => gateway?.sessions().length ?? 0);

    const moved = rig.killGateway(0);
    const killedAt = rig.sim.scheduler.now();
    const rehomed = new Map<string, number>();
    while (rehomed.size < moved.length && rig.sim.scheduler.now() - killedAt < 5 * MIN) {
      await rig.run(250);
      for (const nodeId of moved) {
        const home = rig.homeOf(nodeId);
        if (!rehomed.has(nodeId) && home !== undefined && home !== 0)
          rehomed.set(nodeId, rig.sim.scheduler.now() - killedAt);
      }
    }
    await rig.run(MIN);
    const violations = await rig.invariants();
    const rehome = summarize([...rehomed.values()]);
    const result = {
      suite: 'multi-gateway',
      commit: commit(),
      date: new Date().toISOString(),
      referenceHardware: false,
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        memoryGiB: Math.round(totalmem() / 2 ** 30),
      },
      node: process.version,
      config: { nodes, gateways },
      wall: { joinMs: joinedMs, totalMs: Date.now() - wallStart },
      connected,
      sessionsPerGateway,
      heap: {
        // The whole fleet (daemons, sim, control plane) over the gateways' sessions: an upper bound per session.
        mibTotal: Math.round((heapConnected - heapBefore) / 2 ** 20),
        kibPerSessionUpperBound: Math.round((heapConnected - heapBefore) / 1024 / Math.max(1, connected)),
      },
      kill: { moved: moved.length, rehomed: rehomed.size, rehomeMs: rehome },
      invariants: violations.length,
      violationsSample: violations.slice(0, 10),
      gate: {
        rehomeP99Ms: 60_000,
        met: rehomed.size === moved.length && rehome.p99 < 60_000 && violations.length === 0,
      },
    };
    const dir = new URL('../../bench/multi-gateway/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL(`${result.date.replace(/[:.]/g, '-')}-${nodes}.json`, dir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(result, null, 2));
    if (process.env.BENCH_MG_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
