import {
  ComputeError,
  draftId,
  type HostVolumeSpec,
  type InstanceSpec,
  type Migration,
  type MethodContext,
  type SqlTx,
} from '@better-compute/core';
import { chargeQuota, hourMs, meterAllocation, refundQuota, resizeAllocation } from '@better-compute/capacity';
import { fail, id, int, key, name, object, optional, tenant } from './input.js';
import { openEnded, visibleVpsPool, type InstanceDeps } from './instances.js';

// Agent memory (PLAN.md §3.8, [595a2f]'s seam 014bf0d): a sandbox volume is a persistent disk on one host
// that the tenant's sandboxes attach across runs, so an agent keeps its memory, caches and checkouts. It is
// placed when created: its size is booked as `diskGiB` on one host of the pool through the CapacityPort
// (an allocation owned by the volume, charged to the tenant's quota), and the host keeps it as a sparse
// qcow2 (NodeSpec `volumes`). Sandboxes whose template names it run on that host only, attach it as an
// extra virtio disk (InstanceSpec `volumes`) and mount it by serial from their user data. Any number of
// read-only attachments, or one read-write one, never both: two guests writing one filesystem corrupt it.
// Deleting a volume takes it out of the node's spec (bcd then discards and unlinks it); the row stays
// `deleting`, with its disk still booked, until the host has applied a spec without it.

/** The work-queue kind of the volume pass (finishing deletions). */
export const volumeWork = 'vps.volumes';
/** What a volume's hours are metered as: GiB-hours from creation until it is gone. */
export const volumeMeter = 'vps.volume.gib.hours';

export const maxVolumeGiB = 16_384;
/** Volumes one template may attach. */
export const maxTemplateVolumes = 8;
const GiB = 2 ** 30;

export const vpsVolumesMigration: Migration = {
  name: 'vps/0020_volumes',
  sql: `
CREATE TABLE sandbox_volumes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  pool_id text NOT NULL REFERENCES pools,
  name text NOT NULL,
  size_gib int NOT NULL CHECK (size_gib BETWEEN 1 AND ${maxVolumeGiB}),
  -- The guest's /dev/disk/by-id/virtio-<serial>: 'bcv-' and the id's last 16 characters.
  serial text NOT NULL UNIQUE CHECK (serial ~ '^[a-z0-9-]{1,20}$'),
  -- The host it lives on and its diskGiB booking there; NULL only before its first placement.
  node_id text,
  allocation_id text,
  state text NOT NULL CHECK (state IN ('ready', 'deleting', 'deleted')),
  -- The host's spec generation when the volume left it: gone once a later spec is observed.
  deleting_generation bigint,
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  deleting_at timestamptz,
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE UNIQUE INDEX sandbox_volumes_name ON sandbox_volumes (tenant_id, name) WHERE state <> 'deleted';
CREATE INDEX sandbox_volumes_node ON sandbox_volumes (node_id) WHERE state <> 'deleted';
CREATE INDEX sandbox_volumes_deleting ON sandbox_volumes (deleting_at) WHERE state = 'deleting';

-- Which instance attaches which volume, in attach order. Live while the instance is not deleted.
CREATE TABLE volume_attachments (
  instance_id text NOT NULL,
  volume_id text NOT NULL REFERENCES sandbox_volumes,
  position int NOT NULL,
  read_only bool NOT NULL,
  mount_path text NOT NULL,
  PRIMARY KEY (instance_id, volume_id)
);
CREATE INDEX volume_attachments_volume ON volume_attachments (volume_id);

-- A template's volumes: [{ volumeId, mountPath, readOnly }], resolved to ids when written.
ALTER TABLE sandbox_templates ADD COLUMN volumes jsonb NOT NULL DEFAULT '[]';
`,
};

export type VolumeState = 'ready' | 'deleting' | 'deleted';

export interface SandboxVolume {
  id: string;
  tenantId: string;
  poolId: string;
  name: string;
  sizeGiB: number;
  /** The guest finds it at `/dev/disk/by-id/virtio-<serial>`. */
  serial: string;
  /** The host it lives on: sandboxes that attach it run there. */
  nodeId?: string;
  state: VolumeState;
  createdAt: number;
  deletedAt?: number;
}

export interface CreateVolumeInput {
  tenantId: string;
  poolId: string;
  name: string;
  sizeGiB: number;
  idempotencyKey: string;
}
export type VolumeRef = { tenantId: string; volumeId: string };
export interface ListVolumesInput {
  tenantId: string;
  /** The caller's own volumes (`mine`, the default, as for snapshots), or the tenant's. */
  scope?: 'mine' | 'all';
  poolId?: string;
  /** Also deleted ones (default false). */
  includeDeleted?: boolean;
}

