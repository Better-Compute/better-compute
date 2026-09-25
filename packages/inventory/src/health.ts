import type { SqlTx } from '@better-compute/core';
import { LinkState, type GpusSection } from '@better-compute/protocol';
import type { NodeConditionType } from './conditions.js';
import { mergeNoScheduleReasons } from './labels.js';

// Health (PLAN.md §10.1, v0.2): XID events and the health counters inventory carries become
// conditions, device quarantines (`device_health`: the atom leaves placement, the node does not)
// and, for node-level faults, a NoSchedule reason plus a remediation the health reconciler runs
// within the pool's disruption budget.

/**
 * The work kind (and reconciler name) of remediation, keyed by node id. Inventory and XID ingest
 * queue it when a node-level fault appears; the provision module's health reconciler runs it.
 */
export const healthWorkKind = 'health';

/** What a fault asks for. */
export type HealthAction =
  /** Take the one GPU out of placement (`healthy = false`). */
  | 'quarantine-gpu'
  /** NoSchedule the node, drain it, then reboot it. */
  | 'drain-reboot'
  /** NoSchedule the node, drain it, then reset the GPU. */
  | 'drain-gpu-reset'
  /** Quarantine the GPU for good: the board needs replacing. */
  | 'rma';

export interface HealthPolicy {
  condition: NodeConditionType;
  action: HealthAction;
  /** Blocks the whole node (NoSchedule); otherwise only the device leaves placement. */
  noSchedule: boolean;
  description: string;
}

/** The XIDs §10.1 acts on. Others (13, 31, 43, 45, …: application faults) are recorded only as events. */
export const xidPolicies: Readonly<Record<number, HealthPolicy>> = Object.freeze({
  48: { condition: 'Xid48', action: 'quarantine-gpu', noSchedule: false, description: 'double-bit ECC error' },
  63: { condition: 'RowRemapPending', action: 'drain-gpu-reset', noSchedule: true, description: 'row remapping pending' },
  64: { condition: 'RowRemapFailed', action: 'rma', noSchedule: false, description: 'row remapping failed' },
  79: { condition: 'Xid79', action: 'drain-reboot', noSchedule: true, description: 'GPU has fallen off the bus' },
  95: { condition: 'Xid95', action: 'drain-reboot', noSchedule: true, description: 'uncontained ECC error' },
});

/** The policy of an XID, or undefined for XIDs that only get recorded. */
export function classifyXid(xid: number): HealthPolicy | undefined {
  return Object.hasOwn(xidPolicies, xid) ? xidPolicies[xid] : undefined;
}

/** One health finding about one GPU. */
export interface HealthFinding {
  deviceId: string;
  condition: NodeConditionType;
  action: HealthAction;
  noSchedule: boolean;
  message: string;
}

/** Condition types the inventory-derived health check owns (it sets and clears them). */
export const inventoryHealthConditions: readonly NodeConditionType[] = [
  'RowRemapPending',
  'RowRemapFailed',
  'EccUncorrectable',
  'NvlinkDegraded',
];

/**
 * Findings in a GPU section: a failed row remap (RMA), a pending one (drain and reset), volatile
 * uncorrectable ECC errors, and NVLinks that are down while the GPU has NVLink peers. Each is about
 * one GPU; the device is quarantined, and only a pending row remap blocks the node.
 */
export function inventoryHealthFindings(section: GpusSection | undefined): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const gpu of section?.gpus ?? []) {
    if (!gpu.uuid) continue;
    if (gpu.rowRemap?.failure)
      findings.push({ deviceId: gpu.uuid, condition: 'RowRemapFailed', action: 'rma', noSchedule: false, message: `${gpu.uuid}: row remapping failed` });
    else if (gpu.rowRemap?.pending)
      findings.push({
        deviceId: gpu.uuid,
        condition: 'RowRemapPending',
        action: 'drain-gpu-reset',
        noSchedule: true,
        message: `${gpu.uuid}: row remapping pending a GPU reset`,
      });
    const uncorrectable = gpu.ecc?.volatileCounts?.uncorrectable ?? 0n;
    if (uncorrectable > 0n)
      findings.push({
        deviceId: gpu.uuid,
        condition: 'EccUncorrectable',
        action: 'quarantine-gpu',
        noSchedule: false,
        message: `${gpu.uuid}: ${uncorrectable} uncorrectable ECC errors since boot`,
      });
    const down = gpu.nvlinks.filter((link) => link.state === LinkState.DOWN).length;
    if (down > 0 && gpu.nvlinks.some((link) => link.state === LinkState.UP))
      findings.push({
        deviceId: gpu.uuid,
        condition: 'NvlinkDegraded',
        action: 'quarantine-gpu',
        noSchedule: false,
        message: `${gpu.uuid}: ${down} of ${gpu.nvlinks.length} NVLinks down`,
      });
  }
  return findings;
}

