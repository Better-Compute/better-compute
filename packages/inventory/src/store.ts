import {
  ComputeError,
  newId,
  type EventPublisher,
  type InventorySnapshot,
  type Json,
  type SqlExecutor,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import { INVENTORY_SECTIONS, type InventorySectionName } from '@better-compute/protocol';
import { devicesFromGpus, planDevices, poolSharing, type GpuSharing, type StoredDevice } from './devices.js';
import { diffInventory } from './diff.js';
import { hardwareKey } from './hardware-key.js';
import { applyInventoryHealth, healthWorkKind, inventoryHealthFindings, type HealthFinding } from './health.js';
import {
  inventoryConditions,
  inventoryLabels,
  mergeNoScheduleReasons,
  type InventoryCondition,
  type InventoryExpectation,
} from './labels.js';
import {
  inventoryDigest,
  normalizeHash,
  normalizeSectionHashes,
  sectionsToRequest,
  verifySection,
  type InventorySections,
  type ReportedSection,
  type SectionHashes,
} from './sections.js';

// The Inventory reconciler's storage side (PLAN.md §10.1). The gateway records the hashes a node
// reports and ingests the sections it pulls; `applyInventory` turns a complete set of sections into
// an append-only snapshot, and derives devices, labels, conditions, `no_schedule_reasons` and the
// hardware key from it, all in one transaction with the node row locked.

/** The work-queue kind (and reconciler name) of inventory application; keys are node ids. */
export const inventoryWorkKind = 'inventory';

/** Condition types this reconciler owns in `node_conditions` and `no_schedule_reasons`. */
export const inventoryOwnedConditions = ['GpuCountMismatch', 'GpuModelUnknown', 'DuplicateIdentity'] as const;

/** Device classes inventory derives; other classes (VFs, disks, slots) belong to other writers. */
const derivedClasses = ['gpu', 'gpu.mig', 'gpu.slot'];

const nodeNotFound = (nodeId: string) => new ComputeError('NOT_FOUND', `Node ${nodeId} does not exist`);

/**
 * Hello / heartbeat: stores the hashes the node reports and returns the sections to pull
 * (`Welcome.request_sections`), comparing against the stored section bytes. Enqueues inventory
 * application when nothing needs pulling but the set changed (a section vanished, or a pull
 * completed before this report).
 */
export async function recordInventoryHashes(
  tx: SqlTx,
  work: WorkQueue,
  nodeId: string,
  reported: Readonly<Record<string, Uint8Array | string>>,
  options: { bootId?: string } = {},
): Promise<InventorySectionName[]> {
  const hashes = normalizeSectionHashes(reported);
  const upsert = await tx.query<{ applied_digest: string | null }>(
    `INSERT INTO node_inventory (node_id, reported_hashes, reported_at, boot_id)
     SELECT id, $2::jsonb, compute_now(), $3 FROM nodes WHERE id = $1
     ON CONFLICT (node_id) DO UPDATE SET reported_hashes = EXCLUDED.reported_hashes,
       reported_at = EXCLUDED.reported_at, boot_id = COALESCE(EXCLUDED.boot_id, node_inventory.boot_id)
     RETURNING applied_digest`,
    [nodeId, JSON.stringify(hashes), options.bootId ?? null],
  );
  if (upsert.rowCount === 0) throw nodeNotFound(nodeId);
  const stored = await storedSectionHashes(tx, nodeId);
  const request = sectionsToRequest(stored, hashes);
  if (request.length === 0 && upsert.rows[0]!.applied_digest !== inventoryDigest(hashes))
    await work.enqueue(tx, inventoryWorkKind, nodeId);
  return request;
}

async function storedSectionHashes(tx: SqlTx, nodeId: string): Promise<SectionHashes> {
  const { rows } = await tx.query<{ section: InventorySectionName; sha256: string }>(
    'SELECT section, sha256 FROM node_inventory_sections WHERE node_id = $1',
    [nodeId],
  );
  return Object.fromEntries(rows.map((row) => [row.section, row.sha256])) as SectionHashes;
}

/**
 * One pulled `InventorySection`: verifies it against its own hash (throws `INVALID_INPUT`), stores
 * the bytes and enqueues inventory application for the node. A section whose hash is not the one
 * the node last reported is stored anyway (a newer Hello may already be on its way) but does not
 * complete the set until the reports agree.
 */
export async function ingestInventorySection(
  tx: SqlTx,
  work: WorkQueue,
  nodeId: string,
  section: ReportedSection,
): Promise<void> {
  const verified = verifySection(section);
  const result = await tx.query(
    `INSERT INTO node_inventory_sections (node_id, section, sha256, content, received_at)
     SELECT id, $2, $3, $4, compute_now() FROM nodes WHERE id = $1
     ON CONFLICT (node_id, section) DO UPDATE SET sha256 = EXCLUDED.sha256,
       content = EXCLUDED.content, received_at = EXCLUDED.received_at`,
    [nodeId, verified.name, verified.sha256, section.content],
  );
  if (result.rowCount === 0) throw nodeNotFound(nodeId);
  await work.enqueue(tx, inventoryWorkKind, nodeId);
}

/** JSON for `inventory_snapshots.sections`: protobuf-es messages without `$typeName`, bigints as strings. */
export function sectionJson(value: unknown): Json {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(sectionJson);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value))
      if (key !== '$typeName' && child !== undefined) out[key] = sectionJson(child);
    return out;
  }
  return value as Json;
}

