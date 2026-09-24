import { writeFile } from 'node:fs/promises';
import { parseDuration } from '@better-compute/core';
import { importOptional } from '../config.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';

// `better-compute sim` (PLAN.md §9.3, §15 "TS deterministic"): a seeded fleet of FakeDaemons
// against the in-memory gateway stub, with a steady workload and optional chaos, then a quiet
// period; it checks invariants I1, I2, I5 and I8 and prints the event-log digest, so the same seed
// reproduces the same run byte for byte. Needs the optional peer @better-compute/testing.

export type ChaosLevel = 'none' | 'light' | 'heavy';

// The slice of @better-compute/testing this command uses, typed structurally: the package is an
// optional peer, loaded only when `sim` runs.
type LinkFaults = Record<string, number | string>;
export interface FleetSimOptions {
  seed: string;
  nodes: number;
  logFrames?: boolean;
  up?: LinkFaults;
  down?: LinkFaults;
  chaos?: Record<string, number>;
}
interface Rng {
  fork(label: string): Rng;
  pick<T>(items: readonly T[]): T;
  next(): number;
  chance(p: number): boolean;
  range(min: number, max: number): number;
}
interface StubAllocation {
  allocationId: string;
  state: string;
}
interface GatewayStub {
  enqueue(nodeId: string, kind: string, payload: Record<string, unknown>): unknown;
  freeGpus(nodeId: string): string[];
  book(input: { nodeId: string; deviceIds: string[]; durationMs: number }): unknown;
  release(allocationId: string, reason: string): unknown;
  flushUsage(): unknown;
  allocations: Map<string, StubAllocation>;
  commands: Map<string, { state: unknown }>;
}
interface FleetSim {
  stub: GatewayStub | undefined;
  rng: Rng;
  nodeIds: readonly string[];
  scheduler: { now(): number };
  log: { find(event: string, source?: string): unknown[]; lines(): string[] };
  start(): Promise<void>;
  run(ms: number): Promise<void>;
  every(ms: number, fn: (now: number) => void): () => void;
  quiesce(): void;
  invariants(options?: {
    flushedUpTo?: number;
  }): { invariant: string; message: string; subject: string }[];
  digest(): string;
}
interface TestingModule {
  createFleetSim(options: FleetSimOptions): FleetSim;
  isTerminal(state: unknown): boolean;
}

/** Link faults and chaos per level (heavy is the test suite's fleet-100 profile). */
export function simOptions(seed: string, nodes: number, chaos: ChaosLevel): FleetSimOptions {
  const base: FleetSimOptions = { seed, nodes, logFrames: false };
  if (chaos === 'none') return base;
  const heavy = chaos === 'heavy';
  const link = {
    latencyMs: 5,
    jitterMs: 20,
    drop: heavy ? 0.0005 : 0.0001,
    dropMode: 'reset' as const,
    duplicate: heavy ? 0.01 : 0.002,
  };
  return {
    ...base,
    up: link,
    down: { ...link, reorder: heavy ? 0.002 : 0.0005 },
    chaos: heavy
      ? {
          everyMs: 5_000,
          crash: 0.3,
          reboot: 0.1,
          journalLoss: 0.05,
          partition: 0.3,
          isolate: 0.1,
          halfOpen: 0.1,
          reset: 0.2,
          stall: 0.2,
          gatewayKill: 0.02,
        }
      : { everyMs: 15_000, crash: 0.1, reboot: 0.05, partition: 0.1, reset: 0.1, stall: 0.05 },
  };
}

/** Commands and bookings every 2 s from the sim's own seeded stream (the stub must exist). */
function workload(sim: FleetSim): () => void {
  const stub = sim.stub!;
  const rng = sim.rng.fork('workload');
  return sim.every(2_000, (now) => {
    for (let i = 0; i < 3; i++) {
      const nodeId = rng.pick(sim.nodeIds);
      const draw = rng.next();
      if (draw < 0.5) stub.enqueue(nodeId, 'diag.nvml', { expectedGpuCount: 8 });
      else if (draw < 0.75) stub.enqueue(nodeId, 'inventory.refresh', { sections: ['gpus'] });
      else if (draw < 0.97)
        stub.enqueue(nodeId, 'logs.collect', {
          uploadUrl: `https://objects.example/${nodeId}/${now}`,
        });
      else stub.enqueue(nodeId, 'node.reboot', { reason: 'workload', delayMs: 500 });
    }
    const nodeId = rng.pick(sim.nodeIds);
    const free = stub.freeGpus(nodeId);
    if (free.length >= 2 && rng.chance(0.7))
      stub.book({
        nodeId,
        deviceIds: free.slice(0, rng.range(1, 2)),
        durationMs: rng.range(30_000, 300_000),
      });
    const active = [...stub.allocations.values()].filter((a) => a.state === 'active');
    if (active.length > 0 && rng.chance(0.3))
      stub.release(rng.pick(active).allocationId, 'release');
  });
}

