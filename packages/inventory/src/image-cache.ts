import type { SqlTx } from '@better-compute/core';
import { CachedImageState, type ImagesSection } from '@better-compute/protocol';

// Per-node image caches (PLAN.md §10.3 `image-cached` scorer): inventory keeps `node_image_cache`
// in step with each node's `images` section, by diff like devices. A node that stops reporting the
// section has no known cache. Placement reads only ready images of schedulable, platform or
// tenant-owned nodes: a tenant-controlled node's inventory is advisory (§10.2).

export type CachedImageStateName = 'ready' | 'pulling' | 'evicting';

export interface CachedImageRow {
  sha256: string;
  imageId: string | null;
  ref: string;
  state: CachedImageStateName;
  sizeBytes: number;
  lastUsedAt: Date | null;
}

const stateNames: Readonly<Record<number, CachedImageStateName>> = {
  [CachedImageState.READY]: 'ready',
  [CachedImageState.PULLING]: 'pulling',
  [CachedImageState.EVICTING]: 'evicting',
};

/** The rows an `images` section stands for: entries without a 32-byte digest or a known state are dropped. */
export function imageCacheRows(section: ImagesSection | undefined): CachedImageRow[] {
  const rows = new Map<string, CachedImageRow>();
  for (const image of section?.images ?? []) {
    const state = stateNames[image.state];
    if (!state || image.sha256.byteLength !== 32) continue;
    const sha256 = Buffer.from(image.sha256).toString('hex');
    rows.set(sha256, {
      sha256,
      imageId: image.imageId || null,
      ref: image.ref,
      state,
      sizeBytes: Number(image.sizeBytes),
      lastUsedAt: image.lastUsed ? new Date(Number(image.lastUsed.seconds) * 1000) : null,
    });
  }
  return [...rows.values()];
}

/** Syncs `node_image_cache` for a node to its section (inside the inventory transaction). */
export async function applyImageCache(
  tx: SqlTx,
  nodeId: string,
  section: ImagesSection | undefined,
): Promise<{ upserted: number; removed: number }> {
  const rows = imageCacheRows(section);
  let upserted = 0;
  if (rows.length > 0) {
    // One statement for the whole section (imageCacheRows already made the digests unique).
    const { rowCount } = await tx.query(
      `INSERT INTO node_image_cache (node_id, sha256, image_id, ref, state, size_bytes, last_used_at)
       SELECT $1, decode(i.sha256, 'hex'), i.image_id, i.ref, i.state, i.size_bytes, i.last_used_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::timestamptz[])
              AS i(sha256, image_id, ref, state, size_bytes, last_used_at)
       ON CONFLICT (node_id, sha256) DO UPDATE SET image_id = EXCLUDED.image_id, ref = EXCLUDED.ref,
         state = EXCLUDED.state, size_bytes = EXCLUDED.size_bytes, last_used_at = EXCLUDED.last_used_at,
         updated_at = compute_now()
       WHERE (node_image_cache.image_id, node_image_cache.ref, node_image_cache.state, node_image_cache.size_bytes, node_image_cache.last_used_at)
             IS DISTINCT FROM (EXCLUDED.image_id, EXCLUDED.ref, EXCLUDED.state, EXCLUDED.size_bytes, EXCLUDED.last_used_at)`,
      [
        nodeId,
        rows.map((row) => row.sha256),
        rows.map((row) => row.imageId),
        rows.map((row) => row.ref),
        rows.map((row) => row.state),
        rows.map((row) => row.sizeBytes),
        rows.map((row) => row.lastUsedAt),
      ],
    );
    upserted = rowCount ?? 0;
  }
  const { rowCount: removed } = await tx.query(
    `DELETE FROM node_image_cache WHERE node_id = $1 AND NOT (encode(sha256, 'hex') = ANY($2::text[]))`,
    [nodeId, rows.map((row) => row.sha256)],
  );
  return { upserted, removed: removed ?? 0 };
}

export interface ImageCacheNode {
  nodeId: string;
  sha256: string;
  state: CachedImageStateName;
  sizeBytes: number;
  lastUsedAt: Date | null;
}

/**
 * Nodes of a pool whose cache holds an image (by catalog id or digest), ready ones by default: what
 * the `image-cached` scorer prefers. Deleted nodes and tenant-controlled ones (advisory inventory)
 * never count.
 */
export async function imageCacheNodes(
  tx: SqlTx,
  query: { poolId: string; imageId?: string; sha256?: string; states?: readonly CachedImageStateName[] },
): Promise<ImageCacheNode[]> {
  if (!query.imageId && !query.sha256) return [];
  const { rows } = await tx.query<{ node_id: string; sha256: string; state: CachedImageStateName; size_bytes: unknown; last_used_at: Date | null }>(
    `SELECT c.node_id, encode(c.sha256, 'hex') AS sha256, c.state, c.size_bytes, c.last_used_at
       FROM node_image_cache c JOIN nodes n ON n.id = c.node_id
      WHERE n.pool_id = $1 AND n.deleted_at IS NULL AND n.trust <> 'tenant-controlled'
        AND ($2::text IS NULL OR c.image_id = $2) AND ($3::text IS NULL OR c.sha256 = decode($3, 'hex'))
        AND c.state = ANY($4::text[])
      ORDER BY c.last_used_at DESC NULLS LAST, c.node_id`,
    [query.poolId, query.imageId ?? null, query.sha256 ?? null, [...(query.states ?? ['ready'])]],
  );
  return rows.map((row) => ({
    nodeId: row.node_id,
    sha256: row.sha256,
    state: row.state,
    sizeBytes: Number(row.size_bytes),
    lastUsedAt: row.last_used_at,
  }));
}
