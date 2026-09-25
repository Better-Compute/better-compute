import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  CachedImageSchema,
  CachedImageState,
  ImagesSectionSchema,
  INVENTORY_SECTIONS,
  OsSectionSchema,
  SystemSectionSchema,
  type InventorySectionName,
} from '@better-compute/protocol';
import { applyInventory, imageCacheNodes, ingestInventorySection, recordInventoryHashes, sha256Hex } from '@better-compute/inventory';

// The `images` inventory section → node_image_cache (PLAN.md §10.3 `image-cached` scorer): kept by
// diff on every inventory change; the scorer's read skips tenant-controlled and deleted nodes.

let db: SqlExecutor;
const work: WorkQueue = { async enqueue() {} };
const digest = (name: string) => new Uint8Array(createHash('sha256').update(name).digest());
const image = (name: string, state: CachedImageState, imageId = '') =>
  create(CachedImageSchema, {
    imageId,
    ref: `https://images.example.com/${name}.qcow2`,
    sha256: digest(name),
    sizeBytes: 2n * 1024n ** 3n,
    state,
    lastUsed: { seconds: BigInt(Date.UTC(2026, 8, 24, 12) / 1000), nanos: 0 },
  });
const encode = {
  system: (serial: string) => toBinary(SystemSectionSchema, create(SystemSectionSchema, { productUuid: '4c4c4544-0042-3510-8052-b7c04f4b3732', serial })),
  os: () => toBinary(OsSectionSchema, create(OsSectionSchema, { distro: 'ubuntu', kernel: '6.8.0', kvm: true })),
  images: (...images: ReturnType<typeof image>[]) => toBinary(ImagesSectionSchema, create(ImagesSectionSchema, { images, capacityBytes: 500n * 1024n ** 3n })),
};

async function report(nodeId: string, sections: Partial<Record<InventorySectionName, Uint8Array>>) {
  const hashes = Object.fromEntries(Object.entries(sections).map(([name, bytes]) => [name, sha256Hex(bytes!)]));
  const requested = await db.transaction((tx) => recordInventoryHashes(tx, work, nodeId, hashes, { bootId: 'boot-1' }));
  for (const name of requested) {
    const content = sections[name]!;
    await db.transaction((tx) => ingestInventorySection(tx, work, nodeId, { section: name, content, sha256: sha256Hex(content) }));
  }
  return applyInventory(db, nodeId);
}

async function addNode(id: string, trust = 'platform') {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', 'pool_v', 'ten_root', 'host', 'adopted', false, false, 'connected', $2, 1, 1, 1, 0, 0, 1)`,
    [id, trust],
  );
}
const cached = async (nodeId: string) =>
  (
    await db.query<{ image_id: string | null; state: string; size_bytes: string }>(
      `SELECT image_id, state, size_bytes::text FROM node_image_cache WHERE node_id = $1 ORDER BY encode(sha256, 'hex')`,
      [nodeId],
    )
  ).rows;

beforeAll(async () => {
  db = pglite({ analyzeEveryMs: 0 });
  await db.migrate();
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'ten_root', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_v', 'ten_root', 'site_a', 'vps-host', 'exclusive', 'bcd', '{}', 1)`,
  );
});
afterAll(() => db.close());

describe('the images section', () => {
  it('is a NodeInventory section', () => {
    expect(INVENTORY_SECTIONS).toContain('images');
  });

  it('fills node_image_cache, then follows it by diff', async () => {
    const node = 'node_0000000000000000000000img1';
    await addNode(node);
    await report(node, {
      system: encode.system('S1'),
      os: encode.os(),
      images: encode.images(image('ubuntu', CachedImageState.READY, 'img_ubuntu'), image('debian', CachedImageState.PULLING, 'img_debian')),
    });
    expect(await cached(node)).toEqual(
      expect.arrayContaining([
        { image_id: 'img_ubuntu', state: 'ready', size_bytes: String(2 * 1024 ** 3) },
        { image_id: 'img_debian', state: 'pulling', size_bytes: String(2 * 1024 ** 3) },
      ]),
    );
    // debian finished pulling, ubuntu was evicted, an anonymous image appeared.
    await report(node, {
      system: encode.system('S1'),
      os: encode.os(),
      images: encode.images(image('debian', CachedImageState.READY, 'img_debian'), image('scratch', CachedImageState.READY)),
    });
    const rows = await cached(node);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([{ image_id: 'img_debian', state: 'ready', size_bytes: String(2 * 1024 ** 3) }, expect.objectContaining({ image_id: null })]));
    // No section any more: no known cache.
    await report(node, { system: encode.system('S1'), os: encode.os() });
    expect(await cached(node)).toEqual([]);
  });

  it('answers the scorer with ready images of usable nodes only', async () => {
    const warm = 'node_0000000000000000000000img2';
    const pulling = 'node_0000000000000000000000img3';
    const lessee = 'node_0000000000000000000000img4';
    await addNode(warm);
    await addNode(pulling);
    await addNode(lessee, 'tenant-controlled');
    await report(warm, { system: encode.system('S2'), images: encode.images(image('ubuntu', CachedImageState.READY, 'img_ubuntu')) });
    await report(pulling, { system: encode.system('S3'), images: encode.images(image('ubuntu', CachedImageState.PULLING, 'img_ubuntu')) });
    await report(lessee, { system: encode.system('S4'), images: encode.images(image('ubuntu', CachedImageState.READY, 'img_ubuntu')) });
    const ready = await imageCacheNodes(db, { poolId: 'pool_v', imageId: 'img_ubuntu' });
    expect(ready.map((entry) => entry.nodeId)).toEqual([warm]);
    const byDigest = await imageCacheNodes(db, { poolId: 'pool_v', sha256: Buffer.from(digest('ubuntu')).toString('hex'), states: ['ready', 'pulling'] });
    expect(byDigest.map((entry) => entry.nodeId).sort()).toEqual([pulling, warm].sort());
    // [13084d]'s scorer query reads the table directly, in this shape.
    const scorer = await db.query<{ node_id: string }>(
      `SELECT c.node_id FROM node_image_cache c JOIN nodes n ON n.id = c.node_id WHERE n.pool_id = $1 AND c.image_id = $2 AND c.state = 'ready'`,
      ['pool_v', 'img_ubuntu'],
    );
    expect(scorer.rows.map((row) => row.node_id).sort()).toEqual([lessee, warm].sort());
  });
});