/** A template's volume, as written: by id or by name, where the guest mounts it, and how. */
export interface TemplateVolumeInput {
  volumeId?: string;
  name?: string;
  mountPath: string;
  readOnly?: boolean;
}
/** A template's volume, as stored (resolved to its id). */
export interface TemplateVolume {
  volumeId: string;
  mountPath: string;
  readOnly: boolean;
}

/** The virtio serial of a volume: `bcv-` and its id's last 16 characters (at most 20 bytes, [a-z0-9-]). */
export function volumeSerial(volumeId: string): string {
  const serial = `bcv-${volumeId.slice(-16)}`;
  if (!/^[a-z0-9-]{1,20}$/.test(serial)) throw new ComputeError('INVALID_STATE', `${volumeId} has no valid serial`);
  return serial;
}

// --- Input -------------------------------------------------------------------------------------------

export function parseCreateVolume(raw: unknown): CreateVolumeInput {
  const input = object(raw, ['tenantId', 'poolId', 'name', 'sizeGiB', 'idempotencyKey']);
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: name(input.name, 'name'),
    sizeGiB: int(input.sizeGiB, 'sizeGiB', 1, maxVolumeGiB),
    idempotencyKey: key(input.idempotencyKey),
  };
}

export function parseVolumeRef(raw: unknown): VolumeRef {
  const input = object(raw, ['tenantId', 'volumeId']);
  return { tenantId: tenant(input.tenantId), volumeId: id(input.volumeId, 'vol', 'volumeId') };
}

export function parseListVolumes(raw: unknown): ListVolumesInput {
  const input = object(raw, ['tenantId', 'scope', 'poolId', 'includeDeleted']);
  if (input.scope !== undefined && input.scope !== 'mine' && input.scope !== 'all') fail('scope must be mine or all');
  const out: ListVolumesInput = { tenantId: tenant(input.tenantId), scope: (input.scope as 'mine' | 'all' | undefined) ?? 'mine' };
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) out.poolId = poolId;
  if (input.includeDeleted !== undefined) {
    if (typeof input.includeDeleted !== 'boolean') fail('includeDeleted must be true or false');
    out.includeDeleted = input.includeDeleted;
  }
  return out;
}

// Where a guest may mount one: an absolute path, never over the system itself.
const mountPathPattern = /^\/[A-Za-z0-9._\-/]{1,254}$/;
const systemPaths = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var'];

function mountPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || !mountPathPattern.test(value) || value.includes('//') || /(^|\/)\.\.?(\/|$)/.test(value))
    fail(`${where}.mountPath must be an absolute path without . or .. segments`);
  const path = (value as string).replace(/\/+$/, '') || '/';
  if (systemPaths.includes(path) || systemPaths.some((system) => system !== '/' && ['/proc', '/sys', '/dev', '/boot'].includes(system) && path.startsWith(`${system}/`)))
    fail(`${where}.mountPath ${path} would cover part of the system; mount under /mnt, /data, /home or /workspace`);
  return path;
}

/** A template's `volumes` as the caller wrote them (resolved against the tenant's volumes on write). */
export function parseTemplateVolumes(value: unknown): TemplateVolumeInput[] {
  if (!Array.isArray(value) || value.length > maxTemplateVolumes)
    fail(`volumes must be a list of at most ${maxTemplateVolumes} { volumeId | name, mountPath, readOnly? }`);
  const out: TemplateVolumeInput[] = [];
  for (const [index, raw] of (value as unknown[]).entries()) {
    const where = `volumes[${index}]`;
    const input = object(raw, ['volumeId', 'name', 'mountPath', 'readOnly']);
    if ((input.volumeId === undefined) === (input.name === undefined)) fail(`${where} names a volume by volumeId or by name, not both`);
    const entry: TemplateVolumeInput = { mountPath: mountPath(input.mountPath, where) };
    if (input.volumeId !== undefined) entry.volumeId = id(input.volumeId, 'vol', `${where}.volumeId`);
    if (input.name !== undefined) entry.name = name(input.name, `${where}.name`);
    if (input.readOnly !== undefined) {
      if (typeof input.readOnly !== 'boolean') fail(`${where}.readOnly must be true or false`);
      entry.readOnly = input.readOnly;
    }
    out.push(entry);
  }
  const paths = out.map((entry) => entry.mountPath);
  if (new Set(paths).size !== paths.length) fail('volumes: two volumes mount at the same path');
  for (const a of paths) for (const b of paths) if (a !== b && b.startsWith(`${a}/`)) fail(`volumes: ${b} is inside ${a}`);
  return out;
}

/**
 * Resolves a template's volumes for a write: each must be the tenant's, in the template's pool and ready;
 * a volume at most once. A template with volumes keeps no warm pool: a warm instance would hold them.
 */