/** What `applyInventory` did. */
export type ApplyInventoryResult =
  /** No reported hashes yet, or a reported section's bytes have not arrived. */
  | { status: 'incomplete'; missing: InventorySectionName[] }
  /** The reported set is the one already applied. */
  | { status: 'unchanged'; digest: string }
  | {
      status: 'applied';
      snapshotId: string;
      digest: string;
      changes: ReturnType<typeof diffInventory>;
      conditions: InventoryCondition[];
      /** Health findings from the GPU counters (§10.1): quarantines and, for pending row remaps, NoSchedule. */
      health: HealthFinding[];
      /** `claimedElsewhere`: reported device ids another node already owns (raises DuplicateIdentity). */
      devices: { upserted: number; removed: number; quarantined: number; claimedElsewhere: string[] };
    };

export interface ApplyInventoryOptions {
  /** Publishes `node.inventory.changed` and one `node.<change>` event per diff entry. */
  events?: EventPublisher;
  /** Queues remediation (`health` work) when a finding blocks the node. */
  work?: WorkQueue;
  /** Overrides what the pool implies (`pools.gpu_model`, `policy.expect.gpuCount`). */
  expect?: InventoryExpectation;
}

interface NodeRow {
  id: string;
  owner_tenant_id: string;
  pool_id: string | null;
  no_schedule_reasons: string[];
  hardware_key: Uint8Array | null;
  hardware_key_trusted: boolean;
  gpu_model: string | null;
  policy: Record<string, unknown> | null;
  sharing: string | null;
}

function expectationFor(node: NodeRow, override?: InventoryExpectation): InventoryExpectation {
  const expect: InventoryExpectation = {};
  if (node.gpu_model) expect.gpuModel = node.gpu_model;
  const fromPolicy = (node.policy?.expect ?? {}) as Record<string, unknown>;
  if (typeof fromPolicy.gpuCount === 'number') expect.gpuCount = fromPolicy.gpuCount;
  if (typeof fromPolicy.gpuModel === 'string') expect.gpuModel = fromPolicy.gpuModel;
  return { ...expect, ...override };
}

/**
 * The Inventory reconciler body for one node, in one transaction (joining the caller's, if any).
 * Locks the node row, so it serializes with cordons, taints and the placer's `FOR SHARE`.
 */
