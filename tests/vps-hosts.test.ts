import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations } from '@better-compute/capacity';
import {
  hostReserve,
  staleHostResources,
  syncHostResources,
  vpsMigrations,
} from '@better-compute/vps';

// Host capacity from inventory (PLAN.md §10.2): vcpu/memoryGiB/diskGiB rows for vps-host nodes, the
// pool's overcommit as the ratio, written only on change and never below what is allocated.

const GiB = 1024 ** 3;
const SITE = 'site_01jz0000000000000000000h01';
let db: SqlExecutor;
let snapshots = 0;

async function pool(id: string, poolClass: string, policy: unknown): Promise<void> {
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ($1, 'root', $2, $3, 'exclusive', 'bcd', $4::jsonb, 1)`,
    [id, SITE, poolClass, JSON.stringify(policy)],
  );
}

async function node(id: string, poolId: string, trust = 'platform'): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                        connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', $4, 1, 1, 1, 1, 0, 1)`,
    [id, SITE, poolId, trust],
  );
}

/** Applies an inventory snapshot as the inventory controller would (only the fields read here). */
async function inventory(
  nodeId: string,
  hardware: { threads: number; memoryGiB: number; disksGiB: number[]; usbGiB?: number },
): Promise<void> {
  const id = `inv_${String(++snapshots).padStart(4, '0')}`;
  const sections = {
    cpu: { threads: hardware.threads, cores: hardware.threads / 2, sockets: 2 },
    memory: { totalBytes: String(hardware.memoryGiB * GiB) },
    disks: {
      disks: [
        ...hardware.disksGiB.map((size, index) => ({
          name: `nvme${index}n1`,
          sizeBytes: String(size * GiB),
        })),
        ...(hardware.usbGiB
          ? [{ name: 'sda', sizeBytes: String(hardware.usbGiB * GiB), removable: true }]
          : []),
      ],
    },
  };
  await db.query(
    `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
     VALUES ($1, $2, '\\x00', '{}', $3::jsonb, compute_now())`,
    [id, nodeId, JSON.stringify(sections)],
  );
  await db.query(
    `INSERT INTO node_inventory (node_id, applied_snapshot_id) VALUES ($1, $2)
     ON CONFLICT (node_id) DO UPDATE SET applied_snapshot_id = EXCLUDED.applied_snapshot_id`,
    [nodeId, id],
  );
}

async function resources(nodeId: string) {
  const { rows } = await db.query<{
    resource: string;
    allocatable: string;
    ratio: string;
    allocated: string;
  }>(
    `SELECT resource, allocatable::text, ratio::text, allocated::text FROM node_resources
      WHERE node_id = $1 ORDER BY resource`,
    [nodeId],
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.resource,
      {
        allocatable: Number(row.allocatable),
        ratio: Number(row.ratio),
        allocated: Number(row.allocated),
      },
    ]),
  );
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  await pool('pool_01jz0000000000000000000h01', 'vps-host', {
    overcommit: { vcpu: 4, memoryGiB: 1.5, diskGiB: 'lots' },
  });
  await pool('pool_01jz0000000000000000000h02', 'metal-host', {});
  await node('node_01jz0000000000000000000h01', 'pool_01jz0000000000000000000h01');
  await node(
    'node_01jz0000000000000000000h02',
    'pool_01jz0000000000000000000h01',
    'tenant-controlled',
  );
  await node('node_01jz0000000000000000000h03', 'pool_01jz0000000000000000000h02');
  await node('node_01jz0000000000000000000h04', 'pool_01jz0000000000000000000h01');
  for (const id of ['h01', 'h02', 'h03'])
    await inventory(`node_01jz0000000000000000000${id}`, {
      threads: 128,
      memoryGiB: 512,
      disksGiB: [960, 3840],
      usbGiB: 32,
    });
});
afterAll(async () => {
  await db.close();
});

describe('VPS host capacity from inventory (§10.2)', () => {
  it('derives vcpu, memory and disk minus the reserve, with the pool overcommit as the ratio', async () => {
    expect(await syncHostResources(db)).toBe(3);
    expect(await resources('node_01jz0000000000000000000h01')).toEqual({
      vcpu: { allocatable: 126, ratio: 4, allocated: 0 },
      memoryGiB: { allocatable: 504, ratio: 1.5, allocated: 0 },
      // Removable media never count; a non-numeric overcommit is ignored (ratio 1).
      diskGiB: { allocatable: 960 + 3840 - 100, ratio: 1, allocated: 0 },
    });
  });

  it('skips tenant-controlled nodes, other pool classes and nodes without inventory', async () => {
    for (const id of ['h02', 'h03', 'h04'])
      expect(await resources(`node_01jz0000000000000000000${id}`)).toEqual({});
  });

  it('writes nothing while inventory and policy are unchanged', async () => {
    expect(await staleHostResources(db)).toEqual([]);
    expect(await syncHostResources(db)).toBe(0);
  });

  it('follows a new snapshot and a new overcommit', async () => {
    await inventory('node_01jz0000000000000000000h04', {
      threads: 64,
      memoryGiB: 256,
      disksGiB: [1920],
    });
    await db.query(
      `UPDATE pools SET policy = '{"overcommit": {"vcpu": 2}}' WHERE id = 'pool_01jz0000000000000000000h01'`,
    );
    const stale = await staleHostResources(db);
    expect(stale.map((row) => `${row.nodeId.slice(-3)}:${row.resource}`)).toEqual([
      'h01:memoryGiB',
      'h01:vcpu',
      'h04:diskGiB',
      'h04:memoryGiB',
      'h04:vcpu',
    ]);
    expect(await syncHostResources(db, { nodeId: 'node_01jz0000000000000000000h04' })).toBe(3);
    expect(await syncHostResources(db)).toBe(2);
    expect(await resources('node_01jz0000000000000000000h04')).toEqual({
      vcpu: { allocatable: 62, ratio: 2, allocated: 0 },
      memoryGiB: { allocatable: 248, ratio: 1, allocated: 0 },
      diskGiB: { allocatable: 1820, ratio: 1, allocated: 0 },
    });
  });

  it('never shrinks a host below what is allocated, and does not churn on it', async () => {
    const id = 'node_01jz0000000000000000000h01';
    await db.query(
      `UPDATE node_resources SET allocated = 200 WHERE node_id = $1 AND resource = 'vcpu'`,
      [id],
    );
    await inventory(id, { threads: 32, memoryGiB: 512, disksGiB: [960, 3840], usbGiB: 32 });
    await syncHostResources(db);
    // 30 threads × 2 would be 60 < 200 allocated: kept at ceil(200 / 2).
    expect((await resources(id)).vcpu).toEqual({ allocatable: 100, ratio: 2, allocated: 200 });
    expect(await syncHostResources(db)).toBe(0);
    // Once the allocations drain, the next pass shrinks it.
    await db.query(`UPDATE node_resources SET allocated = 0 WHERE node_id = $1`, [id]);
    await syncHostResources(db);
    expect((await resources(id)).vcpu).toEqual({ allocatable: 30, ratio: 2, allocated: 0 });
  });

  it('takes a configured reserve and refuses a bad one', async () => {
    const id = 'node_01jz0000000000000000000h04';
    await syncHostResources(db, { reserve: hostReserve({ vcpu: 4, memoryGiB: 0 }) });
    expect((await resources(id)).vcpu?.allocatable).toBe(60);
    expect((await resources(id)).memoryGiB?.allocatable).toBe(256);
    expect(() => hostReserve({ vcpu: -1 })).toThrow(/whole number/);
  });
});
