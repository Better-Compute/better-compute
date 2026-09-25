import type { Migration } from '@better-compute/core';

/**
 * Per-node image caches (PLAN.md §10.3 `image-cached` scorer). Inventory ingestion keeps these rows
 * from the node's `images` section by diff, like devices: what the node's runtime holds locally,
 * by content digest. `ready` means the runtime has the image and can boot it now. Tenant-controlled
 * nodes' rows are advisory, and placement never reads them. Additive only.
 */
export const imageCacheMigration: Migration = {
  name: 'core/0013_image_cache',
  sql: `
CREATE TABLE node_image_cache (
  node_id text NOT NULL REFERENCES nodes,
  sha256 bytea NOT NULL CHECK (length(sha256) = 32),
  -- The catalog image (provision images.id) the node pulled it for, when it knows it.
  image_id text,
  ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'pulling', 'evicting')),
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  -- Truncated to the hour by the node.
  last_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (node_id, sha256)
);
CREATE INDEX node_image_cache_image ON node_image_cache (image_id, node_id) WHERE image_id IS NOT NULL;
`,
};

/** The tables `core/0013_image_cache` creates. */
export const imageCacheTables = ['node_image_cache'] as const;