export async function applyInventory(
  sql: SqlExecutor,
  nodeId: string,
  options: ApplyInventoryOptions = {},
): Promise<ApplyInventoryResult> {
  return sql.transaction(async (tx) => {
    const nodes = await tx.query<NodeRow>(
      `SELECT n.id, n.owner_tenant_id, n.pool_id, n.no_schedule_reasons, n.hardware_key,
              n.hardware_key_trusted, p.gpu_model, p.policy, p.sharing
         FROM nodes n LEFT JOIN pools p ON p.id = n.pool_id
        WHERE n.id = $1 FOR UPDATE OF n`,
      [nodeId],
    );
    const node = nodes.rows[0];
    if (!node) throw nodeNotFound(nodeId);

    const state = await tx.query<{ reported_hashes: Record<string, string>; applied_digest: string | null; boot_id: string | null }>(
      'SELECT reported_hashes, applied_digest, boot_id FROM node_inventory WHERE node_id = $1 FOR UPDATE',
      [nodeId],
    );
    const reported = state.rows[0] ? normalizeSectionHashes(state.rows[0].reported_hashes) : {};
    const reportedNames = INVENTORY_SECTIONS.filter((name) => reported[name] !== undefined);
    if (reportedNames.length === 0) return { status: 'incomplete', missing: [] };
    const digest = inventoryDigest(reported);
    if (state.rows[0]!.applied_digest === digest) return { status: 'unchanged', digest };

    const stored = await tx.query<{ section: InventorySectionName; sha256: string; content: Uint8Array }>(
      'SELECT section, sha256, content FROM node_inventory_sections WHERE node_id = $1',
      [nodeId],
    );
    const bytes = new Map(stored.rows.map((row) => [row.section, row]));
    const missing = reportedNames.filter((name) => bytes.get(name)?.sha256 !== reported[name]);
    if (missing.length > 0) return { status: 'incomplete', missing };

    const sections: InventorySections = {};
    for (const name of reportedNames) {
      const row = bytes.get(name)!;
      const verified = verifySection({ section: name, content: new Uint8Array(row.content), sha256: row.sha256 });
      (sections as Record<string, unknown>)[name] = verified.content;
    }

    // The previous snapshot, for the diff (JSON is enough: the diff reads ids, names and layouts).
    const previous = await tx.query<{ sections: Record<string, Json> }>(
      `SELECT sections FROM inventory_snapshots WHERE node_id = $1
        ORDER BY collected_at DESC, id DESC LIMIT 1`,
      [nodeId],
    );
    const changes = previous.rows[0]
      ? diffInventory(previous.rows[0].sections as unknown as InventorySections, sections)
      : [];

    const snapshotId = newId('inv');
    const json: Record<string, Json> = {};
    for (const name of reportedNames) json[name] = sectionJson(sections[name]);
    await tx.query(
      `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, boot_id, collected_at)
       VALUES ($1, $2, decode($3, 'hex'), $4::jsonb, $5::jsonb, $6, compute_now())`,
      [snapshotId, nodeId, digest, JSON.stringify(reported), JSON.stringify(json), state.rows[0]!.boot_id],
    );

    // Health first, so the device plan already sees this inventory's quarantines.
    const health = inventoryHealthFindings(sections.gpus);
    const healthReasons = await applyInventoryHealth(tx, nodeId, health, node.no_schedule_reasons);
    if (options.work && health.some((finding) => finding.noSchedule)) await options.work.enqueue(tx, healthWorkKind, nodeId);
    const devices = await applyDevices(tx, nodeId, sections, poolSharing(node.sharing, node.policy));
    await applyLabels(tx, nodeId, sections);

    // Hardware key: trusted keys are unique. A second node with the same trusted key is a
    // DuplicateIdentity (a cloned disk image, or a reclaimed board): this node keeps the key
    // untrusted until an operator resolves it.
    const key = hardwareKey(sections);
    const keyHex = key?.key ?? null;
    let trusted = key?.trusted ?? false;
    let duplicateOf: string | undefined;
    if (key && trusted) {
      // No lock on the other node (two nodes checking each other would deadlock): the partial
      // unique index decides, inside a savepoint so a violation leaves this transaction usable.
      const other = await tx.query<{ id: string }>(
        `SELECT id FROM nodes WHERE hardware_key = decode($1, 'hex') AND hardware_key_trusted AND id <> $2 LIMIT 1`,
        [key.key, nodeId],
      );
      if (other.rows[0]) duplicateOf = other.rows[0].id;
      else
        try {
          await sql.transaction((sp) =>
            sp.query(`UPDATE nodes SET hardware_key = decode($2, 'hex'), hardware_key_trusted = true WHERE id = $1`, [
              nodeId,
              keyHex,
            ]),
          );
        } catch (error) {
          if ((error as { code?: unknown }).code !== '23505') throw error;
          duplicateOf = 'a node that joined concurrently';
        }
      if (duplicateOf) trusted = false;
    }

    const conditions: InventoryCondition[] = [
      ...inventoryConditions(sections, expectationFor(node, options.expect)),
      duplicateOf
        ? { type: 'DuplicateIdentity', status: 'true', reason: 'HardwareKeyInUse', message: `hardware key already belongs to ${duplicateOf}`, noSchedule: true }
        : devices.claimedElsewhere.length > 0
          ? {
              type: 'DuplicateIdentity',
              status: 'true',
              reason: 'DeviceClaimedByAnotherNode',
              message: `devices already registered to another node: ${devices.claimedElsewhere.join(', ')}`,
              noSchedule: true,
            }
          : { type: 'DuplicateIdentity', status: 'false', noSchedule: false },
    ];
    for (const condition of conditions)
      await tx.query(
        `INSERT INTO node_conditions (node_id, type, status, reason, since)
         VALUES ($1, $2, $3, $4, compute_now())
         ON CONFLICT (node_id, type) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
           since = CASE WHEN node_conditions.status = EXCLUDED.status THEN node_conditions.since ELSE EXCLUDED.since END`,
        [nodeId, condition.type, condition.status, condition.reason ?? null],
      );

    const reasons = mergeNoScheduleReasons(healthReasons, inventoryOwnedConditions, conditions);
    const currentKey = node.hardware_key ? Buffer.from(node.hardware_key).toString('hex') : null;
    const reasonsChanged = JSON.stringify(reasons) !== JSON.stringify([...node.no_schedule_reasons].sort());
    if (reasonsChanged || keyHex !== currentKey || trusted !== node.hardware_key_trusted)
      await tx.query(
        `UPDATE nodes SET no_schedule_reasons = $2, hardware_key = decode($3, 'hex'),
           hardware_key_trusted = $4, version = version + 1
         WHERE id = $1`,
        [nodeId, reasons, keyHex, trusted],
      );

    await tx.query(
      `UPDATE node_inventory SET applied_digest = $2, applied_snapshot_id = $3, applied_at = compute_now()
        WHERE node_id = $1`,
      [nodeId, digest, snapshotId],
    );

    if (options.events) {
      const subject = `node/${nodeId}`;
      const tenantId = node.owner_tenant_id;
      await options.events.publish(tx, {
        type: 'node.inventory.changed',
        tenantId,
        subject,
        data: { snapshotId, digest, sections: reportedNames, changes: changes.length },
      });
      for (const change of changes)
        await options.events.publish(tx, {
          type: `node.${change.type}`,
          tenantId,
          subject,
          data: { snapshotId, ...(change as unknown as Record<string, Json>) },
        });
    }
    return { status: 'applied', snapshotId, digest, changes, conditions, devices, health };
  });
}