/** capacity's reservation reconciler (inventory cannot import capacity, which builds on it). */
export const reservationsWorkKind = 'capacity.reservations';

/**
 * Wakes the started reservations (`binding`, `active`) with a live allocation on a node, so their
 * conditions (Degraded / AtomUnhealthy) follow a change of its atoms' health at once rather than
 * at capacity's periodic recheck. The same query as capacity's `wakeStartedOnNode`.
 */
export async function wakeStartedReservations(
  tx: SqlTx,
  work: { enqueue(tx: SqlTx, kind: string, key: string): Promise<void>; enqueueMany?(tx: SqlTx, kind: string, keys: readonly string[]): Promise<void> },
  nodeId: string,
): Promise<number> {
  const { rows } = await tx.query<{ owner_id: string }>(
    `SELECT DISTINCT a.owner_id FROM allocations a JOIN reservations r ON r.id = a.owner_id
      WHERE a.node_id = $1 AND a.owner_kind = 'reservation' AND a.released_at IS NULL
        AND r.state IN ('binding', 'active')
      ORDER BY a.owner_id`,
    [nodeId],
  );
  const keys = rows.map((row) => row.owner_id);
  if (keys.length && work.enqueueMany) await work.enqueueMany(tx, reservationsWorkKind, keys);
  else for (const key of keys) await work.enqueue(tx, reservationsWorkKind, key);
  return keys.length;
}

async function upsertCondition(tx: SqlTx, nodeId: string, type: string, status: 'true' | 'false', reason: string | null) {
  await upsertNodeConditions(tx, nodeId, [{ type, status, reason }]);
}

/**
 * Sets several conditions of one node in one statement; `since` moves only when a status flips.
 * Types must be distinct (one statement cannot upsert a row twice).
 */
export async function upsertNodeConditions(
  tx: SqlTx,
  nodeId: string,
  conditions: readonly { type: string; status: 'true' | 'false' | 'unknown'; reason?: string | null | undefined }[],
): Promise<void> {
  if (conditions.length === 0) return;
  await tx.query(
    `INSERT INTO node_conditions (node_id, type, status, reason, since)
     SELECT $1, c.type, c.status, c.reason, compute_now() FROM unnest($2::text[], $3::text[], $4::text[]) AS c(type, status, reason)
     ON CONFLICT (node_id, type) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
       since = CASE WHEN node_conditions.status = EXCLUDED.status THEN node_conditions.since ELSE EXCLUDED.since END`,
    [nodeId, conditions.map((c) => c.type), conditions.map((c) => c.status), conditions.map((c) => c.reason ?? null)],
  );
}

/**
 * Writes inventory-derived health for a node in the caller's transaction: `device_health` rows
 * with source `inventory` follow `findings` exactly (added and removed), the owned conditions are
 * set true or false, and NoSchedule findings are mirrored into `no_schedule_reasons`. Returns the
 * node's new reasons (the caller holds the node row lock).
 */
export async function applyInventoryHealth(
  tx: SqlTx,
  nodeId: string,
  findings: readonly HealthFinding[],
  currentReasons: readonly string[],
  /** Collects the owned conditions here instead of writing them (a caller that writes one batch). */
  deferred?: { type: string; status: 'true' | 'false'; reason: string | null }[],
): Promise<string[]> {
  await tx.query(`DELETE FROM device_health WHERE node_id = $1 AND source = 'inventory'`, [nodeId]);
  if (findings.length > 0)
    await tx.query(
      `INSERT INTO device_health (device_id, node_id, reason, source, message)
       SELECT f.device_id, $1, f.reason, 'inventory', f.message FROM unnest($2::text[], $3::text[], $4::text[]) AS f(device_id, reason, message)
       ON CONFLICT (device_id, reason) DO NOTHING`,
      [nodeId, findings.map((f) => f.deviceId), findings.map((f) => f.condition), findings.map((f) => f.message)],
    );
  const owned = inventoryHealthConditions.map((type) => {
    const hits = findings.filter((finding) => finding.condition === type);
    return { type, status: hits.length ? ('true' as const) : ('false' as const), reason: hits.length ? hits.map((h) => h.deviceId).join(',').slice(0, 512) : null };
  });
  if (deferred) deferred.push(...owned);
  else await upsertNodeConditions(tx, nodeId, owned);
  return mergeNoScheduleReasons(
    currentReasons,
    inventoryHealthConditions,
    inventoryHealthConditions.map((type) => ({
      type,
      status: findings.some((f) => f.condition === type) ? ('true' as const) : ('false' as const),
      noSchedule: findings.some((f) => f.condition === type && f.noSchedule),
    })),
  );
}