export async function resolveTemplateVolumes(
  tx: SqlTx,
  template: { tenantId: string; poolId: string; warmMax: number },
  volumes: readonly TemplateVolumeInput[],
): Promise<TemplateVolume[]> {
  if (volumes.length === 0) return [];
  if (template.warmMax > 0) fail('A template with volumes keeps no warm pool (warm.max must be 0): a warm instance would hold its volumes');
  const resolved: TemplateVolume[] = [];
  for (const [index, entry] of volumes.entries()) {
    const { rows } = await tx.query<{ id: string; pool_id: string; state: VolumeState }>(
      entry.volumeId
        ? `SELECT id, pool_id, state FROM sandbox_volumes WHERE tenant_id = $1 AND id = $2 AND state <> 'deleted'`
        : `SELECT id, pool_id, state FROM sandbox_volumes WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
      [template.tenantId, entry.volumeId ?? entry.name],
    );
    const volume = rows[0];
    if (!volume) throw new ComputeError('NOT_FOUND', `volumes[${index}]: volume ${entry.volumeId ?? entry.name} not found`);
    if (volume.state !== 'ready') throw new ComputeError('INVALID_STATE', `volumes[${index}]: volume ${volume.id} is ${volume.state}`);
    if (volume.pool_id !== template.poolId)
      throw new ComputeError('INVALID_INPUT', `volumes[${index}]: volume ${volume.id} lives in pool ${volume.pool_id}, not ${template.poolId}`);
    resolved.push({ volumeId: volume.id, mountPath: entry.mountPath, readOnly: entry.readOnly ?? false });
  }
  const ids = resolved.map((volume) => volume.volumeId);
  if (new Set(ids).size !== ids.length) fail('volumes: a volume is named twice');
  return resolved;
}

/** A mount the admission decision covered: the volume, and whether writing to it was decided too. */
export interface DecidedVolume {
  volumeId: string;
  write: boolean;
}

/**
 * The volumes a template write mounts, resolved to ids outside any transaction, for the per-volume
 * decision (review 2, MED 1): a template hands its volumes to every sandbox it starts, so mounting one
 * takes `compute:sandboxes:manage` on `sandbox-volume/<id>` (read-write) or `compute:sandboxes:read`
 * (read-only), not only the right to manage templates. A name that resolves to nothing is left out;
 * the write itself then fails NOT_FOUND.
 */
export async function templateVolumeDecisions(
  sql: Pick<SqlTx, 'query'>,
  tenantId: string,
  volumes: readonly { volumeId?: string; name?: string; readOnly?: boolean }[],
): Promise<DecidedVolume[]> {
  const decided = new Map<string, boolean>();
  for (const entry of volumes) {
    let volumeId = entry.volumeId;
    if (!volumeId && entry.name) {
      const { rows } = await sql.query<{ id: string }>(
        `SELECT id FROM sandbox_volumes WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
        [tenantId, entry.name],
      );
      volumeId = rows[0]?.id;
    }
    if (volumeId) decided.set(volumeId, (decided.get(volumeId) ?? false) || entry.readOnly !== true);
  }
  return [...decided].map(([volumeId, write]) => ({ volumeId, write }));
}

/**
 * Refuses a template's resolved volumes the admission decision did not cover: a name re-pointed at another
 * volume, or a mount made writable, since the check read them outside the transaction. `CONFLICT`
 * (`volumes-changed`): the caller retries, and is decided again.
 */
export function assertVolumesDecided(templateId: string, resolved: readonly TemplateVolume[], decided: readonly DecidedVolume[] | undefined): void {
  if (resolved.length === 0) return;
  const covered = new Map((decided ?? []).map((entry) => [entry.volumeId, entry.write]));
  const unchecked = resolved.filter((volume) => !covered.has(volume.volumeId) || (!volume.readOnly && covered.get(volume.volumeId) !== true));
  if (unchecked.length > 0)
    throw new ComputeError('CONFLICT', `Sandbox template ${templateId}'s volumes changed while this write was decided; retry`, undefined, {
      templateId,
      reason: 'volumes-changed',
      volumeIds: unchecked.map((volume) => volume.volumeId),
    });
}

/** A stored template's `volumes` column. */
export function templateVolumesOf(raw: unknown): TemplateVolume[] {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? (value as TemplateVolume[]).map((volume) => ({ ...volume })) : [];
}

// --- Rows --------------------------------------------------------------------------------------------

interface VolumeRow {
  id: string;
  tenant_id: string;
  pool_id: string;
  name: string;
  size_gib: number;
  serial: string;
  node_id: string | null;
  allocation_id: string | null;
  state: VolumeState;
  deleting_generation: string | number | null;
  created_by: string;
  request_hash: string;
  created_at: Date;
  deleted_at: Date | null;
}
const columns = `id, tenant_id, pool_id, name, size_gib, serial, node_id, allocation_id, state, deleting_generation,
  created_by, request_hash, created_at, deleted_at`;

