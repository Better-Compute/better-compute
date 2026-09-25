// The v0.4 cold start (PLAN.md §15 "10k cold start ≤3 min", §16 acceptance "cold start <3 min"): the real control
// plane and gateways under the fleet simulator, with every node powering on within a short window. Boot: each
// node's first session (`node.connected`) and its adoption (acceptance passed, `node.adopted`) are timed from the
// moment the fleet powers on; the run is ready when every node is connected, adopted and schedulable. Restart
// (optional): every gateway dies and every node power-cycles at once, and each node's first session afterwards is
// timed. Times are simulated; the outbox carries them (`payload.time` is compute_now()). The invariants (I1–I5,
// I8) are checked at the end, and a node marked unreachable during boot is a failure.

import { summarize, type LatencySummary } from '../realtime/harness.js';
import { createControlPlaneSim, type ControlPlaneSim } from './control-plane.js';
import type { InvariantViolation } from './invariants.js';

const MIN = 60_000;

export interface ColdStartOptions {
  seed: string;
  /** Default 100; the v0.4 claim is 10 000. */
  nodes?: number;
  /** Default 3. */
  gateways?: number;
  /** Nodes power on at random times within this window (default 30 s). */
  startSpreadMs?: number;
  /** Every node must be connected, adopted and schedulable within this (default 3 min). */
  limitMs?: number;
  /** Simulated time kept running after the fleet is ready, for late unreachable marks (default 1 min). */
  settleMs?: number;
  /** Then power-cycle everything and time the way back (default true). */
  restart?: boolean;
  /** How long the gateways stay down in the restart; nodes come back over `startSpreadMs` after it (default 10 s). */
  restartDownMs?: number;
  /** How often readiness is sampled, simulated ms (default 5 s). */
  stepMs?: number;
  /**
   * Batches each control-plane job may run per simulated second while it has work (default 10: one worker draining
   * ten 32-key batches a second; a real worker loops without sleeping while there is work). See
   * `ControlPlaneSimOptions.workerPasses`; the report's `wall.loops` shows what those passes cost here.
   */
  workerPasses?: number;
}

export interface ColdStartPhase {
  /** Simulated ms from the phase's start to each node's first session. */
  connectedMs: LatencySummary;
  /** Nodes without a session at the end of the phase. */
  notConnected: number;
  /** Simulated ms from the phase's start until every node was ready (undefined: not within 2 × limit). */
  allReadyMs?: number;
  /** `node.unreachable` marks published during the phase. */
  unreachableMarks: number;
}

export interface ColdStartReport {
  seed: string;
  config: Required<Omit<ColdStartOptions, 'seed'>>;
  wall: {
    setupMs: number;
    bootMs: number;
    restartMs: number;
    totalMs: number;
    /** Wall ms spent in each part of the loop (`fleet`, `gateway`, `reconcilers`, `join`, `api`). */
    loops: Record<string, number>;
  };
  boot: ColdStartPhase & {
    /** Simulated ms from power-on to each node's adoption. */
    adoptedMs: LatencySummary;
    notAdopted: number;
  };
  restart?: ColdStartPhase;
  /** Nodes connected, adopted and without NoSchedule reasons at the end. */
  schedulable: number;
  violations: InvariantViolation[];
  ok: boolean;
}

/** Yields to the event loop (a long simulation otherwise starves the test runner's own I/O). */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