/** What `recordXid` did. */
export interface XidOutcome {
  xid: number;
  policy?: HealthPolicy;
  /** The GPU was quarantined (it was known on the node). */
  quarantined: boolean;
  /** The node is now NoSchedule for it. */
  noSchedule: boolean;
}

/**
 * An XID event from the node (`node.event`, §10.1): sets the condition, quarantines the GPU for
 * device-level faults (the quarantine stays until `clearDeviceHealth`), and for node-level faults
 * makes the node NoSchedule; the health reconciler then drains and remediates it. XIDs without a
 * policy change nothing. Takes the node row lock.
 */
export async function recordXid(
  tx: SqlTx,
  nodeId: string,
  event: { gpuUuid: string; xid: number; message?: string },
): Promise<XidOutcome> {
  const policy = classifyXid(event.xid);
  if (!policy) return { xid: event.xid, quarantined: false, noSchedule: false };
  const node = await tx.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE', [nodeId]);
  if (!node.rows[0]) return { xid: event.xid, policy, quarantined: false, noSchedule: false };
  await upsertCondition(tx, nodeId, policy.condition, 'true', `xid ${event.xid} on ${event.gpuUuid}`.slice(0, 512));
  const device = await tx.query(
    `INSERT INTO device_health (device_id, node_id, reason, source, message)
     SELECT id, node_id, $3, 'xid', $4 FROM devices WHERE id = $1 AND node_id = $2
     ON CONFLICT (device_id, reason) DO NOTHING`,
    [event.gpuUuid, nodeId, policy.condition, event.message ?? policy.description],
  );
  const quarantined = (device.rowCount ?? 0) > 0 || (await isQuarantined(tx, event.gpuUuid));
  await tx.query('UPDATE devices SET healthy = false WHERE id = $1 AND node_id = $2 AND healthy', [event.gpuUuid, nodeId]);
  if (policy.noSchedule) {
    const reasons = [...new Set([...node.rows[0].no_schedule_reasons, policy.condition])].sort();
    await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1 AND NOT ($3 = ANY(no_schedule_reasons))', [
      nodeId,
      reasons,
      policy.condition,
    ]);
  }
  return { xid: event.xid, policy, quarantined, noSchedule: policy.noSchedule };
}

async function isQuarantined(tx: SqlTx, deviceId: string): Promise<boolean> {
  const { rowCount } = await tx.query('SELECT 1 FROM device_health WHERE device_id = $1', [deviceId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Lifts a quarantine (an operator after a repair, or remediation after a reset). With `reason`,
 * only that quarantine; the device turns healthy once no quarantine is left. Returns whether any
 * was removed.
 */
export async function clearDeviceHealth(tx: SqlTx, deviceId: string, reason?: string): Promise<boolean> {
  const removed = await tx.query('DELETE FROM device_health WHERE device_id = $1 AND ($2::text IS NULL OR reason = $2)', [
    deviceId,
    reason ?? null,
  ]);
  if (!(await isQuarantined(tx, deviceId))) await tx.query('UPDATE devices SET healthy = true WHERE id = $1 AND NOT healthy', [deviceId]);
  return (removed.rowCount ?? 0) > 0;
}

/**
 * Clears node-level XID conditions after a successful remediation (a reboot or GPU reset): the
 * conditions go false, their NoSchedule reasons go, and XID quarantines of the reset GPUs lift.
 */
export async function clearNodeFaults(tx: SqlTx, nodeId: string, conditions: readonly NodeConditionType[]): Promise<void> {
  const node = await tx.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE', [nodeId]);
  if (!node.rows[0]) return;
  for (const type of conditions) await upsertCondition(tx, nodeId, type, 'false', null);
  const reasons = node.rows[0].no_schedule_reasons.filter((reason) => !conditions.includes(reason as NodeConditionType));
  if (reasons.length !== node.rows[0].no_schedule_reasons.length)
    await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1', [nodeId, reasons]);
  const lifted = await tx.query<{ device_id: string }>(
    `DELETE FROM device_health WHERE node_id = $1 AND source = 'xid' AND reason = ANY($2) RETURNING device_id`,
    [nodeId, conditions],
  );
  for (const { device_id } of lifted.rows)
    if (!(await isQuarantined(tx, device_id))) await tx.query('UPDATE devices SET healthy = true WHERE id = $1', [device_id]);
}
