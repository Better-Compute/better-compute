import type { EventPublisher, SqlTx } from '@better-compute/core';
import { upsertNodeConditions } from './health.js';
import { mergeNoScheduleReasons } from './labels.js';

// Host pressure (PLAN.md §10.1 v0.3 row): `StatusReport.pressure` carries Linux PSI ("some" avg10)
// and CPU steal. Sustained pressure raises `CpuPressure`, `MemoryPressure` or `DiskPressure`; on
// VPS hosts (pool class `vps-host`) they are NoSchedule, elsewhere they only alert. A condition
// clears once its value falls below half its threshold (hysteresis), so a host hovering at the
// threshold does not flap. Nothing is written while nothing changes.

export const pressureConditions = ['CpuPressure', 'MemoryPressure', 'DiskPressure'] as const;
export type PressureCondition = (typeof pressureConditions)[number];

/** A `HostPressure` report (percent of wall time; steal in percent of the report interval). */
export interface HostPressureReport {
  cpuSomeAvg10: number;
  memorySomeAvg10: number;
  ioSomeAvg10: number;
  stealPct: number;
}

/** Raise thresholds, in percent. */
export interface PressureThresholds {
  cpu: number;
  /** CPU steal also raises CpuPressure (a noisy neighbour on the hypervisor). */
  steal: number;
  memory: number;
  io: number;
}

export const defaultPressureThresholds: Readonly<PressureThresholds> = Object.freeze({ cpu: 50, steal: 20, memory: 20, io: 40 });

/** The pool classes whose nodes a pressure condition takes out of scheduling. */
export const pressureNoScheduleClasses: readonly string[] = Object.freeze(['vps-host']);

/**
 * The pressure conditions a report implies, given which are raised now: a condition goes true at
 * its threshold and false below half of it; in between it keeps its current status.
 */
export function evaluatePressure(
  report: HostPressureReport,
  raised: ReadonlySet<PressureCondition>,
  thresholds: PressureThresholds = defaultPressureThresholds,
): Map<PressureCondition, { status: boolean; reason: string }> {
  const levels: [PressureCondition, [number, number][], string][] = [
    ['CpuPressure', [[report.cpuSomeAvg10, thresholds.cpu], [report.stealPct, thresholds.steal]], `cpu ${fmt(report.cpuSomeAvg10)}%, steal ${fmt(report.stealPct)}%`],
    ['MemoryPressure', [[report.memorySomeAvg10, thresholds.memory]], `memory ${fmt(report.memorySomeAvg10)}%`],
    ['DiskPressure', [[report.ioSomeAvg10, thresholds.io]], `io ${fmt(report.ioSomeAvg10)}%`],
  ];
  const out = new Map<PressureCondition, { status: boolean; reason: string }>();
  for (const [type, pairs, reason] of levels) {
    const over = pairs.some(([value, threshold]) => value >= threshold);
    const under = pairs.every(([value, threshold]) => value < threshold / 2);
    out.set(type, { status: over || (raised.has(type) && !under), reason });
  }
  return out;
}
const fmt = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);

/**
 * Applies one pressure report for a node in the caller's transaction: changed conditions are
 * written (and published as `node.condition.changed`), and on NoSchedule pool classes mirrored into
 * `no_schedule_reasons` under the node row lock. Returns the conditions that changed.
 */
export async function recordHostPressure(
  tx: SqlTx,
  nodeId: string,
  report: HostPressureReport,
  options: { thresholds?: PressureThresholds; events?: EventPublisher } = {},
): Promise<{ type: PressureCondition; status: boolean }[]> {
  const { rows: current } = await tx.query<{ type: PressureCondition; status: string }>(
    `SELECT type, status FROM node_conditions WHERE node_id = $1 AND type = ANY($2::text[])`,
    [nodeId, [...pressureConditions]],
  );
  const raised = new Set(current.filter((row) => row.status === 'true').map((row) => row.type));
  const next = evaluatePressure(report, raised, options.thresholds ?? defaultPressureThresholds);
  const changed = [...next].filter(([type, value]) => value.status !== raised.has(type) && (value.status || current.some((row) => row.type === type)));
  if (changed.length === 0) return [];
  const { rows: nodes } = await tx.query<{ no_schedule_reasons: string[]; owner_tenant_id: string; class: string | null; trust: string }>(
    `SELECT n.no_schedule_reasons, n.owner_tenant_id, p.class, n.trust FROM nodes n LEFT JOIN pools p ON p.id = n.pool_id
      WHERE n.id = $1 FOR UPDATE OF n`,
    [nodeId],
  );
  const node = nodes[0];
  // A tenant-controlled node (dedicated-root lease) reports what its lessee wants: advisory, like its
  // inventory (§10.1 Trust), so it never makes a pool NoSchedule.
  if (!node || node.trust === 'tenant-controlled') return [];
  await upsertNodeConditions(
    tx,
    nodeId,
    changed.map(([type, value]) => ({ type, status: value.status ? 'true' : 'false', reason: value.status ? value.reason : null })),
  );
  const noSchedule = pressureNoScheduleClasses.includes(node.class ?? '');
  const reasons = mergeNoScheduleReasons(
    node.no_schedule_reasons,
    pressureConditions,
    [...next].map(([type, value]) => ({ type, status: value.status ? 'true' : 'false', noSchedule: noSchedule && value.status })),
  );
  if (JSON.stringify(reasons) !== JSON.stringify([...node.no_schedule_reasons].sort()))
    await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1', [nodeId, reasons]);
  const events = changed.map(([type, value]) => ({
    type: 'node.condition.changed',
    tenantId: node.owner_tenant_id,
    subject: `node/${nodeId}`,
    data: { condition: type, status: value.status ? 'true' : 'false', reason: value.reason, noSchedule: noSchedule && value.status },
  }));
  if (options.events?.publishMany) await options.events.publishMany(tx, events);
  else for (const event of events) await options.events?.publish(tx, event);
  return changed.map(([type, value]) => ({ type, status: value.status }));
}

/**
 * A gateway `reports.status` handler (structurally typed, so inventory needs no gateway import):
 * `createGateway({ reports: { status: [xidStatusHandler, hostPressureStatusHandler({ events })] } })`.
 */
export function hostPressureStatusHandler(options: { thresholds?: PressureThresholds; events?: EventPublisher } = {}) {
  return async function hostPressureStatusHandler(
    tx: SqlTx,
    context: { nodeId: string },
    report: { pressure?: HostPressureReport | undefined },
  ): Promise<number> {
    if (!report.pressure) return 0;
    return (await recordHostPressure(tx, context.nodeId, report.pressure, options)).length;
  };
}
