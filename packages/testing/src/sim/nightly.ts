// The nightly simulation (PLAN.md §15, v0.4 exit "all §15 scenarios green on 3 consecutive nights"): the real
// control plane and gateways under the fleet simulator with chaos (daemon crashes, reboots, journal loss,
// partitions, half-open links, stalls, gateway kills, worker outages) while tenants reserve at scale with every
// placement feature (whole nodes, gangs, spot with preemption, calendar starts with BookingRepair, releases) and
// operators run commands. It reports invariant violations (I1, I2, I5, I8), latencies in simulated time, outcome
// counts and two digests: the workload (a pure function of the seed) and the outcomes without ids (compute mints
// random ids, so the store itself cannot repeat bit for bit).

import { createHash } from 'node:crypto';
import { summarize, type LatencySummary } from '../realtime/harness.js';
import type { Rng } from '../rng.js';
import { createControlPlaneSim, type ControlPlaneSim } from './control-plane.js';
import type { ChaosOptions } from './fleet-sim.js';
import type { InvariantViolation } from './invariants.js';

const MIN = 60_000;

export type NightlyChaos = 'none' | 'light' | 'heavy';

export interface NightlyOptions {
  seed: string;
  /** Default 8. */
  nodes?: number;
  /** Default 3. */
  gateways?: number;
  /** Simulated minutes of workload after start-up (default 30). */
  minutes?: number;
  chaos?: NightlyChaos;
  /** Workload step in simulated ms (default 10 s). */
  stepMs?: number;
}

export interface NightlyReport {
  seed: string;
  config: Required<NightlyOptions>;
  wallMs: number;
  /** SHA-256 of the workload asked for: the same seed asks for the same things. */
  workloadDigest: string;
  /** SHA-256 of the id-free outcome summary (states, counts, violations). */
  outcomeDigest: string;
  workload: Record<string, number>;
  reservations: Record<string, number>;
  commands: Record<string, number>;
  chaos: Record<string, number>;
  /** Placed → active, simulated ms (from the harness's polling at each step). */
  placeToActiveMs: LatencySummary;
  /** Command enqueue → terminal, simulated ms. */
  commandMs: LatencySummary;
  violations: InvariantViolation[];
  ok: boolean;
}

const chaosProfiles: Record<NightlyChaos, ChaosOptions | undefined> = {
  none: undefined,
  light: { everyMs: 20_000, crash: 0.1, partition: 0.1, reset: 0.1, stall: 0.1, halfOpen: 0.05 },
  heavy: {
    everyMs: 10_000,
    crash: 0.25,
    reboot: 0.1,
    journalLoss: 0.05,
    partition: 0.25,
    isolate: 0.1,
    halfOpen: 0.1,
    reset: 0.2,
    stall: 0.2,
  },
};

type Kind = 'node' | 'half' | 'gang' | 'spot' | 'calendar';

