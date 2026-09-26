import { recordHostPressure, recordXid, upsertNodeConditions, wakeStartedReservations } from '@better-compute/inventory';
import { ConditionStatus, type StatusReport } from '@better-compute/protocol';
import type { EventPublisher, SqlTx } from '@better-compute/core';
import type { StatusHandler } from './store.js';

const xidType = /^Xid(\d{1,5})$/;

/**
 * Node conditions bcd's host config units report while their concern is broken (hostconfig
 * Reporter): each is the node's condition exactly as the last status says, true while reported and
 * false once it is not, and NoSchedule while true. On a tenant-controlled node they are advisory
 * (its lessee has root) and change no NoSchedule reason.
 */
export const daemonNodeConditions: Readonly<Record<string, { noSchedule: boolean }>> = Object.freeze({
  // An NVSwitch system without Fabric Manager: NVLink is down and multi-GPU jobs fail.
  FabricManagerDown: { noSchedule: true },
  // An mps pool's MPS control daemon is down: every client fails.
  MPSDown: { noSchedule: true },
  // A host config unit takes effect only after a reboot (bcd never reboots on its own): reboot the
  // node within the disruption budget (node.reboot). Not a fault; the node keeps running.
  RebootRequired: { noSchedule: false },
  // Not a fault: the host section is observed only ([host] units = false; the GPU operator owns
  // the host). Operators see it on the node; capacity books from the inventory alone.
  HostManagedExternally: { noSchedule: false },
});

/** Conditions a section's state stands for (the section reports it, not a Condition). */
const sectionConditions: Readonly<Record<string, { section: string; reason: string }>> = {
  HostManagedExternally: { section: 'host', reason: 'HostManagedExternally' },
};

/** Writes the daemon-reported conditions that changed (published as `node.condition.changed`). */
async function recordDaemonConditions(
  tx: SqlTx,
  nodeId: string,
  report: StatusReport,
  events: EventPublisher | undefined,
): Promise<number> {
  const types = Object.keys(daemonNodeConditions);
  const reported = new Map<string, string>();
  for (const condition of report.conditions)
    if (condition.status === ConditionStatus.TRUE && types.includes(condition.type) && !sectionConditions[condition.type])
      reported.set(condition.type, (condition.reason || condition.message).slice(0, 512));
  for (const [type, { section, reason }] of Object.entries(sectionConditions)) {
    const state = report.sections.find((s) => s.section === section);
    if (state?.reason === reason) reported.set(type, state.message.slice(0, 512) || reason);
  }
  const { rows } = await tx.query<{ type: string; status: string }>(
    `SELECT type, status FROM node_conditions WHERE node_id = $1 AND type = ANY($2)`,
    [nodeId, types],
  );
  const current = new Map(rows.map((row) => [row.type, row.status]));
  // Absent and false are the same until a condition was first reported.
  const changed = types.filter((type) =>
    reported.has(type) ? current.get(type) !== 'true' : current.get(type) === 'true',
  );
  if (!changed.length) return 0;
  const node = await tx.query<{ no_schedule_reasons: string[]; trust: string; owner_tenant_id: string }>(
    'SELECT no_schedule_reasons, trust, owner_tenant_id FROM nodes WHERE id = $1 FOR UPDATE',
    [nodeId],
  );
  if (!node.rows[0]) return 0;
  await upsertNodeConditions(
    tx,
    nodeId,
    changed.map((type) => ({ type, status: reported.has(type) ? 'true' : 'false', reason: reported.get(type) ?? null })),
  );
  const advisory = node.rows[0].trust === 'tenant-controlled';
  const published = changed.map((type) => ({
    type: 'node.condition.changed',
    tenantId: node.rows[0]!.owner_tenant_id,
    subject: `node/${nodeId}`,
    data: {
      condition: type,
      status: reported.has(type) ? 'true' : 'false',
      reason: reported.get(type) ?? null,
      noSchedule: !advisory && reported.has(type) && daemonNodeConditions[type]!.noSchedule,
    },
  }));
  if (events?.publishMany) await events.publishMany(tx, published);
  else for (const event of published) await events?.publish(tx, event);
  if (!advisory) {
    const before = node.rows[0].no_schedule_reasons;
    const reasons = new Set(before);
    for (const type of changed)
      if (daemonNodeConditions[type]!.noSchedule)
        if (reported.has(type)) reasons.add(type);
        else reasons.delete(type);
    const next = [...reasons].sort();
    if (next.join('\0') !== [...before].sort().join('\0'))
      await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1', [nodeId, next]);
  }
  return changed.length;
}

/**
 * `reports.status` for §10.1 health:
 * - every active `Xid<n>` condition the daemon reports on a device goes through inventory's
 *   `recordXid` (condition, GPU quarantine, NoSchedule for node-level faults), and the node is
 *   queued for the `health` reconciler. `recordXid` is idempotent, so a condition repeated in later
 *   reports changes nothing;
 * - the report's host pressure (`StatusReport.pressure`) goes through inventory's
 *   `recordHostPressure` (Disk/Memory/CpuPressure conditions, written only on a change, NoSchedule on
 *   vps-host pools, `node.condition.changed` events);
 * - the host config units' conditions (`daemonNodeConditions`: FabricManagerDown, MPSDown, and
 *   HostManagedExternally from the host section's state) follow the report, written only on a
 *   change, the faults NoSchedule while true.
 *
 * ```ts
 * createGateway({ reports: { ...gatewayReportHandlers, status: xidStatusHandler } })
 * ```
 */
export const xidStatusHandler: StatusHandler = async function xidStatusHandler(tx, context, report) {
  let recorded = 0;
  let quarantined = false;
  for (const condition of report.conditions) {
    const match = xidType.exec(condition.type);
    if (!match || condition.status !== ConditionStatus.TRUE || !condition.deviceId) continue;
    const outcome = await recordXid(tx, context.nodeId, {
      gpuUuid: condition.deviceId,
      xid: Number(match[1]),
      ...(condition.message ? { message: condition.message.slice(0, 512) } : {}),
    });
    if (outcome.policy) recorded++;
    quarantined ||= outcome.quarantined;
  }
  if (recorded) await context.work.enqueue(tx, 'health', context.nodeId);
  // A quarantined GPU degrades the reservations holding it now (Degraded / AtomUnhealthy), whether or not
  // a `health` reconciler (provision) runs, not at capacity's periodic recheck.
  if (quarantined) await wakeStartedReservations(tx, context.work, context.nodeId);
  if (report.pressure)
    recorded += (
      await recordHostPressure(tx, context.nodeId, report.pressure, context.events ? { events: context.events } : {})
    ).length;
  recorded += await recordDaemonConditions(tx, context.nodeId, report, context.events);
  return recorded;
};