export function volumeView(row: VolumeRow): SandboxVolume {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    name: row.name,
    sizeGiB: Number(row.size_gib),
    serial: row.serial,
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    state: row.state,
    createdAt: new Date(row.created_at).getTime(),
    ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at).getTime() } : {}),
  };
}

async function readVolume(tx: SqlTx, ref: VolumeRef, options: { lock?: boolean } = {}): Promise<VolumeRow | undefined> {
  const { rows } = await tx.query<VolumeRow>(
    `SELECT ${columns} FROM sandbox_volumes WHERE id = $1 AND tenant_id = $2${options.lock ? ' FOR UPDATE' : ''}`,
    [ref.volumeId, ref.tenantId],
  );
  return rows[0];
}

const requestHash = (input: CreateVolumeInput) => JSON.stringify([input.poolId, input.name, input.sizeGiB]);

// --- API ---------------------------------------------------------------------------------------------

/**
 * `sandboxVolumes.create`: books the volume's disk on one host of the pool (`CAPACITY_UNAVAILABLE` when
 * none has room, `QUOTA_EXCEEDED` past the tenant's diskGiB quota) and puts it in that host's spec. A
 * retry with the same key answers the same volume; with another request, `CONFLICT`.
 */
export async function createVolume(
  deps: Pick<InstanceDeps, 'capacity' | 'clock' | 'desired' | 'authz' | 'events'>,
  context: Pick<MethodContext, 'sql' | 'caller'>,
  input: CreateVolumeInput,
): Promise<SandboxVolume> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const volumeId = await draftId('vol', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readVolume(tx, { tenantId: input.tenantId, volumeId });
  if (existing) {
    if (existing.request_hash !== requestHash(input)) throw new ComputeError('CONFLICT', 'This idempotency key was used for a different volume');
    return volumeView(existing);
  }
  const pool = await visibleVpsPool(tx, input.tenantId, input.poolId);
  if (pool.class !== 'vps-host') throw new ComputeError('INVALID_INPUT', `Pool ${pool.id} is a provider pool; volumes live on hosted pools`);
  const taken = await tx.query(`SELECT 1 FROM sandbox_volumes WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`, [input.tenantId, input.name]);
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `Volume ${input.name} already exists`);
  if (!deps.capacity) throw new ComputeError('INVALID_CONFIG', 'Volumes need the capacity module');
  const outcome = await deps.capacity.reserve(tx, {
    tenantId: input.tenantId,
    poolId: input.poolId,
    volumeId,
    devices: [],
    resources: { diskGiB: input.sizeGiB },
    during: { start: deps.clock.now(), end: openEnded },
  });
  if (outcome.status !== 'placed')
    throw new ComputeError('CAPACITY_UNAVAILABLE', `No host in pool ${input.poolId} has ${input.sizeGiB} GiB of disk for the volume`, undefined, {
      reason: outcome.status === 'pending' ? outcome.reason : 'queued',
    });
  const allocation = outcome.allocations[0]!;
  const { rows } = await tx.query<VolumeRow>(
    `INSERT INTO sandbox_volumes (id, tenant_id, pool_id, name, size_gib, serial, node_id, allocation_id, state,
                                  created_by, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10, $11) RETURNING ${columns}`,
    [
      volumeId,
      input.tenantId,
      input.poolId,
      input.name,
      input.sizeGiB,
      volumeSerial(volumeId),
      allocation.nodeId,
      allocation.id,
      caller.identityId,
      input.idempotencyKey,
      requestHash(input),
    ],
  );
  await deps.authz.upsert(tx, {
    type: 'sandbox-volume',
    id: volumeId,
    tenantId: input.tenantId,
    attributes: { sizeGiB: input.sizeGiB },
    parentType: 'pool',
    parentId: input.poolId,
    ownerId: caller.identityId,
  });
  await deps.desired.invalidate(tx, allocation.nodeId);
  await deps.events.publish(tx, {
    type: 'sandbox.volume.created',
    tenantId: input.tenantId,
    subject: `sandbox-volume/${volumeId}`,
    data: { volumeId, poolId: input.poolId, nodeId: allocation.nodeId, sizeGiB: input.sizeGiB },
  });
  return volumeView(rows[0]!);
}

export async function getVolume(tx: SqlTx, ref: VolumeRef): Promise<SandboxVolume> {
  const row = await readVolume(tx, ref);
  if (!row) throw new ComputeError('NOT_FOUND', `Volume ${ref.volumeId} not found`);
  return volumeView(row);
}

