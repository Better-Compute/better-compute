import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, staleNodeResources, syncNodeResources } from '@better-compute/capacity';

// Host resources on every host (PLAN.md §3.8): vcpu and memoryGiB for GPU hosts (vps-host pools keep
// vps's own rows), hugepage pools for all hosts and carved out of memory, reserves from the pool's
// policy.hostReserve, written only on change and never below what is allocated.

const GiB = 1024 ** 3;
const SITE = 'site_01jz0000000000000000000r01';
const GPU_POOL = 'pool_01jz0000000000000000000r01';
const VPS_POOL = 'pool_01jz0000000000000000000r02';
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

async function inventory(
  nodeId: string,
  hardware: { threads: number; memoryGiB: number; hugepages?: { size: number; total: number }[] },
): Promise<void> {
  const id = `inv_r${String(++snapshots).padStart(4, '0')}`;
  const sections = {
    cpu: { threads: hardware.threads },
    memory: {
      totalBytes: String(hardware.memoryGiB * GiB),
      hugepages: (hardware.hugepages ?? []).map((pool) => ({
        pageSizeBytes: String(pool.size),
        total: String(pool.total),
      })),
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
  const { rows } = await db.query<{ resource: string; allocatable: string; ratio: string }>(
    `SELECT resource, allocatable::text, ratio::text FROM node_resources WHERE node_id = $1 ORDER BY resource`,
    [nodeId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.resource, { allocatable: Number(row.allocatable), ratio: Number(row.ratio) }]),
  );
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  await pool(GPU_POOL, 'metal-host', { hostReserve: { vcpu: 4, memoryGiB: 16 }, overcommit: { vcpu: 2 } });
  await pool(VPS_POOL, 'vps-host', {});
});
afterAll(async () => {
  await db.close();
});

describe('host resources on every host (§3.8)', () => {
  it('books a GPU host’s CPUs, memory and hugepages from its inventory and pool policy', async () => {
    const id = 'node_01jz0000000000000000000r01';
    await node(id, GPU_POOL);
    // 128 threads, 1024 GiB of which 64 GiB are 1 GiB hugepages and 4 GiB are 2 MiB pages.
    await inventory(id, {
      threads: 128,
      memoryGiB: 1024,
      hugepages: [
        { size: 2 * 1024 ** 2, total: 2048 },
        { size: GiB, total: 64 },
      ],
    });
    expect(await syncNodeResources(db)).toBe(4);
    expect(await resources(id)).toEqual({
      vcpu: { allocatable: 124, ratio: 2 },
      // 1024 − 64 − 4 hugepage GiB − the 16 GiB reserve.
      memoryGiB: { allocatable: 940, ratio: 1 },
      hugepages2Mi: { allocatable: 2048, ratio: 1 },
      hugepages1Gi: { allocatable: 64, ratio: 1 },
    });
    // Nothing changed: nothing written.
    expect(await staleNodeResources(db)).toEqual([]);
    expect(await syncNodeResources(db)).toBe(0);
  });

  it('leaves a VPS host’s vcpu and memory to vps, but books its hugepages', async () => {
    const id = 'node_01jz0000000000000000000r02';
    await node(id, VPS_POOL);
    await inventory(id, { threads: 64, memoryGiB: 256, hugepages: [{ size: GiB, total: 32 }] });
    await syncNodeResources(db, { nodeId: id });
    expect(await resources(id)).toEqual({ hugepages1Gi: { allocatable: 32, ratio: 1 } });
  });

  it('never counts a tenant-controlled node, and keeps the default reserve without a policy one', async () => {
    const controlled = 'node_01jz0000000000000000000r03';
    await node(controlled, GPU_POOL, 'tenant-controlled');
    await inventory(controlled, { threads: 64, memoryGiB: 256 });
    const plainPool = 'pool_01jz0000000000000000000r03';
    await pool(plainPool, 'metal-host', {});
    const plain = 'node_01jz0000000000000000000r04';
    await node(plain, plainPool);
    await inventory(plain, { threads: 16, memoryGiB: 64 });
    await syncNodeResources(db);
    expect(await resources(controlled)).toEqual({});
    expect(await resources(plain)).toEqual({
      vcpu: { allocatable: 14, ratio: 1 },
      memoryGiB: { allocatable: 56, ratio: 1 },
    });
  });

  it('never shrinks below what is allocated', async () => {
    const id = 'node_01jz0000000000000000000r01';
    await db.query(`UPDATE node_resources SET allocated = 100 WHERE node_id = $1 AND resource = 'vcpu'`, [id]);
    // Half the CPUs disappear from inventory (e.g. a socket offline).
    await inventory(id, { threads: 64, memoryGiB: 1024, hugepages: [{ size: GiB, total: 64 }, { size: 2 * 1024 ** 2, total: 2048 }] });
    await syncNodeResources(db, { nodeId: id });
    // 60 × 2 = 120 ≥ 100 allocated: allowed to shrink to 60.
    expect((await resources(id)).vcpu).toEqual({ allocatable: 60, ratio: 2 });
    await db.query(`UPDATE node_resources SET allocated = 110 WHERE node_id = $1 AND resource = 'vcpu'`, [id]);
    await inventory(id, { threads: 32, memoryGiB: 1024, hugepages: [{ size: GiB, total: 64 }, { size: 2 * 1024 ** 2, total: 2048 }] });
    await syncNodeResources(db, { nodeId: id });
    // 28 × 2 = 56 < 110 allocated: kept at ceil(110 / 2).
    expect((await resources(id)).vcpu).toEqual({ allocatable: 55, ratio: 2 });
  });
});
