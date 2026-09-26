import { recordHostPressure, recordXid, upsertNodeConditions, wakeStartedReservations } from '@better-compute/inventory';
import { ConditionStatus, type StatusReport } from '@better-compute/protocol';
import type { EventPublisher, SqlTx } from '@better-compute/core';
import type { StatusHandler } from './store.js';

const xidType = /^Xid(\d{1,5})$/;

/**
 * Node conditions bcd reports while their concern is broken (hostconfig Reporter, the kube manager,
 * the devices converger): each is the node's condition exactly as the last status says, true while
 * reported and false once it is not, and NoSchedule while true when `noSchedule`. On a
 * tenant-controlled node they are advisory (its lessee has root) and change no NoSchedule reason.
 * `wakesReservations`: a change wakes the started reservations on the node, so their conditions
 * (Degraded) follow it at once.
 */
export const daemonNodeConditions: Readonly<Record<string, { noSchedule: boolean; wakesReservations?: boolean }>> = Object.freeze({
  // An NVSwitch system without Fabric Manager: NVLink is down and multi-GPU jobs fail.
  FabricManagerDown: { noSchedule: true },
  // An mps pool's MPS control daemon is down: every client fails.
  MPSDown: { noSchedule: true },
  // A host config unit takes effect only after a reboot (bcd never reboots on its own): reboot the
  // node within the disruption budget (node.reboot). Not a fault; the node keeps running.
  RebootRequired: { noSchedule: false },
  // bcd's Kubernetes node side (kube manager). ForeignGpuExposure: another path (the GPU operator's device plugin,
  // NVIDIA_VISIBLE_DEVICES) gives pods this node's GPUs, so a hold booked here is not isolated from them: NoSchedule,
  // and the node's live reservations are woken to show it (security review 2, MED 4).
  ForeignGpuExposure: { noSchedule: true, wakesReservations: true },
  // The kubelet's pod-resources API is unreachable: bcd cannot tell which pods hold which devices, so it can neither
  // admit a Kubernetes binding safely nor see a release through. NoSchedule for the whole node (placement has no
  // per-binding NoSchedule; a node that cannot bind Kubernetes work safely is not offered for any).
  PodResourcesUnavailable: { noSchedule: true },
  // A released Kubernetes allocation whose devices a pod still holds after 5 minutes (bcd keeps them claimed and
  // the release unreported, so the GPUs stay booked): the kube reaper could not evict, and the GPUs may still be in
  // use. NoSchedule until it clears: an operator looks at the node before it takes more work.
  KubernetesReleaseStuck: { noSchedule: true },
  // The spec dropped k8s-join and bcd cordoned and drained the Node.
  KubernetesReleased: { noSchedule: false },
  // The pool's taints changed after the Node registered (NodeRestriction forbids the kubelet to change them): the
  // message carries the kubectl taint command a cluster admin runs.
  KubernetesTaintsDrift: { noSchedule: false },
  // Not a fault: the host section is observed only ([host] units = false; the GPU operator owns
  // the host). Operators see it on the node; capacity books from the inventory alone.
  HostManagedExternally: { noSchedule: false },
});

/** Conditions a section's state stands for (the section reports it, not a Condition). */
const sectionConditions: Readonly<Record<string, { section: string; reason: string }>> = {
  HostManagedExternally: { section: 'host', reason: 'HostManagedExternally' },
};

/** Writes the daemon-reported conditions that changed (published as `node.condition.changed`); returns their types. */
async function recordDaemonConditions(
  tx: SqlTx,
  nodeId: string,
  report: StatusReport,
  events: EventPublisher | undefined,
): Promise<string[]> {
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
  if (!changed.length) return [];
  const node = await tx.query<{ no_schedule_reasons: string[]; trust: string; owner_tenant_id: string }>(
    'SELECT no_schedule_reasons, trust, owner_tenant_id FROM nodes WHERE id = $1 FOR UPDATE',
    [nodeId],
  );
  if (!node.rows[0]) return [];
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
  return changed;
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
 * - bcd's own conditions (`daemonNodeConditions`: the host units' FabricManagerDown and MPSDown, the
 *   kube manager's ForeignGpuExposure, PodResourcesUnavailable and KubernetesReleaseStuck, and
 *   HostManagedExternally from the host section's state) follow the report, written only on a
 *   change, the faults NoSchedule while true; ForeignGpuExposure also wakes the node's started
 *   reservations.
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
  if (report.pressure)
    recorded += (
      await recordHostPressure(tx, context.nodeId, report.pressure, context.events ? { events: context.events } : {})
    ).length;
  const changed = await recordDaemonConditions(tx, context.nodeId, report, context.events);
  recorded += changed.length;
  // A quarantined GPU, or GPUs exposed to pods by another path, degrade the reservations on the node now
  // (Degraded), whether or not a `health` reconciler (provision) runs, not at capacity's periodic recheck.
  if (quarantined || changed.some((type) => daemonNodeConditions[type]!.wakesReservations))
    await wakeStartedReservations(tx, context.work, context.nodeId);
  return recorded;
};