export async function listVolumes(tx: SqlTx, input: ListVolumesInput, callerIdentityId?: string): Promise<{ items: SandboxVolume[] }> {
  // `mine` without a caller matches nothing rather than everything.
  const owner = (input.scope ?? 'mine') === 'mine' ? (callerIdentityId ?? '') : null;
  const { rows } = await tx.query<VolumeRow>(
    `SELECT ${columns} FROM sandbox_volumes
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3 OR state <> 'deleted')
        AND ($4::text IS NULL OR created_by = $4)
      ORDER BY created_at, id LIMIT 500`,
    [input.tenantId, input.poolId ?? null, input.includeDeleted === true, owner],
  );
  return { items: rows.map(volumeView) };
}

/** Instances not yet deleted that attach `volumeId`. */
async function liveAttachments(tx: SqlTx, volumeId: string): Promise<{ instance_id: string; read_only: boolean }[]> {
  const { rows } = await tx.query<{ instance_id: string; read_only: boolean }>(
    `SELECT va.instance_id, va.read_only FROM volume_attachments va JOIN instances i ON i.id = va.instance_id
      WHERE va.volume_id = $1 AND i.state <> 'deleted'`,
    [volumeId],
  );
  return rows;
}

/**
 * `sandboxVolumes.delete`: refused while a sandbox attaches it (`CONFLICT`). Otherwise the volume leaves
 * its host's spec at once (bcd discards and unlinks it) and stays `deleting`, disk still booked, until the
 * host applied a spec without it (`finishVolumeDeletions`).
 */
export async function deleteVolume(
  deps: Pick<InstanceDeps, 'desired' | 'events' | 'work'>,
  tx: SqlTx,
  ref: VolumeRef,
): Promise<SandboxVolume> {
  const row = await readVolume(tx, ref, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Volume ${ref.volumeId} not found`);
  if (row.state !== 'ready') return volumeView(row);
  const attached = await liveAttachments(tx, row.id);
  if (attached.length > 0)
    throw new ComputeError('CONFLICT', `Volume ${row.id} is attached to ${attached.map((a) => a.instance_id).join(', ')}; delete those sandboxes first`);
  const templates = await tx.query<{ id: string }>(
    `SELECT id FROM sandbox_templates WHERE tenant_id = $1 AND NOT deleted AND volumes @> $2::jsonb`,
    [row.tenant_id, JSON.stringify([{ volumeId: row.id }])],
  );
  if (templates.rows.length > 0)
    throw new ComputeError('CONFLICT', `Volume ${row.id} is named by template ${templates.rows.map((t) => t.id).join(', ')}; update or delete it first`);
  const generation = row.node_id
    ? (await tx.query<{ generation: string }>('SELECT generation::text AS generation FROM nodes WHERE id = $1', [row.node_id])).rows[0]?.generation
    : undefined;
  const { rows } = await tx.query<VolumeRow>(
    `UPDATE sandbox_volumes SET state = 'deleting', deleting_at = compute_now(), deleting_generation = $2, version = version + 1
      WHERE id = $1 RETURNING ${columns}`,
    [row.id, generation ?? null],
  );
  if (row.node_id) await deps.desired.invalidate(tx, row.node_id);
  await deps.work.enqueue(tx, volumeWork, row.id);
  await deps.events.publish(tx, {
    type: 'sandbox.volume.deleting',
    tenantId: row.tenant_id,
    subject: `sandbox-volume/${row.id}`,
    data: { volumeId: row.id },
  });
  return volumeView(rows[0]!);
}

/**
 * Finishes deletions: a `deleting` volume whose host applied a later spec (without it), or whose host is
 * gone, releases its disk booking (the quota comes back) and becomes `deleted`. Returns how many.
 */
export async function finishVolumeDeletions(
  deps: Pick<InstanceDeps, 'capacity' | 'authz' | 'events'>,
  tx: SqlTx,
  options: { onlyId?: string } = {},
): Promise<number> {
  const { rows } = await tx.query<VolumeRow>(
    `SELECT ${columns.split(', ').map((c) => `v.${c.trim()}`).join(', ')} FROM sandbox_volumes v LEFT JOIN nodes n ON n.id = v.node_id
      WHERE v.state = 'deleting' AND ($1::text IS NULL OR v.id = $1)
        AND (n.id IS NULL OR n.deleted_at IS NOT NULL OR n.provision_state = 'retired'
             OR (n.generation > COALESCE(v.deleting_generation, -1) AND n.observed_generation >= n.generation))
      ORDER BY v.deleting_at LIMIT 100 FOR UPDATE OF v SKIP LOCKED`,
    [options.onlyId ?? null],
  );
  for (const row of rows) {
    if (row.allocation_id && deps.capacity) await deps.capacity.release(tx, row.allocation_id);
    await tx.query(`UPDATE sandbox_volumes SET state = 'deleted', deleted_at = compute_now(), version = version + 1 WHERE id = $1`, [row.id]);
    await deps.authz.remove(tx, { type: 'sandbox-volume', id: row.id });
    await deps.events.publish(tx, {
      type: 'sandbox.volume.deleted',
      tenantId: row.tenant_id,
      subject: `sandbox-volume/${row.id}`,
      data: { volumeId: row.id },
    });
  }
  return rows.length;
}

export interface ResizeVolumeInput extends VolumeRef {
  sizeGiB: number;
}

export function parseResizeVolume(raw: unknown): ResizeVolumeInput {
  const input = object(raw, ['tenantId', 'volumeId', 'sizeGiB']);
  return { ...parseVolumeRef({ tenantId: input.tenantId, volumeId: input.volumeId }), sizeGiB: int(input.sizeGiB, 'sizeGiB', 1, maxVolumeGiB) };
}

/**
 * `sandboxVolumes.resize`: grows a volume (never shrinks it; `INVALID_INPUT`), charging the growth to the
 * diskGiB quota and booking it on the volume's host (`CAPACITY_UNAVAILABLE` when the host has no room;
 * nothing changes). bcd grows the file, live in a running guest; the guest's filesystem follows at the next
 * sandbox's first boot (`resize2fs` in its user data).
 */
export async function resizeVolume(
  deps: Pick<InstanceDeps, 'desired' | 'events'>,
  tx: SqlTx,
  input: ResizeVolumeInput,
): Promise<SandboxVolume> {
  const row = await readVolume(tx, input, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Volume ${input.volumeId} not found`);
  if (row.state !== 'ready') throw new ComputeError('INVALID_STATE', `Volume ${row.id} is ${row.state}`);
  const current = Number(row.size_gib);
  if (input.sizeGiB === current) return volumeView(row);
  if (input.sizeGiB < current) fail(`A volume never shrinks: ${row.id} is ${current} GiB`);
  if (!row.allocation_id) throw new ComputeError('INVALID_STATE', `Volume ${row.id} has no disk booking`);
  const grow = { diskGiB: input.sizeGiB - current };
  await chargeQuota(tx, row.tenant_id, row.pool_id, grow);
  const outcome = await resizeAllocation(tx, row.allocation_id, { diskGiB: input.sizeGiB });
  if (outcome.status !== 'resized') {
    await refundQuota(tx, row.tenant_id, row.pool_id, grow);
    throw new ComputeError('CAPACITY_UNAVAILABLE', `Host ${row.node_id} has no room to grow volume ${row.id} to ${input.sizeGiB} GiB`);
  }
  const { rows } = await tx.query<VolumeRow>(
    `UPDATE sandbox_volumes SET size_gib = $2, version = version + 1 WHERE id = $1 RETURNING ${columns}`,
    [row.id, input.sizeGiB],
  );
  if (row.node_id) await deps.desired.invalidate(tx, row.node_id);
  await deps.events.publish(tx, {
    type: 'sandbox.volume.resized',
    tenantId: row.tenant_id,
    subject: `sandbox-volume/${row.id}`,
    data: { volumeId: row.id, fromGiB: current, sizeGiB: input.sizeGiB },
  });
  return volumeView(rows[0]!);
}

