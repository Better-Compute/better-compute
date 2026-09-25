import type { SiteSpec, SqlTx } from '@better-compute/core';
import { resolveImageRef, verifyImageForUse, type ImageUseOptions } from './images.js';

// Site cache pre-warm (PLAN.md §11.5): "site caches pull on demand, pre-warm per pool policy and
// re-verify before serving". A pool names the images its machines deploy in `policy.prewarmImages`
// (`name@version` refs, resolved in the pool owner's catalog); the site agents of the pool's site get
// them as desired state (NodeSpec `site.cacheImages`), pull them ahead of the first deploy and check
// each digest before serving it. Only images that still verify (signed, signer not revoked; §11.5
// and the v0.2 exit "unsigned images are rejected") are ever pre-warmed.

/** The pre-warm list of a site agent: every verified image its site's live pools name, by URL. */
export async function siteCacheImagesFor(
  tx: SqlTx,
  nodeId: string,
  options: ImageUseOptions = {},
): Promise<NonNullable<SiteSpec['cacheImages']>> {
  const { rows } = await tx.query<{ tenant_id: string; ref: string }>(
    `SELECT DISTINCT p.owner_tenant_id AS tenant_id, ref
       FROM nodes agent
       JOIN pools p ON p.site_id = agent.site_id AND p.archived_at IS NULL
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(p.policy->'prewarmImages') = 'array' THEN p.policy->'prewarmImages' ELSE '[]'::jsonb END) AS ref
      WHERE agent.id = $1 AND agent.role = 'site'
      ORDER BY 1, 2`,
    [nodeId],
  );
  const images = new Map<string, NonNullable<SiteSpec['cacheImages']>[number]>();
  for (const row of rows) {
    const resolved = await resolveImageRef(tx, row.tenant_id, row.ref);
    if (!resolved) continue;
    try {
      const image = await verifyImageForUse(tx, resolved, options);
      images.set(image.source, { url: image.source, sha256: image.sha256, format: image.format });
    } catch {
      // Unsigned, revoked or tampered: never pre-warmed (a deploy of it is refused as well).
    }
  }
  return [...images.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * Derives a site's `image_locations` from what its site agents' caches hold (their `images`
 * inventory sections, stored per node in `node_image_cache`): a catalog image whose digest a live
 * site agent holds is at the site, `ready` if any agent has it ready, else `pulling` or `evicting`.
 * Locations no agent holds any more go, unless a deploy pinned them. Inventory queues this
 * (`provision.site-cache`, key = site id) whenever a site agent's cache changes. Returns the rows
 * written and removed.
 */
export async function syncSiteImageLocations(tx: SqlTx, siteId: string): Promise<{ upserted: number; removed: number }> {
  const { rows } = await tx.query<{ upserted: string; removed: string }>(
    `WITH cache AS (
       SELECT i.id AS image_id,
              CASE WHEN bool_or(c.state = 'ready') THEN 'ready' WHEN bool_or(c.state = 'pulling') THEN 'pulling' ELSE 'evicting' END AS state,
              max(c.size_bytes) AS size_bytes
         FROM nodes agent
         JOIN node_image_cache c ON c.node_id = agent.id
         JOIN images i ON i.sha256 = encode(c.sha256, 'hex') AND i.deleted_at IS NULL
        WHERE agent.site_id = $1 AND agent.role = 'site' AND agent.deleted_at IS NULL
        GROUP BY i.id),
     up AS (
       INSERT INTO image_locations (image_id, site_id, state, size_bytes)
       SELECT image_id, $1, state, size_bytes FROM cache
       ON CONFLICT (image_id, site_id) DO UPDATE SET state = EXCLUDED.state, size_bytes = EXCLUDED.size_bytes,
         updated_at = compute_now()
       WHERE (image_locations.state, image_locations.size_bytes) IS DISTINCT FROM (EXCLUDED.state, EXCLUDED.size_bytes)
       RETURNING 1),
     gone AS (
       DELETE FROM image_locations l
        WHERE l.site_id = $1 AND NOT l.pinned AND NOT EXISTS (SELECT 1 FROM cache WHERE cache.image_id = l.image_id)
       RETURNING 1)
     SELECT (SELECT count(*) FROM up)::text AS upserted, (SELECT count(*) FROM gone)::text AS removed`,
    [siteId],
  );
  return { upserted: Number(rows[0]?.upserted ?? 0), removed: Number(rows[0]?.removed ?? 0) };
}

/**
 * Invalidates the NodeSpec of every site agent whose site has a pool naming `ref` in
 * `policy.prewarmImages` (after an image is registered or promoted, its pre-warm lists change).
 */
export async function invalidateSiteCaches(
  tx: SqlTx,
  desired: { invalidate(tx: SqlTx, nodeId: string): Promise<void> } | undefined,
  ref: string,
): Promise<number> {
  if (!desired) return 0;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT DISTINCT agent.id FROM pools p
       JOIN nodes agent ON agent.site_id = p.site_id AND agent.role = 'site' AND agent.deleted_at IS NULL
      WHERE p.archived_at IS NULL AND jsonb_typeof(p.policy->'prewarmImages') = 'array'
        AND p.policy->'prewarmImages' ? $1
      ORDER BY agent.id`,
    [ref],
  );
  for (const row of rows) await desired.invalidate(tx, row.id);
  return rows.length;
}