async function applyDevices(tx: SqlTx, nodeId: string, sections: InventorySections, sharing: GpuSharing | undefined) {
  const stored = await tx.query<{
    id: string;
    parent_id: string | null;
    class: StoredDevice['class'];
    bookable: boolean;
    healthy: boolean;
    attributes: StoredDevice['attributes'];
  }>(
    `SELECT id, parent_id, class, bookable, healthy, attributes FROM devices
      WHERE node_id = $1 AND class = ANY($2) FOR UPDATE`,
    [nodeId, derivedClasses],
  );
  const current: StoredDevice[] = stored.rows.map((row) => ({
    id: row.id,
    class: row.class,
    bookable: row.bookable,
    healthy: row.healthy,
    attributes: row.attributes,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
  }));
  const booked = await tx.query<{ device_id: string }>(
    `SELECT DISTINCT b.device_id FROM device_bookings b JOIN devices d ON d.id = b.device_id
      WHERE d.node_id = $1 AND (upper_inf(b.during) OR upper(b.during) > compute_now())`,
    [nodeId],
  );
  // Quarantined devices (`device_health`, v0.2 Health) stay unhealthy whatever inventory says.
  const quarantined = await tx.query<{ device_id: string }>(
    'SELECT DISTINCT device_id FROM device_health WHERE node_id = $1',
    [nodeId],
  );
  const plan = planDevices(current, devicesFromGpus(nodeId, sections.gpus, sharing), {
    bookedDeviceIds: new Set(booked.rows.map((row) => row.device_id)),
    unhealthy: new Set(quarantined.rows.map((row) => row.device_id)),
  });

  // Parents before children on insert; the plan lists devices in that order.
  const claimedElsewhere: string[] = [];
  for (const device of plan.upsert) {
    const result = await tx.query(
      `INSERT INTO devices (id, node_id, parent_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, class = EXCLUDED.class,
         bookable = EXCLUDED.bookable, healthy = EXCLUDED.healthy, attributes = EXCLUDED.attributes
       WHERE devices.node_id = EXCLUDED.node_id`,
      [device.id, nodeId, device.parentId ?? null, device.class, device.bookable, device.healthy, JSON.stringify(device.attributes)],
    );
    // 0 rows: the id belongs to another node (a GPU moved without its old node reporting it gone,
    // or a cloned identity). The other node keeps it until its own inventory drops it.
    if (result.rowCount === 0) claimedElsewhere.push(device.id);
  }
  if (plan.quarantine.length > 0)
    await tx.query('UPDATE devices SET healthy = false WHERE node_id = $1 AND id = ANY($2)', [nodeId, plan.quarantine]);
  if (plan.remove.length > 0) {
    // Ended bookings are history that allocations.atoms already records; they would pin the row.
    await tx.query(
      `DELETE FROM device_bookings WHERE device_id = ANY($1) AND NOT upper_inf(during) AND upper(during) <= compute_now()`,
      [plan.remove],
    );
    for (const id of plan.remove)
      await tx.query('DELETE FROM devices WHERE node_id = $1 AND id = $2', [nodeId, id]);
  }
  return {
    upserted: plan.upsert.length - claimedElsewhere.length,
    removed: plan.remove.length,
    quarantined: plan.quarantine.length,
    claimedElsewhere,
  };
}

