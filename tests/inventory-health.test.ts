import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { GpuSchema, GpusSectionSchema, LinkState } from '@better-compute/protocol';
import {
  applyInventory,
  classifyXid,
  clearDeviceHealth,
  clearNodeFaults,
  ingestInventorySection,
  inventoryHealthFindings,
  recordInventoryHashes,
  recordXid,
  sha256Hex,
} from '@better-compute/inventory';

// Health (PLAN.md §10.1, v0.2): XIDs and GPU counters → conditions, device quarantines and NoSchedule.

let db: SqlExecutor;
const work: WorkQueue = { async enqueue() {} };
let node: string;
let seq = 0;

type GpuInit = Parameters<typeof create<typeof GpuSchema>>[1];
const gpu = (index: number, extra: GpuInit = {}) =>
  create(GpuSchema, { index, uuid: `GPU-${node}-${index}`, name: 'NVIDIA H100 80GB HBM3', vramBytes: 80n * 1024n ** 3n, ...extra });
const section = (...gpus: ReturnType<typeof gpu>[]) => create(GpusSectionSchema, { driverVersion: '550', gpus });

async function report(gpus: ReturnType<typeof section>) {
  const content = toBinary(GpusSectionSchema, gpus);
  const sha = sha256Hex(content);
  await db.transaction(async (tx) => {
    const requested = await recordInventoryHashes(tx, work, node, { gpus: sha });
    if (requested.length) await ingestInventorySection(tx, work, node, { section: 'gpus', content, sha256: sha });
  });
  return applyInventory(db, node);
}
const deviceHealth = async (id: string) =>
  (await db.query<{ healthy: boolean }>('SELECT healthy FROM devices WHERE id = $1', [id])).rows[0]?.healthy;
const reasons = async () =>
  (await db.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1', [node])).rows[0]!.no_schedule_reasons;
const condition = async (type: string) =>
  (await db.query<{ status: string }>('SELECT status FROM node_conditions WHERE node_id = $1 AND type = $2', [node, type])).rows[0]?.status;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_h', 'ten', 'shared', 'eu', 1)`);
});
afterAll(() => db.close());
beforeEach(async () => {
  node = `node_health_${++seq}`;
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
       generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_h', 'ten', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [node],
  );
});

describe('policies and findings', () => {
  it('classifies the XIDs §10.1 acts on, and ignores application XIDs', () => {
    expect(classifyXid(48)).toMatchObject({ condition: 'Xid48', action: 'quarantine-gpu', noSchedule: false });
    expect(classifyXid(79)).toMatchObject({ condition: 'Xid79', action: 'drain-reboot', noSchedule: true });
    expect(classifyXid(95)).toMatchObject({ action: 'drain-reboot' });
    expect(classifyXid(63)).toMatchObject({ condition: 'RowRemapPending', action: 'drain-gpu-reset' });
    expect(classifyXid(64)).toMatchObject({ condition: 'RowRemapFailed', action: 'rma' });
    expect(classifyXid(13)).toBeUndefined();
    expect(classifyXid(Number('toString'))).toBeUndefined();
  });

  it('reads row remaps, ECC and NVLink state from the GPU section', () => {
    const up = { $typeName: 'bettercompute.agent.v1.NvlinkLink' as const, link: 0, state: LinkState.UP, peer: '', version: 4 };
    const down = { ...up, link: 1, state: LinkState.DOWN };
    const findings = inventoryHealthFindings(
      section(
        gpu(0),
        gpu(1, { rowRemap: { $typeName: 'bettercompute.agent.v1.GpuRowRemap', correctable: 0, uncorrectable: 1, pending: true, failure: false } }),
        gpu(2, { rowRemap: { $typeName: 'bettercompute.agent.v1.GpuRowRemap', correctable: 0, uncorrectable: 9, pending: true, failure: true } }),
        gpu(3, { ecc: { $typeName: 'bettercompute.agent.v1.GpuEcc', enabled: true, volatileCounts: { $typeName: 'bettercompute.agent.v1.EccCounts', correctable: 0n, uncorrectable: 2n } } }),
        gpu(4, { nvlinks: [up, down] }),
        gpu(5, { nvlinks: [down] }),
      ),
    );
    expect(findings.map((f) => [f.deviceId.split('-').at(-1), f.condition, f.noSchedule])).toEqual([
      ['1', 'RowRemapPending', true],
      ['2', 'RowRemapFailed', false],
      ['3', 'EccUncorrectable', false],
      ['4', 'NvlinkDegraded', false],
    ]);
  });
});

