import type { Migration } from '@better-compute/core';
import type { ControlPlaneSim } from './control-plane.js';

// An in-place upgrade under load (PLAN.md §7.6 order, §16 v1.0 "upgrading from v0.5 disturbs no
// running allocation"): expand migrations → workers/api → gateways → daemons, on a running
// control-plane simulation. `upgradeInPlace` runs the steps and reports every allocation the
// upgrade disturbed (released, rebound to other atoms or another node, or its reservation no longer
// active); the caller checks the invariants (I1, I2, I5, I8) afterwards.

/** What an allocation looks like to its tenant. */
export interface AllocationState {
  id: string;
  reservationId: string;
  nodeId: string;
  atoms: readonly string[];
  boundAt: number | null;
  releasedAt: number | null;
  reservationState: string;
}

/** Every reservation allocation, by id. */
export async function allocationStates(rig: Pick<ControlPlaneSim, 'database'>): Promise<Map<string, AllocationState>> {
  const { rows } = await rig.database.query<{
    id: string;
    owner_id: string;
    node_id: string;
    atoms: string[];
    bound_at: Date | null;
    released_at: Date | null;
    state: string;
  }>(
    `SELECT a.id, a.owner_id, a.node_id, a.atoms, a.bound_at, a.released_at, r.state
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
      ORDER BY a.id`,
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        reservationId: row.owner_id,
        nodeId: row.node_id,
        atoms: [...row.atoms].sort(),
        boundAt: row.bound_at ? row.bound_at.getTime() : null,
        releasedAt: row.released_at ? row.released_at.getTime() : null,
        reservationState: row.state,
      },
    ]),
  );
}

/**
 * How `after` disturbed the allocations that were running in `before` (bound, not released): one
 * line per disturbance, empty when none.
 */
export function disturbances(before: ReadonlyMap<string, AllocationState>, after: ReadonlyMap<string, AllocationState>): string[] {
  const out: string[] = [];
  for (const old of before.values()) {
    if (old.boundAt === null || old.releasedAt !== null) continue;
    const now = after.get(old.id);
    if (!now) {
      out.push(`${old.id}: gone`);
      continue;
    }
    if (now.releasedAt !== null) out.push(`${old.id}: released`);
    if (now.nodeId !== old.nodeId) out.push(`${old.id}: moved from ${old.nodeId} to ${now.nodeId}`);
    if (now.atoms.join() !== old.atoms.join()) out.push(`${old.id}: rebound to other atoms`);
    if (now.boundAt !== old.boundAt) out.push(`${old.id}: bound again`);
    if (now.reservationState !== old.reservationState) out.push(`${old.id}: reservation ${old.reservationState} → ${now.reservationState}`);
  }
  return out;
}

export type UpgradeStepName = 'migrations' | 'workers' | 'gateways' | 'daemons';

export interface UpgradeOptions {
  /** The new release's expand migrations (additive), applied while everything runs. */
  migrations: readonly Migration[];
  /** How long every worker/api process is down while it restarts on the new build (default 30 s). */
  workerRestartMs?: number;
  /** Each gateway's downtime during its roll, and the settle time before the next (default 20 s, 40 s). */
  gatewayDownMs?: number;
  gatewaySettleMs?: number;
  /** Rolls the daemons to the new build (e.g. through a Rollout); resolves once every daemon runs it. */
  rollDaemons(rig: ControlPlaneSim): Promise<void>;
  /** Simulated time after the last step, before the report (default 2 min). */
  settleMs?: number;
}

export interface UpgradeReport {
  /** Each step with its simulated start and end. */
  steps: { name: UpgradeStepName; startedAt: number; endedAt: number }[];
  /** Migrations the expand step applied. */
  applied: string[];
  before: Map<string, AllocationState>;
  after: Map<string, AllocationState>;
  /** What the upgrade disturbed (`disturbances(before, after)`): must be empty. */
  disturbed: string[];
}

/** Runs the §7.6 upgrade order on `rig` and reports what it disturbed. */
export async function upgradeInPlace(rig: ControlPlaneSim, options: UpgradeOptions): Promise<UpgradeReport> {
  const now = () => rig.sim.scheduler.now();
  const steps: UpgradeReport['steps'] = [];
  const step = async (name: UpgradeStepName, fn: () => Promise<void>) => {
    const startedAt = now();
    await fn();
    steps.push({ name, startedAt, endedAt: now() });
  };
  const before = await allocationStates(rig);
  let applied: string[] = [];

  await step('migrations', async () => {
    applied = (await rig.database.migrate(options.migrations)).applied;
    await rig.run(30_000);
  });
  await step('workers', async () => {
    rig.pauseWorkers(true);
    await rig.run(options.workerRestartMs ?? 30_000);
    rig.pauseWorkers(false);
    await rig.run(30_000);
  });
  await step('gateways', async () => {
    for (let index = 0; index < rig.gateways.length; index++) {
      rig.killGateway(index);
      await rig.run(options.gatewayDownMs ?? 20_000);
      rig.reviveGateway(index);
      await rig.run(options.gatewaySettleMs ?? 40_000);
    }
  });
  await step('daemons', () => options.rollDaemons(rig));
  await rig.run(options.settleMs ?? 2 * 60_000);

  const after = await allocationStates(rig);
  return { steps, applied, before, after, disturbed: disturbances(before, after) };
}