async function applyLabels(tx: SqlTx, nodeId: string, sections: InventorySections): Promise<void> {
  const labels = inventoryLabels(sections);
  await tx.query(
    `DELETE FROM node_labels WHERE node_id = $1 AND source = 'inventory' AND NOT (key = ANY($2))`,
    [nodeId, labels.map((label) => label.key)],
  );
  for (const label of labels)
    await tx.query(
      `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, $3, 'inventory')
       ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value
       WHERE node_labels.source = 'inventory' AND node_labels.value <> EXCLUDED.value`,
      [nodeId, label.key, label.value],
    );
}

interface SnapshotRow {
  id: string;
  sha256: Uint8Array;
  sections: Record<string, Json>;
  collected_at: Date;
}
const toSnapshot = (nodeId: string, row: SnapshotRow): InventorySnapshot => ({
  nodeId,
  hash: normalizeHash(new Uint8Array(row.sha256)) ?? '',
  sections: row.sections,
  collectedAt: row.collected_at.getTime(),
});

/** `inventory.history`: a node's snapshots, newest first; `cursor` is the last snapshot id seen. */
export async function inventoryHistory(
  tx: SqlTx,
  nodeId: string,
  page: { limit: number; cursor?: string },
): Promise<{ items: InventorySnapshot[]; cursor?: string }> {
  const { rows } = await tx.query<SnapshotRow>(
    `SELECT id, sha256, sections, collected_at FROM inventory_snapshots
      WHERE node_id = $1 AND ($2::text IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
    [nodeId, page.cursor ?? null, page.limit + 1],
  );
  const items = rows.slice(0, page.limit);
  return rows.length > page.limit
    ? { items: items.map((row) => toSnapshot(nodeId, row)), cursor: items.at(-1)!.id }
    : { items: items.map((row) => toSnapshot(nodeId, row)) };
}

async function snapshotByRef(tx: SqlTx, nodeId: string, ref: string): Promise<SnapshotRow> {
  const { rows } = await tx.query<SnapshotRow>(
    `SELECT id, sha256, sections, collected_at FROM inventory_snapshots
      WHERE node_id = $1 AND (id = $2 OR encode(sha256, 'hex') = $2) ORDER BY id DESC LIMIT 1`,
    [nodeId, ref],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Node ${nodeId} has no snapshot ${ref}`);
  return rows[0];
}

