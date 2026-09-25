import { recordHostPressure, recordXid } from '@better-compute/inventory';
import { ConditionStatus } from '@better-compute/protocol';
import type { StatusHandler } from './store.js';

const xidType = /^Xid(\d{1,5})$/;

/**
 * `reports.status` for §10.1 health:
 * - every active `Xid<n>` condition the daemon reports on a device goes through inventory's
 *   `recordXid` (condition, GPU quarantine, NoSchedule for node-level faults), and the node is
 *   queued for the `health` reconciler. `recordXid` is idempotent, so a condition repeated in later
 *   reports changes nothing;
 * - the report's host pressure (`StatusReport.pressure`) goes through inventory's
 *   `recordHostPressure` (Disk/Memory/CpuPressure conditions, written only on a change, NoSchedule on
 *   vps-host pools, `node.condition.changed` events).
 *
 * ```ts
 * createGateway({ reports: { ...gatewayReportHandlers, status: xidStatusHandler } })
 * ```
 */
export const xidStatusHandler: StatusHandler = async function xidStatusHandler(tx, context, report) {
  let recorded = 0;
  for (const condition of report.conditions) {
    const match = xidType.exec(condition.type);
    if (!match || condition.status !== ConditionStatus.TRUE || !condition.deviceId) continue;
    const outcome = await recordXid(tx, context.nodeId, {
      gpuUuid: condition.deviceId,
      xid: Number(match[1]),
      ...(condition.message ? { message: condition.message.slice(0, 512) } : {}),
    });
    if (outcome.policy) recorded++;
  }
  if (recorded) await context.work.enqueue(tx, 'health', context.nodeId);
  if (report.pressure)
    recorded += (
      await recordHostPressure(tx, context.nodeId, report.pressure, context.events ? { events: context.events } : {})
    ).length;
  return recorded;
};
