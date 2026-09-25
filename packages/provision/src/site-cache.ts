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
