import { create } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { GpuLinkType, GpuSchema, GpusSectionSchema } from '@better-compute/protocol';
import { devicesFromGpus } from '@better-compute/inventory';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, inlinePlacer, syncDeviceLinks } from '@better-compute/capacity';

// The inventory → capacity seam: devices from the `gpus` section, topology from its matrix
// (`syncDeviceLinks`), and NVLink-aware placement over both.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
  await useSimClock(db, T0);
});
afterAll(async () => {
  await db.close();
});

/** Four GPUs in two NVLink islands, {0, 3} and {1, 2}, SYS across. */
function section() {
  const uuids = ['GPU-0000', 'GPU-0001', 'GPU-0002', 'GPU-0003'];
  const island = (index: number) => (index === 0 || index === 3 ? 0 : 1);
  return create(GpusSectionSchema, {
    gpus: uuids.map((uuid, index) =>
      create(GpuSchema, {
        index,
        uuid,
        name: 'NVIDIA H100 80GB HBM3',
        vramBytes: 80n * 1024n ** 3n,
        numaNode: 0,
        topology: uuids
          .filter((peer) => peer !== uuid)
          .map((peerUuid) => ({
            peerUuid,
            link:
              island(uuids.indexOf(peerUuid)) === island(index) ? GpuLinkType.NV : GpuLinkType.SYS,
          })),
      }),
    ),
  });
}

describe('syncDeviceLinks', () => {
  it('turns the topology matrix into links the placer honours', async () => {
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_i', 'root', 'shared', 'eu', 1)`,
    );
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_i', 'root', 'site_i', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    );
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_i', 'site_i', 'pool_i', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    );
    const gpus = section();
    for (const device of devicesFromGpus('node_i', gpus))
      await db.query(
        `INSERT INTO devices (id, node_id, parent_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          device.id,
          device.nodeId,
          device.parentId ?? null,
          device.class,
          device.bookable,
          device.healthy,
          JSON.stringify(device.attributes),
        ],
      );
    expect(await db.transaction((tx) => syncDeviceLinks(tx, 'node_i', gpus))).toBe(6);
    expect(await db.transaction((tx) => syncDeviceLinks(tx, 'node_i', undefined))).toBe(0);
    expect(await db.transaction((tx) => syncDeviceLinks(tx, 'node_i', gpus))).toBe(6);

    const placer = inlinePlacer();
    const context = {
      clock: { now: () => T0 },
      random: () => 0,
      plugins: [],
      weights: {},
      topN: 1,
    };
    const place = (id: string) =>
      db.transaction((tx) =>
        placer.place(
          tx,
          {
            tenantId: 'acme',
            poolId: 'pool_i',
            reservationId: id,
            devices: [{ class: 'gpu', count: 2 }],
            topology: 'nvlink-all',
            during: { start: T0, end: T0 + 3_600_000 },
          },
          context,
        ),
      );
    const first = await place('rsv_1');
    const second = await place('rsv_2');
    const atoms = [first, second].map((outcome) =>
      outcome.status === 'placed' ? [...outcome.allocations[0]!.atoms].sort() : [],
    );
    expect(atoms).toEqual([
      ['GPU-0000', 'GPU-0003'],
      ['GPU-0001', 'GPU-0002'],
    ]);
  });
});
