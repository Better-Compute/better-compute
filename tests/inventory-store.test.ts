import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventPublisher, SqlExecutor, SqlTx, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  GpuSchema,
  GpusSectionSchema,
  NicSchema,
  NicsSectionSchema,
  OsSectionSchema,
  SystemSectionSchema,
  type InventorySectionName,
} from '@better-compute/protocol';
import {
  applyInventory,
  gpuAtomFamily,
  ingestInventorySection,
  ingestInventorySections,
  inventoryHygieneReconciler,
  inventoryModule,
  inventoryReconciler,
  latestInventory,
  recordInventoryHashes,
  recordInventoryHashesMany,
  sha256Hex,
} from '@better-compute/inventory';

// The Inventory reconciler's storage side on PGlite (PLAN.md §10.1): report → pull → apply.

let db: SqlExecutor;
const enqueued: string[] = [];
const work: WorkQueue = {
  async enqueue(tx, kind, key) {
    enqueued.push(`${kind}:${key}`);
    await tx.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before) VALUES ($1, $2, 0, 1, compute_now())
       ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1`,
      [kind, key],
    );
  },
};
const published: { type: string; subject: string; data: unknown }[] = [];
const events: EventPublisher = {
  async publish(tx, event) {
    published.push({ type: event.type, subject: event.subject, data: event.data });
    await tx.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [event.type, JSON.stringify(event.data)]);
  },
};

const GiB = 1024n ** 3n;
const gpu = (index: number, name = 'NVIDIA H100 80GB HBM3') =>
  create(GpuSchema, { index, uuid: `GPU-${node}-${index}`, name, vramBytes: 80n * GiB, numaNode: 0 });
const gpusSection = (count: number, name?: string) =>
  create(GpusSectionSchema, {
    driverVersion: '550.90.07',
    cudaDriverVersion: '12.4',
    gpus: Array.from({ length: count }, (_, i) => gpu(i, name)),
  });
const encoded = {
  gpus: (count: number, name?: string) => toBinary(GpusSectionSchema, gpusSection(count, name)),
  system: (serial: string) =>
    toBinary(SystemSectionSchema, create(SystemSectionSchema, { productUuid: '4c4c4544-0042-3510-8052-b7c04f4b3732', serial })),
  nics: (mac: string) => toBinary(NicsSectionSchema, create(NicsSectionSchema, { nics: [create(NicSchema, { name: 'eno1', mac })] })),
  os: () => toBinary(OsSectionSchema, create(OsSectionSchema, { distro: 'ubuntu', kernel: '6.8.0', kvm: true })),
};

/** Runs one Hello + pulls, the way the gateway does: report, then ingest what was requested. */
async function report(nodeId: string, sections: Partial<Record<InventorySectionName, Uint8Array>>) {
  const hashes = Object.fromEntries(Object.entries(sections).map(([name, bytes]) => [name, sha256Hex(bytes!)]));
  const requested = await db.transaction((tx) => recordInventoryHashes(tx, work, nodeId, hashes, { bootId: 'boot-1' }));
  for (const name of requested) {
    const content = sections[name]!;
    await db.transaction((tx) => ingestInventorySection(tx, work, nodeId, { section: name, content, sha256: sha256Hex(content) }));
  }
  return requested;
}

async function addNode(tx: SqlTx, id: string, pool = 'pool_a') {
  await tx.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', $2, 'ten_root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [id, pool],
  );
}

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'ten_root', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_a', 'ten_root', 'site_a', 'metal-host', 'H100', 'exclusive', 'bcd', '{"expect":{"gpuCount":8}}', 1)`,
  );
});
afterAll(() => db.close());

let seq = 0;
let node: string;
beforeEach(async () => {
  node = `node_${++seq}`;
  enqueued.length = 0;
  published.length = 0;
  await db.transaction((tx) => addNode(tx, node));
});

