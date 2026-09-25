import {
  markAllocationBound,
  markAllocationFailed,
  markAllocationReleased,
} from '@better-compute/capacity';
import type { SqlTx, WorkQueue } from '@better-compute/core';
import type {
  AllocationBound,
  AllocationFailed,
  AllocationReleased,
} from '@better-compute/protocol';

// The node reports a gateway hands back to the control plane (PLAN.md §3.4 step 9, §10.5): the
// capacity module's allocation transitions, shaped as `createGateway({ reports })` takes them
// (the gateway imports no domain module). Each runs in the gateway's ingest transaction.

/** What the gateway passes each report handler (a subset of its `ReportContext`). */
export interface GatewayReportContext {
  nodeId: string;
  work: WorkQueue;
}

/** `createGateway({ reports })` for the built-in capacity module. */
export interface GatewayReportHandlers {
  allocationBound(
    tx: SqlTx,
    context: GatewayReportContext,
    report: AllocationBound,
  ): Promise<boolean>;
  allocationReleased(
    tx: SqlTx,
    context: GatewayReportContext,
    report: AllocationReleased,
  ): Promise<boolean>;
  allocationFailed(
    tx: SqlTx,
    context: GatewayReportContext,
    report: AllocationFailed,
  ): Promise<boolean>;
}

/**
 * AllocationBound → the binding (`cdiDevices`, `envFile`) and the reservation's wake-up;
 * AllocationReleased → a lost binding (billing keeps the reserved time); AllocationFailed → the
 * reservation re-places or fails.
 *
 * ```ts
 * createGateway({ services: compute.gatewayServices, work: compute.context.work,
 *   events: compute.context.events, reports: gatewayReportHandlers, … });
 * ```
 */
export const gatewayReportHandlers: GatewayReportHandlers = Object.freeze({
  allocationBound: async (tx: SqlTx, context: GatewayReportContext, report: AllocationBound) =>
    (await onReportingNode(tx, context, report.allocationId)) &&
    markAllocationBound(tx, context.work, report.allocationId, {
      cdiDevices: report.cdiDevices,
      ...(report.envFile ? { envFile: report.envFile } : {}),
    }),
  allocationReleased: async (
    tx: SqlTx,
    context: GatewayReportContext,
    report: AllocationReleased,
  ) =>
    (await onReportingNode(tx, context, report.allocationId)) &&
    markAllocationReleased(tx, context.work, report.allocationId),
  allocationFailed: async (tx: SqlTx, context: GatewayReportContext, report: AllocationFailed) =>
    (await onReportingNode(tx, context, report.allocationId)) &&
    markAllocationFailed(tx, context.work, report.allocationId, {
      reason: report.reason || 'failed',
    }),
});

/**
 * A node reports only its own allocations: node A's session can neither bind, release nor fail
 * an allocation placed on node B (the report is ignored, as an unknown allocation is).
 */
async function onReportingNode(
  tx: SqlTx,
  context: GatewayReportContext,
  allocationId: string,
): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM allocations WHERE id = $1 AND node_id = $2', [
    allocationId,
    context.nodeId,
  ]);
  return rows.length > 0;
}