/**
 * A deleted tenant's volumes (§12.8), once none of its instances is left: every ready one leaves its host's
 * spec, as `deleteVolume` would (templates are deleted by then). Answers whether any is not yet `deleted`.
 */
export async function deleteTenantVolumes(
  deps: Pick<InstanceDeps, 'desired' | 'work'>,
  tx: SqlTx,
  tenantId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string; node_id: string | null }>(
    `UPDATE sandbox_volumes v
        SET state = 'deleting', deleting_at = compute_now(), version = v.version + 1,
            deleting_generation = (SELECT generation FROM nodes WHERE id = v.node_id)
      WHERE v.tenant_id = $1 AND v.state = 'ready' RETURNING v.id, v.node_id`,
    [tenantId],
  );
  for (const node of new Set(rows.map((row) => row.node_id).filter((id): id is string => id !== null)))
    await deps.desired.invalidate(tx, node);
  for (const row of rows) await deps.work.enqueue(tx, volumeWork, row.id);
  const left = await tx.query(`SELECT 1 FROM sandbox_volumes WHERE tenant_id = $1 AND state <> 'deleted' LIMIT 1`, [tenantId]);
  return left.rows.length > 0;
}

// --- Attachments and placement -----------------------------------------------------------------------

/**
 * Attaches a template's volumes to a new instance (its `createManagedInstance`), in order, under the
 * volumes' row locks: each must still be ready, and a read-write attachment needs the volume to itself
 * (no other live instance attaches it at all), while read-only ones share it with other read-only ones.
 */
