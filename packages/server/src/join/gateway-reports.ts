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
  allocationBound: (tx: SqlTx, context: GatewayReportContext, report: AllocationBound) =>
    markAllocationBound(tx, context.work, report.allocationId, {
      cdiDevices: report.cdiDevices,
      ...(report.envFile ? { envFile: report.envFile } : {}),
    }),
  allocationReleased: (tx: SqlTx, context: GatewayReportContext, report: AllocationReleased) =>
    markAllocationReleased(tx, context.work, report.allocationId),
  allocationFailed: (tx: SqlTx, context: GatewayReportContext, report: AllocationFailed) =>
    markAllocationFailed(tx, context.work, report.allocationId, {
      reason: report.reason || 'failed',
    }),
});