describe('inventory-derived health', () => {
  it('quarantines only the faulty GPU, keeps the node schedulable, and heals when the counters clear', async () => {
    const eccBad = { $typeName: 'bettercompute.agent.v1.GpuEcc' as const, enabled: true, volatileCounts: { $typeName: 'bettercompute.agent.v1.EccCounts' as const, correctable: 0n, uncorrectable: 3n } };
    const result = await report(section(gpu(0), gpu(1, { ecc: eccBad })));
    if (result.status !== 'applied') throw new Error(result.status);
    expect(result.health.map((h) => h.condition)).toEqual(['EccUncorrectable']);
    expect(await deviceHealth(`GPU-${node}-0`)).toBe(true);
    expect(await deviceHealth(`GPU-${node}-1`)).toBe(false);
    expect(await reasons()).toEqual([]);
    expect(await condition('EccUncorrectable')).toBe('true');

    await report(section(gpu(0), gpu(1)));
    expect(await deviceHealth(`GPU-${node}-1`)).toBe(true);
    expect(await condition('EccUncorrectable')).toBe('false');
  });

  it('makes the node NoSchedule while a row remap is pending', async () => {
    const pending = { $typeName: 'bettercompute.agent.v1.GpuRowRemap' as const, correctable: 0, uncorrectable: 1, pending: true, failure: false };
    await report(section(gpu(0, { rowRemap: pending })));
    expect(await reasons()).toEqual(['RowRemapPending']);
    await report(section(gpu(0)));
    expect(await reasons()).toEqual([]);
  });
});

describe('XIDs', () => {
  it('Xid48 quarantines the GPU until an operator clears it, even across inventories', async () => {
    await report(section(gpu(0), gpu(1)));
    const outcome = await db.transaction((tx) => recordXid(tx, node, { gpuUuid: `GPU-${node}-1`, xid: 48 }));
    expect(outcome).toMatchObject({ quarantined: true, noSchedule: false });
    expect(await deviceHealth(`GPU-${node}-1`)).toBe(false);
    expect(await condition('Xid48')).toBe('true');
    // A clean inventory does not heal an XID quarantine.
    await report(section(gpu(0), gpu(1), gpu(2)));
    expect(await deviceHealth(`GPU-${node}-1`)).toBe(false);
    expect(await db.transaction((tx) => clearDeviceHealth(tx, `GPU-${node}-1`))).toBe(true);
    expect(await deviceHealth(`GPU-${node}-1`)).toBe(true);
  });

  it('Xid79 makes the node NoSchedule until remediation clears it', async () => {
    await report(section(gpu(0)));
    await db.transaction((tx) => recordXid(tx, node, { gpuUuid: `GPU-${node}-0`, xid: 79 }));
    await db.transaction((tx) => recordXid(tx, node, { gpuUuid: `GPU-${node}-0`, xid: 79 }));
    expect(await reasons()).toEqual(['Xid79']);
    await db.transaction((tx) => clearNodeFaults(tx, node, ['Xid79']));
    expect(await reasons()).toEqual([]);
    expect(await condition('Xid79')).toBe('false');
    expect(await deviceHealth(`GPU-${node}-0`)).toBe(true);
  });

  it('records nothing for application XIDs or unknown GPUs', async () => {
    await report(section(gpu(0)));
    expect(await db.transaction((tx) => recordXid(tx, node, { gpuUuid: `GPU-${node}-0`, xid: 13 }))).toEqual({
      xid: 13,
      quarantined: false,
      noSchedule: false,
    });
    const unknown = await db.transaction((tx) => recordXid(tx, node, { gpuUuid: 'GPU-elsewhere', xid: 48 }));
    expect(unknown.quarantined).toBe(false);
  });
});