export async function attachTemplateVolumes(tx: SqlTx, instanceId: string, volumes: readonly TemplateVolume[]): Promise<void> {
  for (const [position, volume] of volumes.entries()) {
    const { rows } = await tx.query<{ state: VolumeState }>(`SELECT state FROM sandbox_volumes WHERE id = $1 FOR UPDATE`, [volume.volumeId]);
    if (rows[0]?.state !== 'ready') throw new ComputeError('INVALID_STATE', `Volume ${volume.volumeId} is ${rows[0]?.state ?? 'gone'}`);
    const others = (await liveAttachments(tx, volume.volumeId)).filter((a) => a.instance_id !== instanceId);
    if (others.length > 0 && (!volume.readOnly || others.some((other) => !other.read_only)))
      throw new ComputeError(
        'CONFLICT',
        `Volume ${volume.volumeId} is attached ${others.some((o) => !o.read_only) ? 'read-write' : 'read-only'} by ${others.map((o) => o.instance_id).join(', ')}: a read-write attachment has it alone`,
        undefined,
        { reason: 'volume-in-use', volumeId: volume.volumeId },
      );
    await tx.query(
      `INSERT INTO volume_attachments (instance_id, volume_id, position, read_only, mount_path) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (instance_id, volume_id) DO NOTHING`,
      [instanceId, volume.volumeId, position, volume.readOnly, volume.mountPath],
    );
  }
}

/** The label of a bcd that keeps host volumes (capability `instance.volumes`, 82f4f51): an older one drops them. */
export const volumesCapabilityLabel = 'bc.dev/cap.instance.volumes';

/**
 * Where an instance that attaches volumes may run: the one host they live on (`onlyNodes`), and only while
 * that host's bcd keeps volumes (`volumesCapabilityLabel`). `undefined` for an instance without volumes;
 * `INVALID_STATE` when its volumes live on different hosts, or on none.
 */
export async function volumePlacement(
  tx: SqlTx,
  instanceId: string,
): Promise<{ onlyNodes: string[]; nodeLabels: Record<string, string> } | undefined> {
  const { rows } = await tx.query<{ node_id: string | null }>(
    `SELECT DISTINCT v.node_id FROM volume_attachments va JOIN sandbox_volumes v ON v.id = va.volume_id WHERE va.instance_id = $1`,
    [instanceId],
  );
  if (rows.length === 0) return undefined;
  if (rows.length > 1 || rows[0]!.node_id === null)
    throw new ComputeError('INVALID_STATE', `Instance ${instanceId} attaches volumes that live on different hosts`);
  return { onlyNodes: [rows[0]!.node_id], nodeLabels: { [volumesCapabilityLabel]: '*' } };
}

/** The mounts a sandbox's user data carries for its attachments (by serial, in attach order). */
export async function attachmentMounts(tx: SqlTx, instanceId: string): Promise<{ serial: string; mountPath: string; readOnly: boolean }[]> {
  const { rows } = await tx.query<{ serial: string; mount_path: string; read_only: boolean }>(
    `SELECT v.serial, va.mount_path, va.read_only FROM volume_attachments va JOIN sandbox_volumes v ON v.id = va.volume_id
      WHERE va.instance_id = $1 ORDER BY va.position`,
    [instanceId],
  );
  return rows.map((row) => ({ serial: row.serial, mountPath: row.mount_path, readOnly: row.read_only }));
}

/** The mounts for a template's volumes before the instance exists (its user data is rendered first). */
export async function templateVolumeMounts(tx: SqlTx, volumes: readonly TemplateVolume[]): Promise<{ serial: string; mountPath: string; readOnly: boolean }[]> {
  const mounts = [];
  for (const volume of volumes) {
    const { rows } = await tx.query<{ serial: string }>(`SELECT serial FROM sandbox_volumes WHERE id = $1`, [volume.volumeId]);
    if (!rows[0]) throw new ComputeError('INVALID_STATE', `Volume ${volume.volumeId} is gone`);
    mounts.push({ serial: rows[0].serial, mountPath: volume.mountPath, readOnly: volume.readOnly });
  }
  return mounts;
}

/**
 * The cloud-config lines that format (once, and never a read-only volume) and mount a sandbox's volumes by
 * serial: `fs_setup` with `overwrite: false` leaves an existing filesystem alone, so a volume keeps its data
 * across sandboxes. `nofail`, so a guest still boots when a volume is missing.
 */