/** One simulated night. */
export async function runNightly(options: NightlyOptions): Promise<NightlyReport> {
  const config: Required<NightlyOptions> = {
    seed: options.seed,
    nodes: options.nodes ?? 8,
    gateways: options.gateways ?? 3,
    minutes: options.minutes ?? 30,
    chaos: options.chaos ?? 'light',
    stepMs: options.stepMs ?? 10_000,
  };
  const wallStart = Date.now();
  const rig: ControlPlaneSim = await createControlPlaneSim({
    seed: `nightly-${config.seed}`,
    nodes: config.nodes,
    gateways: config.gateways,
  });
  try {
    const { compute, tenants, api, database, sim } = rig;
    const acme = { token: tenants.acme.token };
    const root = { token: tenants.root.token };
    const rng: Rng = sim.rng.fork('nightly-workload');
    const workloadLog: string[] = [];
    const counts = { workload: new Map<string, number>(), chaos: new Map<string, number>() };
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

    // Start-up: every node joins, passes acceptance and is adopted before chaos begins.
    await rig.run(3 * MIN);
    const profile = chaosProfiles[config.chaos];
    const chaosStart = sim.scheduler.now();

    const placedAt = new Map<string, number>();
    const activeAfter: number[] = [];
    const commandAt = new Map<string, number>();
    const commandAfter: number[] = [];
    const releaseAt = new Map<string, number>();
    const downGateways = new Map<number, number>();
    let workersBackAt: number | undefined;
    let revokedNode: string | undefined;
    let key = 0;

    const reserve = async (kind: Kind) => {
      const now = sim.scheduler.now();
      const spec =
        kind === 'node'
          ? { devices: [{ class: 'gpu', count: 8 }], duration: '15m' }
          : kind === 'half'
            ? { devices: [{ class: 'gpu', count: 4 }], duration: '10m' }
            : kind === 'gang'
              ? { devices: [{ class: 'gpu', count: 8 }], duration: '10m', gang: { size: 2 } }
              : kind === 'spot'
                ? { devices: [{ class: 'gpu', count: 4 }], duration: '20m', spot: true }
                : { devices: [{ class: 'gpu', count: 4 }], duration: '10m', start: now + 20 * MIN };
      workloadLog.push(`${Math.round((now - chaosStart) / 1000)}:${kind}`);
      // Drawn before the call, so the workload stays a function of the seed whatever the outcome.
      const releaseAfter = rng.chance(0.4) ? rng.range(2 * MIN, 8 * MIN) : undefined;
      bump(counts.workload, kind);
      try {
        const reservation = await api(() =>
          compute.api.reservations.create(acme, {
            tenantId: tenants.acme.id,
            poolId: rig.poolId,
            idempotencyKey: `nightly-${key++}`,
            ...spec,
          } as never),
        );
        if (reservation.state === 'placed' || reservation.state === 'active')
          placedAt.set(reservation.id, now);
        // Some reservations are released early; the rest run to their end.
        if (releaseAfter !== undefined) releaseAt.set(reservation.id, now + releaseAfter);
      } catch {
        bump(counts.workload, `${kind}-refused`);
      }
    };

    const end = chaosStart + config.minutes * MIN;
    while (sim.scheduler.now() < end) {
      const now = sim.scheduler.now();
      // Tenants: one arrival per step on average, with every placement feature in the mix.
      const draw = rng.next();
      const kind: Kind =
        draw < 0.35
          ? 'half'
          : draw < 0.55
            ? 'node'
            : draw < 0.7
              ? 'spot'
              : draw < 0.85
                ? 'gang'
                : 'calendar';
      if (rng.chance(0.9)) await reserve(kind);
      // Operators: a command on a random adopted node every few steps.
      if (rng.chance(0.3)) {
        const { rows } = await database.query<{ id: string }>(
          `SELECT id FROM nodes WHERE provision_state = 'adopted' ORDER BY id`,
        );
        const target = rows.length ? rows[rng.int(rows.length)]!.id : undefined;
        if (target) {
          workloadLog.push(`${Math.round((now - chaosStart) / 1000)}:command`);
          bump(counts.workload, 'command');
          try {
            const command = await api(() =>
              compute.api.commands.run(root, {
                tenantId: tenants.root.id,
                nodeId: target,
                kind: 'inventory.refresh',
                payload: { sections: ['gpus'] },
                idempotencyKey: `nightly-cmd-${key++}`,
              }),
            );
            commandAt.set(command.id, now);
          } catch {
            bump(counts.workload, 'command-refused');
          }
        }
      }
      // Chaos beyond the simulator's own: gateway processes die and come back, workers go down.
      if (profile) {
        const factor = config.chaos === 'heavy' ? 2 : 1;
        for (const [index, until] of downGateways)
          if (now >= until) {
            rig.reviveGateway(index);
            downGateways.delete(index);
          }
        if (
          config.gateways > 1 &&
          downGateways.size < config.gateways - 1 &&
          rng.chance(0.02 * factor)
        ) {
          const index = rng.int(config.gateways);
          if (!downGateways.has(index)) {
            rig.killGateway(index);
            downGateways.set(index, now + rng.range(30_000, 120_000));
            bump(counts.chaos, 'gateway-kill');
          }
        }
        if (workersBackAt !== undefined && now >= workersBackAt) {
          rig.pauseWorkers(false);
          workersBackAt = undefined;
        }
        // A node's certificate is revoked (at most one per night: it never comes back without re-joining).
        const revokeDraw = rng.next();
        if (config.chaos === 'heavy' && !revokedNode && revokeDraw < 0.01) {
          revokedNode = rig.nodes[rng.int(rig.nodes.length)]!.nodeId;
          await rig.revokeNode(revokedNode, 'nightly revocation').catch(() => undefined);
          bump(counts.chaos, 'revocation');
        }
        if (workersBackAt === undefined && rng.chance(0.01 * factor)) {
          rig.pauseWorkers(true);
          workersBackAt = now + rng.range(20_000, 90_000);
          bump(counts.chaos, 'worker-outage');
        }
        // The simulator's link and daemon faults, drawn here so they follow this run's seed.
        const nodeIds = rig.nodes.map((node) => node.nodeId);
        const victim = nodeIds[rng.int(nodeIds.length)]!;
        const fault = rng.next();
        const p = profile;
        if (fault < (p.crash ?? 0) / 4) {
          sim.crash(victim, rng.range(1_000, 10_000));
          bump(counts.chaos, 'crash');
        } else if (fault < ((p.crash ?? 0) + (p.partition ?? 0)) / 4) {
          sim.partition(victim, rng.range(2_000, 30_000));
          bump(counts.chaos, 'partition');
        } else if (fault < ((p.crash ?? 0) + (p.partition ?? 0) + (p.reset ?? 0)) / 4) {
          sim.resetLink(victim);
          bump(counts.chaos, 'reset');
        } else if (
          fault <
          ((p.crash ?? 0) + (p.partition ?? 0) + (p.reset ?? 0) + (p.halfOpen ?? 0)) / 4
        ) {
          sim.halfOpen(victim, rng.chance(0.5) ? 'agent' : 'gateway');
          bump(counts.chaos, 'half-open');
        } else if (
          fault <
          ((p.crash ?? 0) +
            (p.partition ?? 0) +
            (p.reset ?? 0) +
            (p.halfOpen ?? 0) +
            (p.reboot ?? 0)) /
            4
        ) {
          sim.reboot(victim, { durationMs: rng.range(10_000, 60_000) });
          bump(counts.chaos, 'reboot');
        } else if (
          fault <
          ((p.crash ?? 0) +
            (p.partition ?? 0) +
            (p.reset ?? 0) +
            (p.halfOpen ?? 0) +
            (p.reboot ?? 0) +
            (p.journalLoss ?? 0)) /
            4
        ) {
          sim.loseJournal(victim, rng.range(2_000, 10_000));
          bump(counts.chaos, 'journal-loss');
        }
      }
      // Early releases that are due.
      for (const [id, at] of releaseAt)
        if (now >= at) {
          releaseAt.delete(id);
          await api(() =>
            compute.api.reservations.release(acme, {
              tenantId: tenants.acme.id,
              reservationId: id,
            } as never),
          ).catch(() => bump(counts.workload, 'release-refused'));
        }
      await rig.run(config.stepMs);
      // Latencies in simulated time, observed at step granularity.
      const after = sim.scheduler.now();
      const open = [...placedAt.keys()];
      if (open.length) {
        const { rows } = await database.query<{ id: string; state: string }>(
          'SELECT id, state FROM reservations WHERE id = ANY($1::text[])',
          [open],
        );
        for (const row of rows)
          if (row.state === 'active' || row.state === 'released' || row.state === 'ended') {
            activeAfter.push(after - placedAt.get(row.id)!);
            placedAt.delete(row.id);
          }
      }
      const waiting = [...commandAt.keys()];
      if (waiting.length) {
        const { rows } = await database.query<{ id: string; state: string }>(
          `SELECT id, state FROM commands WHERE id = ANY($1::text[])
             AND state IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled')`,
          [waiting],
        );
        for (const row of rows) {
          commandAfter.push(after - commandAt.get(row.id)!);
          commandAt.delete(row.id);
        }
      }
    }

    // Quiet down: every fault healed, gateways and workers back; metering covers every release.
    for (const index of downGateways.keys()) rig.reviveGateway(index);
    rig.pauseWorkers(false);
    sim.quiesce();
    await rig.run(5 * MIN);
    // Let every booking end (calendar ones start later) and one more metering pass (every 5 min) cover it, so
    // I8 compares whole bookings with their usage.
    const { rows: open } = await database.query<{ last_ms: number | null }>(
      `SELECT max(extract(epoch FROM upper(during)) * 1000) AS last_ms FROM allocations
        WHERE released_at IS NULL AND NOT upper_inf(during)`,
    );
    const lastEnd = Number(open[0]?.last_ms ?? 0);
    const tail = Math.min(Math.max(0, lastEnd - sim.scheduler.now()) + 6 * MIN, 60 * MIN);
    await rig.run(tail);
    // Releases can still happen in the tail (lapses, failed binds): make sure a metering pass ran after the last.
    for (let pass = 0; pass < 4; pass++) {
      const { rows: closed } = await database.query<{ last_ms: number | null }>(
        `SELECT max(extract(epoch FROM LEAST(COALESCE(released_at, upper(during)), upper(during))) * 1000) AS last_ms
           FROM allocations WHERE LEAST(COALESCE(released_at, upper(during)), upper(during)) <= compute_now()`,
      );
      const since = sim.scheduler.now() - Number(closed[0]?.last_ms ?? 0);
      if (since >= 5.5 * MIN) break;
      await rig.run(5.5 * MIN - since);
    }
    const violations = await rig.invariants();
    const tally = async (table: 'reservations' | 'commands') => {
      const { rows } = await database.query<{ state: string; count: number }>(
        `SELECT state, count(*)::int AS count FROM ${table} GROUP BY state ORDER BY state`,
      );
      return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
    };
    const reservations = await tally('reservations');
    const commands = await tally('commands');
    const sha = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const workload = Object.fromEntries([...counts.workload].sort());
    const chaos = Object.fromEntries([...counts.chaos].sort());
    return {
      seed: config.seed,
      config,
      wallMs: Date.now() - wallStart,
      workloadDigest: sha(workloadLog),
      outcomeDigest: sha({
        reservations,
        commands,
        workload,
        chaos,
        violations: violations.map((v) => v.invariant),
      }),
      workload,
      reservations,
      commands,
      chaos,
      placeToActiveMs: summarize(activeAfter),
      commandMs: summarize(commandAfter),
      violations,
      ok: violations.length === 0,
    };
  } finally {
    await rig.close();
  }
}
