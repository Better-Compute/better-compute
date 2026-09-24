import { ComputeError, newId, type SqlTx } from '@better-compute/core';
import { int, name, object, optional, tenant, id as poolIdOf } from './input.js';

// Flavors (§3.6, §11.4): named instance shapes per pool. Hosted pools place them as scalar claims
// (and GPU atoms); provider pools map each to a provider offer.

/** A stored flavor. */
export interface FlavorRecord {
  id: string;
  poolId: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus: number;
  /** Provider pools: the offer this flavor creates. */
  offerId?: string;
  archived: boolean;
  version: number;
}

interface RawFlavor {
  id: string;
  pool_id: string;
  name: string;
  vcpu: number;
  memory_gib: number;
  disk_gib: number;
  gpus: number;
  offer_id: string | null;
  archived: boolean;
  version: string | number;
}

function toFlavor(row: RawFlavor): FlavorRecord {
  const flavor: FlavorRecord = {
    id: row.id,
    poolId: row.pool_id,
    name: row.name,
    vcpu: Number(row.vcpu),
    memoryGiB: Number(row.memory_gib),
    diskGiB: Number(row.disk_gib),
    gpus: Number(row.gpus),
    archived: row.archived,
    version: Number(row.version),
  };
  if (row.offer_id !== null) flavor.offerId = row.offer_id;
  return flavor;
}

const columns = `id, pool_id, name, vcpu, memory_gib, disk_gib, gpus, offer_id, archived, version`;

export async function readFlavors(
  tx: SqlTx,
  poolId: string,
  includeArchived = false,
): Promise<FlavorRecord[]> {
  const { rows } = await tx.query<RawFlavor>(
    `SELECT ${columns} FROM flavors WHERE pool_id = $1 ${includeArchived ? '' : 'AND NOT archived'} ORDER BY name`,
    [poolId],
  );
  return rows.map(toFlavor);
}

export async function readFlavorByName(
  tx: SqlTx,
  poolId: string,
  flavorName: string,
): Promise<FlavorRecord | undefined> {
  const { rows } = await tx.query<RawFlavor>(
    `SELECT ${columns} FROM flavors WHERE pool_id = $1 AND name = $2`,
    [poolId, flavorName],
  );
  return rows[0] ? toFlavor(rows[0]) : undefined;
}

/** A pool the tenant owns (flavors are managed by the pool's owner). */
export async function assertOwnedPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<{ class: string; agent: string; gpuModel?: string }> {
  const { rows } = await tx.query<{ class: string; agent: string; gpu_model: string | null }>(
    `SELECT class, agent, gpu_model FROM pools WHERE id = $1 AND owner_tenant_id = $2`,
    [poolId, tenantId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  const pool: { class: string; agent: string; gpuModel?: string } = {
    class: rows[0].class,
    agent: rows[0].agent,
  };
  if (rows[0].gpu_model !== null) pool.gpuModel = rows[0].gpu_model;
  return pool;
}

export interface FlavorInput {
  tenantId: string;
  poolId: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus: number;
  offerId?: string;
}

export function parseFlavorInput(raw: unknown): FlavorInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'name',
    'vcpu',
    'memoryGiB',
    'diskGiB',
    'gpus',
    'offerId',
  ]);
  const result: FlavorInput = {
    tenantId: tenant(input.tenantId),
    poolId: poolIdOf(input.poolId, 'pool', 'poolId'),
    name: name(input.name, 'name'),
    vcpu: int(input.vcpu, 'vcpu', 1, 1024),
    memoryGiB: int(input.memoryGiB, 'memoryGiB', 1, 16_384),
    diskGiB: int(input.diskGiB, 'diskGiB', 1, 65_536),
    gpus: optional(input.gpus, (value) => int(value, 'gpus', 0, 16)) ?? 0,
  };
  const offerId = optional(input.offerId, (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128)
      throw new ComputeError('INVALID_INPUT', 'offerId is invalid');
    return value;
  });
  if (offerId !== undefined) result.offerId = offerId;
  return result;
}

/** Creates a flavor; a provider pool's flavor names the provider offer it creates. */
export async function createFlavor(tx: SqlTx, input: FlavorInput): Promise<FlavorRecord> {
  const pool = await assertOwnedPool(tx, input.tenantId, input.poolId);
  if (pool.class !== 'vps-host' && pool.class !== 'provider')
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${input.poolId} is ${pool.class}, not a VPS pool`,
    );
  if (pool.class === 'provider' && input.offerId === undefined)
    throw new ComputeError('INVALID_INPUT', 'A provider pool flavor needs offerId');
  const flavorId = newId('flv');
  const { rowCount } = await tx.query(
    `INSERT INTO flavors (id, pool_id, name, vcpu, memory_gib, disk_gib, gpus, offer_id, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) ON CONFLICT (pool_id, name) DO NOTHING`,
    [
      flavorId,
      input.poolId,
      input.name,
      input.vcpu,
      input.memoryGiB,
      input.diskGiB,
      input.gpus,
      input.offerId ?? null,
    ],
  );
  if (rowCount === 0)
    throw new ComputeError(
      'CONFLICT',
      `Flavor ${input.name} already exists in pool ${input.poolId}`,
    );
  return (await readFlavorByName(tx, input.poolId, input.name))!;
}

/** Updates a flavor's shape. Live instances keep the shape they were admitted with. */
export async function updateFlavor(tx: SqlTx, input: FlavorInput): Promise<FlavorRecord> {
  await assertOwnedPool(tx, input.tenantId, input.poolId);
  const { rowCount } = await tx.query(
    `UPDATE flavors SET vcpu = $3, memory_gib = $4, disk_gib = $5, gpus = $6, offer_id = COALESCE($7, offer_id),
                        archived = false, version = version + 1
      WHERE pool_id = $1 AND name = $2`,
    [
      input.poolId,
      input.name,
      input.vcpu,
      input.memoryGiB,
      input.diskGiB,
      input.gpus,
      input.offerId ?? null,
    ],
  );
  if (rowCount === 0) throw new ComputeError('NOT_FOUND', `Flavor ${input.name} not found`);
  return (await readFlavorByName(tx, input.poolId, input.name))!;
}

/** Deletes an unused flavor, or archives one that instances still reference. */
export async function deleteFlavor(
  tx: SqlTx,
  input: { tenantId: string; poolId: string; name: string },
): Promise<{ deleted: boolean; archived: boolean }> {
  await assertOwnedPool(tx, input.tenantId, input.poolId);
  const flavor = await readFlavorByName(tx, input.poolId, input.name);
  if (!flavor) throw new ComputeError('NOT_FOUND', `Flavor ${input.name} not found`);
  const used = await tx.query(`SELECT 1 FROM instances WHERE flavor_id = $1 LIMIT 1`, [flavor.id]);
  if (used.rows.length > 0) {
    await tx.query(`UPDATE flavors SET archived = true, version = version + 1 WHERE id = $1`, [
      flavor.id,
    ]);
    return { deleted: false, archived: true };
  }
  await tx.query(`DELETE FROM flavors WHERE id = $1`, [flavor.id]);
  return { deleted: true, archived: false };
}
