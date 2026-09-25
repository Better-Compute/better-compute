import type { EventPublisher, ModuleContext, SqlTx } from '@better-compute/core';
import { InstanceObservedState, type StatusReport } from '@better-compute/protocol';
import { reportInstances, type InstanceReport } from './lifecycle.js';

/** What the gateway passes a `reports.status` handler (a structural subset of its ReportContext). */
export interface InstanceStatusContext {
  nodeId: string;
  tenantId: string;
  work: ModuleContext['work'];
}

export interface InstanceStatusHandlerOptions {
  /** Publishes `instance.orphaned` for instances the runtime holds that no live row places there. */
  events?: EventPublisher;
  /** Where orphans go without `events` (default `console.warn`). */
  log?: (message: string) => void;
}

const observed: Partial<Record<InstanceObservedState, InstanceReport['state']>> = {
  [InstanceObservedState.RUNNING]: 'running',
  [InstanceObservedState.STOPPED]: 'stopped',
  [InstanceObservedState.PAUSED]: 'paused',
  [InstanceObservedState.ERROR]: 'error',
};

/** The instance reports of one StatusReport; UNSPECIFIED (and unknown) states are skipped. */
export function instanceReportsOf(report: Pick<StatusReport, 'instances'>): InstanceReport[] {
  const reports: InstanceReport[] = [];
  for (const instance of report.instances ?? []) {
    const state = observed[instance.state];
    if (!state || !instance.instanceId) continue;
    reports.push({
      id: instance.instanceId,
      state,
      ...(instance.addresses.length ? { addresses: [...instance.addresses] } : {}),
      ...(instance.message ? { message: instance.message.slice(0, 512) } : {}),
      ...(instance.identityReboundRef
        ? { identityReboundRef: instance.identityReboundRef.slice(0, 512) }
        : {}),
    });
  }
  return reports;
}

/**
 * `reports.status` for hosted VPS (§11.1, v0.3): feeds `StatusReport.instances` into
 * `reportInstances` (with `instancesComplete` → `complete`), inside the gateway's ingest transaction.
 * Orphans (leaks) are published as `instance.orphaned` when a node's orphan set changes (kept in
 * memory, so a restart announces current leaks once more). The event is published in the ingest
 * transaction; if that rolls back, the next report announces again only after the set changes.
 *
 * ```ts
 * createGateway({ reports: { ...gatewayReportHandlers, status: [xidStatusHandler, instanceStatusHandler({ events })] } })
 * ```
 */
export function instanceStatusHandler(options: InstanceStatusHandlerOptions = {}) {
  const log = options.log ?? ((message: string) => console.warn(message));
  // The last orphan set announced per node: reports repeat about once a second, leaks persist.
  const announced = new Map<string, string>();
  return async function vpsInstanceStatus(
    tx: SqlTx,
    context: InstanceStatusContext,
    report: Pick<StatusReport, 'instances' | 'instancesComplete'>,
  ): Promise<{ updated: number; orphans: string[] }> {
    const reports = instanceReportsOf(report);
    // An empty, incomplete report says nothing; an empty complete one means the runtime holds nothing.
    if (reports.length === 0 && !report.instancesComplete) return { updated: 0, orphans: [] };
    const result = await reportInstances(tx, context.work, context.nodeId, reports, {
      complete: report.instancesComplete,
    });
    const key = result.orphans.join('\u0000');
    if (key === (announced.get(context.nodeId) ?? '')) return result;
    if (result.orphans.length > 0) {
      if (options.events)
        await options.events.publish(tx, {
          type: 'instance.orphaned',
          tenantId: context.tenantId,
          subject: `node/${context.nodeId}`,
          data: { nodeId: context.nodeId, instanceIds: result.orphans.slice(0, 100) },
        });
      else
        log(
          `vps: node ${context.nodeId} runs ${result.orphans.length} instance(s) no live row places there: ${result.orphans.slice(0, 20).join(', ')}`,
        );
    }
    if (key) announced.set(context.nodeId, key);
    else announced.delete(context.nodeId);
    return result;
  };
}

/** `instanceStatusHandler()` without an event publisher: orphans are logged. */
export const vpsInstanceStatusHandler = instanceStatusHandler();