const nodeRow = async (id = node) =>
  (
    await db.query<{ no_schedule_reasons: string[]; hardware_key_trusted: boolean; hardware_key: Uint8Array | null; version: number }>(
      'SELECT no_schedule_reasons, hardware_key_trusted, hardware_key, version FROM nodes WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('report → pull → apply', () => {
  it('requests every section first, then only changed ones', async () => {
    const first = await report(node, { gpus: encoded.gpus(8), os: encoded.os() });
    expect(first).toEqual(['gpus', 'os']);
    expect(enqueued).toEqual([`inventory:${node}`, `inventory:${node}`]);
    const again = await report(node, { gpus: encoded.gpus(8), os: encoded.os() });
    expect(again).toEqual([]);
    const changed = await report(node, { gpus: encoded.gpus(7), os: encoded.os() });
    expect(changed).toEqual(['gpus']);
  });

  it('builds a snapshot, devices, labels and cleared conditions from a complete set', async () => {
    await report(node, { gpus: encoded.gpus(8), os: encoded.os(), system: encoded.system('SER1'), nics: encoded.nics('b8:ce:f6:00:00:01') });
    const result = await applyInventory(db, node, { events });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.devices).toEqual({ upserted: 8, removed: 0, quarantined: 0, claimedElsewhere: [] });

    const devices = await db.query<{ id: string; bookable: boolean; attributes: Record<string, unknown> }>(
      'SELECT id, bookable, attributes FROM devices WHERE node_id = $1 ORDER BY id',
      [node],
    );
    expect(devices.rows).toHaveLength(8);
    expect(devices.rows[0]!.attributes).toMatchObject({ gpuProduct: 'H100-SXM5-80GB', gpuModel: 'H100', vramGiB: 80 });

    const labels = await db.query<{ key: string; value: string }>(
      "SELECT key, value FROM node_labels WHERE node_id = $1 AND source = 'inventory' ORDER BY key",
      [node],
    );
    expect(Object.fromEntries(labels.rows.map((l) => [l.key, l.value]))).toMatchObject({
      'gpu.count': '8',
      'gpu.product': 'H100-SXM5-80GB',
      'os.distro': 'ubuntu',
    });

    const conditions = await db.query<{ type: string; status: string }>(
      'SELECT type, status FROM node_conditions WHERE node_id = $1 ORDER BY type',
      [node],
    );
    expect(conditions.rows).toEqual([
      { type: 'DuplicateIdentity', status: 'false' },
      { type: 'EccUncorrectable', status: 'false' },
      { type: 'GpuCountMismatch', status: 'false' },
      { type: 'GpuModelUnknown', status: 'false' },
      { type: 'NvlinkDegraded', status: 'false' },
      { type: 'RowRemapFailed', status: 'false' },
      { type: 'RowRemapPending', status: 'false' },
    ]);
    const row = await nodeRow();
    expect(row.no_schedule_reasons).toEqual([]);
    expect(row.hardware_key_trusted).toBe(true);

    const snapshot = await latestInventory(db, node);
    expect(snapshot?.hash).toBe(result.digest);
    expect((snapshot?.sections.gpus as { gpus: unknown[] }).gpus).toHaveLength(8);
    expect((snapshot?.sections.gpus as { gpus: { vramBytes: string }[] }).gpus[0]!.vramBytes).toBe(String(80n * GiB));
    expect(published.map((e) => e.type)).toEqual(['node.inventory.changed']);

    // Applying the same set again changes nothing.
    expect((await applyInventory(db, node)).status).toBe('unchanged');
  });

  it('waits for missing sections instead of applying a partial set', async () => {
    const hashes = { gpus: sha256Hex(encoded.gpus(8)), os: sha256Hex(encoded.os()) };
    await db.transaction((tx) => recordInventoryHashes(tx, work, node, hashes));
    const content = encoded.os();
    await db.transaction((tx) => ingestInventorySection(tx, work, node, { section: 'os', content, sha256: sha256Hex(content) }));
    expect(await applyInventory(db, node)).toEqual({ status: 'incomplete', missing: ['gpus'] });
  });

  it('raises GpuCountMismatch as NoSchedule when a GPU falls off the bus, and diffs it', async () => {
    await report(node, { gpus: encoded.gpus(8) });
    await applyInventory(db, node, { events });
    const before = await nodeRow();
    published.length = 0;

    await report(node, { gpus: encoded.gpus(7) });
    const result = await applyInventory(db, node, { events });
    if (result.status !== 'applied') throw new Error(result.status);
    expect(result.changes.map((c) => [c.type, c.deviceId])).toEqual([['gpu.missing', `GPU-${node}-7`]]);
    expect(result.devices).toEqual({ upserted: 0, removed: 1, quarantined: 0, claimedElsewhere: [] });
    const after = await nodeRow();
    expect(after.no_schedule_reasons).toEqual(['GpuCountMismatch']);
    expect(after.version).toBe(before.version + 1);
    expect(published.map((e) => e.type)).toEqual(['node.inventory.changed', 'node.gpu.missing']);

    // The GPU comes back: the condition clears and the reason goes away.
    await report(node, { gpus: encoded.gpus(8) });
    await applyInventory(db, node);
    expect((await nodeRow()).no_schedule_reasons).toEqual([]);
  });

  it('keeps taints and other controllers\' reasons when it rewrites its own', async () => {
    await db.query(`UPDATE nodes SET no_schedule_reasons = '{unreachable}' WHERE id = $1`, [node]);
    await report(node, { gpus: encoded.gpus(8, 'NVIDIA GH200 480GB') });
    await applyInventory(db, node);
    expect((await nodeRow()).no_schedule_reasons).toEqual(['GpuModelUnknown', 'unreachable']);
  });

  it('quarantines a vanished GPU that is still booked, and deletes it once the booking ended', async () => {
    await report(node, { gpus: encoded.gpus(8) });
    await applyInventory(db, node);
    await db.query(
      `INSERT INTO device_bookings (device_id, allocation_id, during)
       VALUES ($1, 'alloc_1', tstzrange(compute_now() - interval '1 hour', compute_now() + interval '1 hour'))`,
      [`GPU-${node}-3`],
    );
    const gone = toBinary(
      GpusSectionSchema,
      create(GpusSectionSchema, { ...gpusSection(8), gpus: gpusSection(8).gpus.filter((g) => g.uuid !== `GPU-${node}-3`) }),
    );
    await report(node, { gpus: gone });
    const result = await applyInventory(db, node);
    if (result.status !== 'applied') throw new Error(result.status);
    expect(result.devices).toEqual({ upserted: 0, removed: 0, quarantined: 1, claimedElsewhere: [] });
    const gpu3 = await db.query<{ healthy: boolean }>('SELECT healthy FROM devices WHERE id = $1', [`GPU-${node}-3`]);
    expect(gpu3.rows).toEqual([{ healthy: false }]);

    // The booking ends; the next inventory change deletes the device and the ended booking.
    await db.query(
      `UPDATE device_bookings SET during = tstzrange(lower(during), compute_now() - interval '1 second') WHERE device_id = $1`,
      [`GPU-${node}-3`],
    );
    await report(node, { gpus: gone, os: encoded.os() });
    const later = await applyInventory(db, node);
    if (later.status !== 'applied') throw new Error(later.status);
    expect(later.devices.removed).toBe(1);
    expect((await db.query('SELECT 1 FROM devices WHERE id = $1', [`GPU-${node}-3`])).rowCount).toBe(0);
  });

  it('marks a second node with the same trusted hardware key as DuplicateIdentity', async () => {
    const same = { system: encoded.system('SER-DUP'), nics: encoded.nics('b8:ce:f6:00:00:99') };
    await report(node, same);
    await applyInventory(db, node);
    expect((await nodeRow()).hardware_key_trusted).toBe(true);

    const twin = `${node}-twin`;
    await db.transaction((tx) => addNode(tx, twin));
    await report(twin, same);
    const result = await applyInventory(db, twin);
    if (result.status !== 'applied') throw new Error(result.status);
    expect(result.conditions.find((c) => c.type === 'DuplicateIdentity')).toMatchObject({ status: 'true' });
    const row = await nodeRow(twin);
    expect(row.hardware_key_trusted).toBe(false);
    expect(row.no_schedule_reasons).toContain('DuplicateIdentity');
    expect(Buffer.from(row.hardware_key!).equals(Buffer.from((await nodeRow()).hardware_key!))).toBe(true);
  });

  it('raises DuplicateIdentity when another node already owns a reported GPU', async () => {
    await report(node, { gpus: encoded.gpus(2) });
    await applyInventory(db, node);
    const owner = node;
    node = `${owner}-clone`;
    await db.transaction((tx) => addNode(tx, node));
    // The clone reports the owner's GPU UUIDs.
    const cloned = toBinary(GpusSectionSchema, create(GpusSectionSchema, { gpus: [gpu(0), gpu(1)].map((g) => ({ ...g, uuid: g.uuid.replace(node, owner) })) }));
    await report(node, { gpus: cloned });
    const result = await applyInventory(db, node);
    if (result.status !== 'applied') throw new Error(result.status);
    expect(result.devices.claimedElsewhere).toEqual([`GPU-${owner}-0`, `GPU-${owner}-1`]);
    expect(result.devices.upserted).toBe(0);
    expect((await nodeRow()).no_schedule_reasons).toContain('DuplicateIdentity');
    const owners = await db.query<{ node_id: string }>('SELECT DISTINCT node_id FROM devices WHERE id = ANY($1)', [result.devices.claimedElsewhere]);
    expect(owners.rows).toEqual([{ node_id: owner }]);
  });

  it('rejects a section whose bytes do not match its hash, and unknown nodes', async () => {
    const content = encoded.os();
    await expect(
      db.transaction((tx) => ingestInventorySection(tx, work, node, { section: 'os', content, sha256: sha256Hex('x') })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      db.transaction((tx) => recordInventoryHashes(tx, work, 'node_missing', { os: sha256Hex(content) })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('shared pools', () => {
  it("derives slot atoms from the pool's sharing policy and books the whole family on a change", async () => {
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_ts', 'ten_root', 'site_a', 'metal-host', 'H100', 'timeslice', 'bcd', '{"sharing":{"replicas":2}}', 1)
       ON CONFLICT DO NOTHING`,
    );
    await db.transaction((tx) => addNode(tx, `${node}-ts`, 'pool_ts'));
    const shared = `${node}-ts`;
    const content = toBinary(GpusSectionSchema, create(GpusSectionSchema, { gpus: [gpu(0)] }));
    await report(shared, { gpus: content });
    await applyInventory(db, shared);
    const devices = await db.query<{ id: string; class: string; bookable: boolean }>(
      'SELECT id, class, bookable FROM devices WHERE node_id = $1 ORDER BY id',
      [shared],
    );
    expect(devices.rows.map((d) => [d.class, d.bookable])).toEqual([
      ['gpu', false],
      ['gpu.slot', true],
      ['gpu.slot', true],
    ]);
    expect(await gpuAtomFamily(db, `GPU-${node}-0`)).toEqual([`GPU-${node}-0`, `GPU-${node}-0/s0`, `GPU-${node}-0/s1`]);
  });
});

describe('inventory.history and inventory.diff', () => {
  it('pages snapshots newest first and diffs the latest two by default, or any two by id or hash', async () => {
    const context = { sql: db } as never;
    const api = inventoryModule.api!(context);
    const call = <M extends 'history' | 'diff'>(method: M, input: unknown) =>
      (api.inventory[method] as { validate(i: unknown): any; handler(c: never, i: unknown): Promise<any> }).handler(
        context,
        api.inventory[method].validate(input),
      );
    // Validation checks real node ids.
    node = `node_${String(++seq).padStart(26, '0')}`;
    await db.transaction((tx) => addNode(tx, node));
    for (const count of [8, 7, 8]) {
      await report(node, { gpus: encoded.gpus(count) });
      await applyInventory(db, node);
    }
    const first = await call('history', { tenantId: 'ten_root', nodeId: node, limit: 2 });
    expect(first.items.map((s: { sections: { gpus: { gpus: unknown[] } } }) => s.sections.gpus.gpus.length)).toEqual([8, 7]);
    const rest = await call('history', { tenantId: 'ten_root', nodeId: node, limit: 2, cursor: first.cursor });
    expect(rest.items).toHaveLength(1);
    expect(rest.cursor).toBeUndefined();

    const latest = await call('diff', { tenantId: 'ten_root', nodeId: node });
    expect(latest.changes.map((c: { type: string; deviceId: string }) => [c.type, c.deviceId])).toEqual([['gpu.added', `GPU-${node}-7`]]);
    const byHash = await call('diff', { tenantId: 'ten_root', nodeId: node, from: rest.items[0].hash, to: first.items[1].hash });
    expect(byHash.changes.map((c: { type: string }) => c.type)).toEqual(['gpu.missing']);
    await expect(call('diff', { tenantId: 'ten_root', nodeId: node, from: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call('history', { tenantId: 'ten_other', nodeId: node })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => api.inventory.history.validate({ tenantId: 'ten_root', nodeId: node, limit: 500 })).toThrow();
  });
});

describe('recordInventoryHashesMany (batched Hellos and heartbeats)', () => {
  it('answers each node as recordInventoryHashes would, in one statement for the batch', async () => {
    const fresh = `node_${++seq}`;
    const applied = `node_${++seq}`;
    await db.transaction(async (tx) => {
      await addNode(tx, fresh);
      await addNode(tx, applied);
    });
    const sections = { gpus: encoded.gpus(8), system: encoded.system('S-many'), os: encoded.os() };
    const hashes = Object.fromEntries(Object.entries(sections).map(([name, bytes]) => [name, sha256Hex(bytes)]));
    // `applied` already has every section stored and applied.
    await report(applied, sections);
    await applyInventory(db, applied, { events, work });
    enqueued.length = 0;
    const statements: string[] = [];
    const counting = {
      ...db,
      query: (text: string, params?: readonly unknown[]) => {
        statements.push(text);
        return db.query(text, params as unknown[]);
      },
    } as unknown as SqlTx;
    const results = await recordInventoryHashesMany(counting, work, [
      { nodeId: fresh, hashes: { system: 'zz' } }, // malformed: its own slot fails
      { nodeId: fresh, hashes, bootId: 'boot-a' },
      { nodeId: applied, hashes, bootId: 'boot-b' },
      { nodeId: 'node_missing', hashes },
    ]);
    expect((results[0] as { code?: string }).code).toBe('INVALID_INPUT');
    expect(results[1]).toEqual(['system', 'gpus', 'os']);
    expect(results[2]).toEqual([]);
    expect((results[3] as { code?: string }).code).toBe('NOT_FOUND');
    expect(statements).toHaveLength(1);
    expect(enqueued).toEqual([]); // `applied` reported what it already has
    // The same answers as the per-node function.
    expect(await db.transaction((tx) => recordInventoryHashes(tx, work, fresh, hashes))).toEqual(results[1]);
    // A section vanished: nothing to pull, but the set changed, so the node is queued for apply.
    const { os: _os, ...withoutOs } = hashes;
    expect(await db.transaction((tx) => recordInventoryHashesMany(tx, work, [{ nodeId: applied, hashes: withoutOs }]))).toEqual([[]]);
    expect(enqueued).toEqual([`inventory:${applied}`]);
    expect(await db.transaction((tx) => recordInventoryHashesMany(tx, work, []))).toEqual([]);
  });
});

describe('ingestInventorySections (the batched pull)', () => {
  it('stores many nodes sections in one go, with one slot per entry, and enqueues each node once', async () => {
    const other = `node_${++seq}`;
    await db.transaction((tx) => addNode(tx, other));
    const hashes = { gpus: encoded.gpus(8), system: encoded.system('S-batch'), os: encoded.os() };
    for (const id of [node, other])
      await db.transaction((tx) =>
        recordInventoryHashes(tx, work, id, Object.fromEntries(Object.entries(hashes).map(([name, bytes]) => [name, sha256Hex(bytes)]))),
      );
    const entry = (nodeId: string, name: InventorySectionName, content: Uint8Array, sha256 = sha256Hex(content)) => ({
      nodeId,
      section: { section: name, content, sha256 },
    });
    enqueued.length = 0;
    const results = await db.transaction((tx) =>
      ingestInventorySections(tx, work, [
        entry(node, 'gpus', hashes.gpus),
        entry(node, 'system', encoded.system('stale')), // superseded by the next one
        entry(node, 'system', hashes.system),
        entry(node, 'os', hashes.os),
        entry(other, 'gpus', hashes.gpus),
        entry(other, 'system', hashes.system, 'ab'.repeat(32)), // bytes that do not match their hash
        entry('node_missing', 'os', hashes.os),
        entry(other, 'system', hashes.system),
        entry(other, 'os', hashes.os),
      ]),
    );
    expect(results.map((result) => (result as { code?: string } | undefined)?.code)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'INVALID_INPUT',
      'NOT_FOUND',
      undefined,
      undefined,
    ]);
    expect(enqueued.sort()).toEqual([`inventory:${node}`, `inventory:${other}`].sort());
    // Both nodes now hold a complete, verified set: the reconciler applies it. They reported the same
    // GPU UUIDs, so the second finds every device claimed by the first (the set-based upsert's
    // RETURNING tells them apart).
    expect((await applyInventory(db, node, { events, work })).status).toBe('applied');
    const second = await applyInventory(db, other, { events, work });
    expect(second.status === 'applied' && second.devices).toMatchObject({ upserted: 0, claimedElsewhere: expect.arrayContaining([`GPU-${node}-0`]) });
    expect(second.status === 'applied' && second.devices.claimedElsewhere).toHaveLength(8);
    expect(second.status === 'applied' && second.conditions.find((c) => c.type === 'DuplicateIdentity')?.status).toBe('true');
    const { rows } = await db.query<{ node_id: string; n: number }>(
      `SELECT node_id, count(*)::int AS n FROM devices WHERE node_id = ANY($1) AND class = 'gpu' GROUP BY node_id`,
      [[node, other]],
    );
    expect(rows).toEqual([{ node_id: node, n: 8 }]);
    expect(await db.transaction((tx) => ingestInventorySections(tx, work, []))).toEqual([]);
  });

  it('uses the set-based enqueue when the work queue has one', async () => {
    const many: string[][] = [];
    const batching: WorkQueue = {
      ...work,
      async enqueueMany(_tx, kind, keys) {
        many.push([kind, ...keys]);
      },
    };
    await db.transaction((tx) => ingestInventorySections(tx, batching, [{ nodeId: node, section: { section: 'os', content: encoded.os(), sha256: sha256Hex(encoded.os()) } }]));
    expect(many).toEqual([['inventory', node]]);
  });
});

describe('inventoryModule wiring', () => {
  it('registers the inventory reconciler, sharded by node, and the hygiene sweep', () => {
    expect(inventoryModule.reconcilers).toEqual([inventoryReconciler, inventoryHygieneReconciler]);
    expect(inventoryReconciler).toMatchObject({ name: 'inventory', shardBy: 'node' });
  });

  it('runs as a reconciler and serves inventory.get to the owning tenant only', async () => {
    await report(node, { gpus: encoded.gpus(8) });
    const context = { sql: db, events } as never;
    expect(await inventoryReconciler.run(context, node)).toBe('DONE');
    expect(await inventoryReconciler.run(context, 'node_gone')).toBe('DONE');
    const api = inventoryModule.api!(context);
    const snapshot = await api.inventory.get.handler(context, { tenantId: 'ten_root', nodeId: node });
    expect(snapshot.nodeId).toBe(node);
    await expect(
      api.inventory.get.handler(context, { tenantId: 'ten_other', nodeId: node }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