const durationMs = (value: string, flag: string) => {
  try {
    return parseDuration(value);
  } catch {
    throw usageError(`--${flag} ${value}: a duration looks like 30s, 10m or 2h`);
  }
};

export const simCommands = [
  defineCommand({
    name: 'sim',
    group: 'Setup',
    summary: 'Run the deterministic fleet simulator and check its invariants',
    description:
      'sim runs --nodes FakeDaemons on fake hardware against the in-memory gateway stub for --duration of simulated time, with a steady workload (diagnostics, inventory refreshes, log collection, reboots, GPU bookings) and --chaos faults (none, light, heavy: crashes, reboots, journal loss, partitions, half-open links, resets, stalls, gateway kills), then quiesces for --settle and checks invariants I1 (no double booking), I2 (at-most-once side effects), I5 (every command terminal) and I8 (usage). Nothing reads the wall clock: the same --seed prints the same digest. It exits SIM_INVARIANT_VIOLATED when an invariant fails. Needs @better-compute/testing.',
    flags: {
      seed: { type: 'string', value: 'SEED', default: 'sim', description: 'The seed' },
      nodes: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 5000,
        default: 50,
        description: 'Simulated nodes',
      },
      duration: {
        type: 'string',
        value: 'DURATION',
        default: '10m',
        description: 'Simulated time under workload',
      },
      settle: {
        type: 'string',
        value: 'DURATION',
        default: '16m',
        description: 'Quiet time afterwards (sweeper and replays settle)',
      },
      chaos: {
        type: 'string',
        value: 'LEVEL',
        default: 'light',
        description: 'none, light or heavy',
      },
      log: { type: 'string', value: 'PATH', description: 'Write the event log to a new file' },
    },
    validate(flags) {
      if (!['none', 'light', 'heavy'].includes(flags.chaos ?? 'light'))
        throw usageError('--chaos must be none, light or heavy');
    },
    examples: [
      'better-compute sim',
      'better-compute sim --seed nightly-42 --nodes 500 --duration 1h --chaos heavy',
    ],
    async run({ flags, path, note }) {
      const testing = await importOptional<TestingModule>(
        '@better-compute/testing',
        'better-compute sim',
      );
      const seed = flags.seed ?? 'sim';
      const nodes = flags.nodes ?? 50;
      const chaos = (flags.chaos ?? 'light') as ChaosLevel;
      const run = durationMs(flags.duration ?? '10m', 'duration');
      const settle = durationMs(flags.settle ?? '16m', 'settle');
      const sim = testing.createFleetSim(simOptions(seed, nodes, chaos));
      const stub = sim.stub!;
      const started = Date.now();
      await sim.start();
      const stop = workload(sim);
      await sim.run(run);
      stop();
      sim.quiesce();
      await sim.run(settle);
      stub.flushUsage();
      const violations = sim.invariants({ flushedUpTo: sim.scheduler.now() });
      const commands = [...stub.commands.values()];
      const count = (event: string) => sim.log.find(event, 'sim').length;
      if (flags.log) {
        const target = path(flags.log);
        await writeFile(target, `${sim.log.lines().join('\n')}\n`, { flag: 'wx' });
        note(`Wrote the event log to ${target}.`);
      }
      const report = {
        seed,
        nodes,
        chaos,
        simulatedMs: run + settle,
        wallMs: Date.now() - started,
        digest: sim.digest(),
        commands: {
          total: commands.length,
          open: commands.filter((command) => !testing.isTerminal(command.state)).length,
        },
        faults: {
          crashes: count('crash'),
          reboots: count('reboot'),
          journalLosses: count('journal-loss'),
          gatewayKills: count('gateway.kill'),
        },
        violations: violations.length,
        firstViolations: violations.slice(0, 20),
      };
      if (violations.length) {
        note(JSON.stringify(report, null, 2));
        throw new CliError(
          'SIM_INVARIANT_VIOLATED',
          `${violations.length} invariant violation(s) with seed ${JSON.stringify(seed)}`,
          `Re-run with --seed ${seed} to reproduce; --log writes the event log.`,
        );
      }
      return report;
    },
  }),
];