export function volumeCloudConfig(mounts: readonly { serial: string; mountPath: string; readOnly: boolean }[]): string[] {
  if (mounts.length === 0) return [];
  const text = (value: string) => JSON.stringify(value);
  const device = (serial: string) => `/dev/disk/by-id/virtio-${serial}`;
  const lines: string[] = [];
  const writable = mounts.filter((mount) => !mount.readOnly);
  if (writable.length > 0) {
    lines.push('fs_setup:');
    for (const mount of writable)
      lines.push(`  - label: ${text(mount.serial.slice(0, 16))}`, '    filesystem: "ext4"', `    device: ${text(device(mount.serial))}`, '    overwrite: false');
  }
  lines.push('mounts:');
  for (const mount of mounts)
    lines.push(`  - [${text(device(mount.serial))}, ${text(mount.mountPath)}, "ext4", ${text(`defaults,nofail${mount.readOnly ? ',ro' : ''}`)}, "0", "2"]`);
  return lines;
}

/**
 * The `runcmd` entries (YAML flow lists) that grow each writable volume's filesystem to its disk at the
 * guest's first boot, after it is mounted: a volume grown since the last sandbox (`sandboxVolumes.resize`)
 * then shows its full size. ext4 grows online; a failure never stops the boot.
 */
export function volumeRuncmd(mounts: readonly { serial: string; readOnly: boolean }[]): string[] {
  return mounts
    .filter((mount) => !mount.readOnly)
    .map((mount) => `  - ["sh", "-c", ${JSON.stringify(`resize2fs /dev/disk/by-id/virtio-${mount.serial} || true`)}]`);
}

// --- Specs -------------------------------------------------------------------------------------------

/** NodeSpec `volumes`: the ready volumes that live on `nodeId` (a deleting one is left out: bcd destroys it). */
export async function hostVolumeSpecs(tx: SqlTx, nodeId: string): Promise<HostVolumeSpec[]> {
  const { rows } = await tx.query<{ id: string; size_gib: number; serial: string }>(
    `SELECT id, size_gib, serial FROM sandbox_volumes WHERE node_id = $1 AND state = 'ready' ORDER BY id`,
    [nodeId],
  );
  return rows.map((row) => ({ id: row.id, sizeBytes: Number(row.size_gib) * GiB, serial: row.serial }));
}

/** InstanceSpec `volumes` of the instances on a node, by instance id, in attach order. */
export async function instanceVolumeSpecs(tx: SqlTx, instanceIds: readonly string[]): Promise<Map<string, NonNullable<InstanceSpec['volumes']>>> {
  const out = new Map<string, NonNullable<InstanceSpec['volumes']>>();
  if (instanceIds.length === 0) return out;
  const { rows } = await tx.query<{ instance_id: string; volume_id: string; read_only: boolean }>(
    `SELECT instance_id, volume_id, read_only FROM volume_attachments WHERE instance_id = ANY($1::text[]) ORDER BY instance_id, position`,
    [[...instanceIds]],
  );
  for (const row of rows) {
    const list = out.get(row.instance_id) ?? [];
    list.push({ volumeId: row.volume_id, ...(row.read_only ? { readOnly: true } : {}) });
    out.set(row.instance_id, list);
  }
  return out;
}

// --- Metering ----------------------------------------------------------------------------------------

/** `vps.volume.gib.hours` for every volume, from its booking until it is released (the `vps.usage` job). */
export async function meterVolumes(tx: SqlTx, now: number, options: { lookbackMs?: number } = {}): Promise<number> {
  const lookback = options.lookbackMs ?? 48 * hourMs;
  const { rows } = await tx.query<{
    allocation_id: string;
    tenant_id: string;
    created_by: string;
    pool_id: string;
    region: string;
    size_gib: number;
    from_ms: number;
    to_ms: number | null;
  }>(
    `SELECT a.id AS allocation_id, v.tenant_id, v.created_by, v.pool_id, s.region, v.size_gib,
            (extract(epoch FROM lower(a.during)) * 1000)::float8 AS from_ms,
            (extract(epoch FROM a.released_at) * 1000)::float8 AS to_ms
       FROM sandbox_volumes v
       JOIN allocations a ON a.id = v.allocation_id AND a.owner_kind = 'volume'
       JOIN pools p ON p.id = v.pool_id JOIN sites s ON s.id = p.site_id
      WHERE lower(a.during) < $1::timestamptz
        AND (a.released_at IS NULL OR a.released_at > $1::timestamptz - make_interval(secs => $2 / 1000.0))
      ORDER BY a.id LIMIT 5000`,
    [new Date(now).toISOString(), lookback],
  );
  let windows = 0;
  for (const row of rows)
    windows += await meterAllocation(
      tx,
      {
        allocationId: row.allocation_id,
        tenantId: row.tenant_id,
        identityId: row.created_by,
        lines: [{ meter: volumeMeter, perHour: Number(row.size_gib) }],
        tags: { region: row.region, pool: row.pool_id },
        from: Number(row.from_ms),
        to: row.to_ms === null ? Number.POSITIVE_INFINITY : Number(row.to_ms),
      },
      now,
    );
  return windows;
}