/**
 * `inventory.diff`: the changes between two snapshots (ids or hashes). Without `to`, the latest;
 * without `from`, the snapshot before `to`. A node with a single snapshot diffs against nothing.
 */
export async function inventoryDiff(
  tx: SqlTx,
  nodeId: string,
  refs: { from?: string; to?: string } = {},
): Promise<{ nodeId: string; from: string; to: string; changes: ReturnType<typeof diffInventory> }> {
  const to = refs.to
    ? await snapshotByRef(tx, nodeId, refs.to)
    : (
        await tx.query<SnapshotRow>(
          'SELECT id, sha256, sections, collected_at FROM inventory_snapshots WHERE node_id = $1 ORDER BY id DESC LIMIT 1',
          [nodeId],
        )
      ).rows[0];
  if (!to) throw new ComputeError('NOT_FOUND', `Node ${nodeId} has no inventory yet`);
  const from = refs.from
    ? await snapshotByRef(tx, nodeId, refs.from)
    : (
        await tx.query<SnapshotRow>(
          'SELECT id, sha256, sections, collected_at FROM inventory_snapshots WHERE node_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1',
          [nodeId, to.id],
        )
      ).rows[0];
  const hash = (row: SnapshotRow) => normalizeHash(new Uint8Array(row.sha256)) ?? '';
  return {
    nodeId,
    from: from ? hash(from) : '',
    to: hash(to),
    changes: from ? diffInventory(from.sections as unknown as InventorySections, to.sections as unknown as InventorySections) : [],
  };
}

/** The latest snapshot of a node (`inventory.get`), or undefined before its first inventory. */
export async function latestInventory(tx: SqlTx, nodeId: string): Promise<InventorySnapshot | undefined> {
  const { rows } = await tx.query<{ sha256: Uint8Array; sections: Record<string, Json>; collected_at: Date }>(
    `SELECT sha256, sections, collected_at FROM inventory_snapshots WHERE node_id = $1
      ORDER BY collected_at DESC, id DESC LIMIT 1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    nodeId,
    hash: normalizeHash(new Uint8Array(row.sha256)) ?? '',
    sections: row.sections,
    collectedAt: row.collected_at.getTime(),
  };
}