async function schedulable(rig: ControlPlaneSim): Promise<number> {
  const { rows } = await rig.database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM nodes WHERE connectivity = 'connected'
        AND provision_state IN ('adopted', 'deployed') AND cardinality(no_schedule_reasons) = 0`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Each node's first `topic` event at or after `since` (simulated ms), as ms after `since`. */
async function firstAfter(
  rig: ControlPlaneSim,
  topic: string,
  since: number,
): Promise<Map<string, number>> {
  const { rows } = await rig.database.query<{ node_id: string; at: string }>(
    `SELECT payload->'data'->>'nodeId' AS node_id, min(payload->>'time') AS at FROM outbox
      WHERE topic = $1 AND (payload->>'time')::timestamptz >= to_timestamp($2::float8 / 1000)
      GROUP BY 1`,
    [topic, since],
  );
  return new Map(rows.map((row) => [row.node_id, Date.parse(row.at) - since]));
}

async function unreachableBetween(rig: ControlPlaneSim, from: number, to: number) {
  const marks = await firstAfter(rig, 'node.unreachable', from);
  return [...marks.values()].filter((ms) => from + ms <= to).length;
}

/** Runs the fleet in `stepMs` steps until `ready()` or `capMs` passed; returns when it was ready. */
async function until(
  rig: ControlPlaneSim,
  from: number,
  stepMs: number,
  capMs: number,
  ready: () => Promise<boolean>,
): Promise<number | undefined> {
  for (;;) {
    if (await ready()) return rig.sim.scheduler.now() - from;
    if (rig.sim.scheduler.now() - from >= capMs) return undefined;
    await rig.run(stepMs);
    await breathe();
  }
}

/** One cold start (and, by default, one full power cycle) of a simulated fleet. */
export async function runColdStart(options: ColdStartOptions): Promise<ColdStartReport> {
  const config: Required<Omit<ColdStartOptions, 'seed'>> = {
    nodes: options.nodes ?? 100,
    gateways: options.gateways ?? 3,
    startSpreadMs: options.startSpreadMs ?? 30_000,
    limitMs: options.limitMs ?? 3 * MIN,
    settleMs: options.settleMs ?? MIN,
    restart: options.restart ?? true,
    restartDownMs: options.restartDownMs ?? 10_000,
    stepMs: options.stepMs ?? 5_000,
    workerPasses: options.workerPasses ?? 10,
  };
  // Where the wall time goes (nested parts count in both: `fleet` includes the gateway and the reconcilers).
  const loops: Record<string, number> = {};
  const trace = <T>(path: string, fn: () => T): T => {
    const started = performance.now();
    const result = fn();
    const add = () => {
      loops[path] = (loops[path] ?? 0) + Math.round(performance.now() - started);
    };
    if (result instanceof Promise) return result.finally(add) as T;
    add();
    return result;
  };
  const wallStart = Date.now();
  // Joining is set-up, not part of the cold start: the fleet powers on when the simulator starts.
  const rig = await createControlPlaneSim({
    seed: `cold-start-${options.seed}`,
    nodes: config.nodes,
    gateways: config.gateways,
    startSpreadMs: config.startSpreadMs,
    workerPasses: config.workerPasses,
    logFrames: false,
    trace,
  });
  try {
    const setupMs = Date.now() - wallStart;
    const { sim } = rig;
    const n = rig.nodes.length;
    const powerOn = sim.scheduler.now();

    // Boot.
    const bootWall = Date.now();
    const bootReadyMs = await until(rig, powerOn, config.stepMs, 2 * config.limitMs, async () => {
      return (await schedulable(rig)) === n;
    });
    await rig.run(config.settleMs);
    const connected = await firstAfter(rig, 'node.connected', powerOn);
    const adopted = await firstAfter(rig, 'node.adopted', powerOn);
    const boot: ColdStartReport['boot'] = {
      connectedMs: summarize([...connected.values()]),
      notConnected: n - connected.size,
      adoptedMs: summarize([...adopted.values()]),
      notAdopted: n - adopted.size,
      ...(bootReadyMs === undefined ? {} : { allReadyMs: bootReadyMs }),
      unreachableMarks: await unreachableBetween(rig, powerOn, sim.scheduler.now()),
    };
    const bootMs = Date.now() - bootWall;

    // Restart: the gateways die, every node power-cycles, and they all come back.
    let restart: ColdStartPhase | undefined;
    const restartWall = Date.now();
    if (config.restart) {
      const downAt = sim.scheduler.now();
      const rng = sim.rng.fork('cold-restart');
      sim.killGateway(config.restartDownMs);
      for (const { nodeId } of rig.nodes)
        sim.reboot(nodeId, {
          durationMs: config.restartDownMs + rng.int(Math.max(1, config.startSpreadMs)),
        });
      let back = new Map<string, number>();
      const readyMs = await until(rig, downAt, config.stepMs, 2 * config.limitMs, async () => {
        back = await firstAfter(rig, 'node.connected', downAt);
        return back.size === n && (await schedulable(rig)) === n;
      });
      await rig.run(config.settleMs);
      back = await firstAfter(rig, 'node.connected', downAt);
      restart = {
        connectedMs: summarize([...back.values()]),
        notConnected: n - back.size,
        ...(readyMs === undefined ? {} : { allReadyMs: readyMs }),
        unreachableMarks: await unreachableBetween(rig, downAt, sim.scheduler.now()),
      };
    }
    const restartMs = Date.now() - restartWall;

    const violations = await rig.invariants();
    const ready = await schedulable(rig);
    const within = (phase: ColdStartPhase | undefined) =>
      phase === undefined ||
      (phase.allReadyMs !== undefined &&
        phase.allReadyMs <= config.limitMs &&
        phase.notConnected === 0);
    return {
      seed: options.seed,
      config,
      wall: { setupMs, bootMs, restartMs, totalMs: Date.now() - wallStart, loops },
      boot,
      ...(restart ? { restart } : {}),
      schedulable: ready,
      violations,
      ok:
        within(boot) &&
        boot.notAdopted === 0 &&
        boot.unreachableMarks === 0 &&
        within(restart) &&
        ready === n &&
        violations.length === 0,
    };
  } finally {
    await rig.close();
  }
}
