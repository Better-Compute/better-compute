import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlacementRequest, SchedulerPlugin, SqlExecutor } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  inlinePlacer,
  loadNodeViews,
  readImageCachedNodes,
  planFromShortlist,
  planPlacement,
  readPool,
  shortlistable,
  shortlistSize,
} from '@better-compute/capacity';

// The placement shortlist (§10.3, placements/s): planning from the SQL shortlist must rank the same
// top N as planning the whole pool, or decline. A seeded pool mixes node sizes, bookings, unhealthy
// and unbookable GPUs, cordoned nodes, NVLink islands and scalar capacity.

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;
const nodeCount = 150;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('the placement shortlist', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate([...capacityMigrations]);
    await useSimClock(db, T0);
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_s', 'root', 'shared', 'eu', 1)`,
    );
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_s', 'root', 'site_s', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    );
    const random = seeded(Number(process.env.SHORTLIST_SEED ?? 7));
    for (let i = 0; i < nodeCount; i++) {
      const node = `n_${String(i).padStart(3, '0')}`;
      await db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                            connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, 'site_s', 'pool_s', 'root', 'host', 'adopted', false, $2, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
        [node, random() < 0.05],
      );
      const gpus = random() < 0.5 ? 8 : 4;
      for (let g = 0; g < gpus; g++)
        await db.query(
          `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
           VALUES ($1, $2, 'gpu', $3, $4, '{}')`,
          [`${node}-g${g}`, node, random() > 0.03, random() > 0.05],
        );
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'nic', true, true, '{}')`,
        [`${node}-nic`, node],
      );
      // No topology known on 30% of nodes; NVLink islands of two on 35%; PHB everywhere on the rest.
      const topology = random();
      const nvlink = topology >= 0.65;
      for (let a = 0; a < (topology < 0.3 ? 0 : gpus); a++)
        for (let b = a + 1; b < gpus; b++)
          await db.query(
            `INSERT INTO capacity_device_links (node_id, a, b, link) VALUES ($1, $2, $3, $4)`,
            [node, `${node}-g${a}`, `${node}-g${b}`, nvlink && a >> 1 === b >> 1 ? 'NV' : 'PHB'],
          );
      await db.query(
        `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, 'vcpu', 64, 1, $2)`,
        [node, Math.floor(random() * 64)],
      );
      // Bookings: some overlap the window, some are elsewhere in time.
      for (let g = 0; g < gpus; g++) {
        const roll = random();
        if (roll > 0.45) continue;
        const start = roll < 0.35 ? T0 - HOUR / 2 : T0 + 5 * HOUR;
        const allocation = `alloc_${node}_${g}`;
        await db.query(
          `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, resources, during, version)
           VALUES ($1, 'acme', 'pool_s', $2, 'reservation', $1, ARRAY[$3], '{}',
                   tstzrange($4::timestamptz, $5::timestamptz), 1)`,
          [
            allocation,
            node,
            `${node}-g${g}`,
            new Date(start).toISOString(),
            new Date(start + HOUR).toISOString(),
          ],
        );
        await db.query(
          `INSERT INTO device_bookings (device_id, allocation_id, during)
           VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz))`,
          [
            `${node}-g${g}`,
            allocation,
            new Date(start).toISOString(),
            new Date(start + HOUR).toISOString(),
          ],
        );
      }
    }
  });
  afterAll(async () => {
    await db.close();
  });

  const request = (extra: Partial<PlacementRequest>): PlacementRequest => ({
    tenantId: 'acme',
    poolId: 'pool_s',
    reservationId: 'rsv_s',
    devices: [{ class: 'gpu', count: 1 }],
    during: { start: T0, end: T0 + HOUR },
    ...extra,
  });

  const cases: [string, Partial<PlacementRequest>, Record<string, number>][] = [
    ['1 GPU', {}, {}],
    ['1 GPU, spread', {}, { spread: 3, binpack: 0 }],
    ['2 GPUs', { devices: [{ class: 'gpu', count: 2 }] }, {}],
    ['4 GPUs, topology-heavy', { devices: [{ class: 'gpu', count: 4 }] }, { topology: 4 }],
    [
      '3 GPUs + NIC + vCPU',
      {
        devices: [
          { class: 'gpu', count: 3 },
          { class: 'nic', count: 1 },
        ],
        resources: { vcpu: 16 },
      },
      {},
    ],
    ['2 GPUs nvlink-all', { devices: [{ class: 'gpu', count: 2 }], topology: 'nvlink-all' }, {}],
    ['vCPU only', { devices: [], resources: { vcpu: 40 } }, {}],
    ['7 GPUs', { devices: [{ class: 'gpu', count: 7 }] }, { fragmentation: 2 }],
    ['1 GPU excluding the best', { excludeNodes: ['n_000', 'n_001', 'n_002'] }, {}],
    ['1 GPU, image cached somewhere', { imageId: 'img_1' }, {}],
    [
      'vCPU only, image-heavy',
      { devices: [], resources: { vcpu: 8 }, imageId: 'img_1' },
      { 'image-cached': 3 },
    ],
    [
      '2 GPUs, image cached somewhere',
      { devices: [{ class: 'gpu', count: 2 }], imageId: 'img_1' },
      {},
    ],
  ];

  const answered = new Map<string, boolean>();
  for (const [name, extra, weights] of cases)
    it(`ranks the same top N as the whole pool: ${name}`, async () => {
      const req = request(extra);
      await db.transaction(async (tx) => {
        const pool = (await readPool(tx, 'pool_s'))!;
        for (const topN of [1, 5]) {
          // A third of the nodes cache the image, when the request names one.
          const imageCached = req.imageId
            ? new Set(
                Array.from({ length: nodeCount }, (_, i) => i)
                  .filter((i) => i % 3 === 1)
                  .map((i) => `n_${String(i).padStart(3, '0')}`),
              )
            : undefined;
          const full = planPlacement(req, await loadNodeViews(tx, pool, req.during), pool, {
            weights,
            ...(imageCached ? { imageCached } : {}),
          });
          const short = await planFromShortlist(
            tx,
            pool,
            req,
            req.excludeNodes ?? [],
            { plugins: [], weights, topN },
            imageCached,
          );
          answered.set(`${name} top${topN}`, short !== undefined);
          // Declining is always allowed (the placer then plans the whole pool).
          if (!short) continue;
          const top = (plan: { ranked: { nodeId: string; score: number }[] }) =>
            plan.ranked.slice(0, topN).map((entry) => [entry.nodeId, entry.score]);
          expect(top(short.plan), `topN ${topN}`).toEqual(top(full));
          expect(short.views.length).toBeLessThanOrEqual(Math.max(shortlistSize, 8 * topN));
        }
      });
    });

  it('answers without the whole pool when the topology term is constant', () => {
    // One GPU (or none): the SQL counts decide the ranking entirely.
    for (const name of [
      '1 GPU',
      '1 GPU, spread',
      'vCPU only',
      '1 GPU excluding the best',
      '1 GPU, image cached somewhere',
      'vCPU only, image-heavy',
    ])
      for (const topN of [1, 5]) expect(answered.get(`${name} top${topN}`), name).toBe(true);
  });

  it('prefers hosts that cache the image (node_image_cache), and ignores a missing table', async () => {
    const request = {
      tenantId: 'acme',
      poolId: 'pool_s',
      instanceId: 'inst_img',
      imageId: 'img_ubuntu',
      devices: [],
      resources: { vcpu: 1 },
      during: { start: T0, end: T0 + HOUR },
    };
    const context = {
      clock: { now: () => T0 },
      random: () => 0,
      plugins: [],
      weights: { 'image-cached': 10 },
      topN: 1,
    };
    await db
      .transaction(async (tx) => {
        expect(await readImageCachedNodes(tx, 'pool_s', 'img_ubuntu')).toEqual(new Set());
        await tx.query(
          `CREATE TABLE IF NOT EXISTS node_image_cache (node_id text NOT NULL, image_id text NOT NULL,
           state text NOT NULL, bytes bigint, last_used_at timestamptz, PRIMARY KEY (node_id, image_id))`,
        );
        await tx.query(
          `INSERT INTO node_image_cache (node_id, image_id, state) VALUES
           ('n_101', 'img_ubuntu', 'ready'), ('n_102', 'img_ubuntu', 'pulling'), ('n_103', 'img_other', 'ready')`,
        );
        expect(await readImageCachedNodes(tx, 'pool_s', 'img_ubuntu')).toEqual(new Set(['n_101']));
        const outcome = await inlinePlacer().place(tx, request, context);
        expect(outcome).toMatchObject({ status: 'placed', allocations: [{ nodeId: 'n_101' }] });
        throw new Error('rollback');
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error;
      });
  });

  it('declines requests it cannot decide exactly, and nothing that fits is lost', async () => {
    const withScorer: SchedulerPlugin = {
      id: 'custom',
      scorers: [{ id: 'custom', score: () => 1 }],
    } as unknown as SchedulerPlugin;
    expect(shortlistable(request({}), [])).toBe(true);
    expect(shortlistable(request({}), [withScorer])).toBe(false);
    expect(shortlistable(request({ gang: { size: 2 } }), [])).toBe(false);
    expect(
      shortlistable(
        request({ devices: [{ class: 'gpu', count: 1, selector: { model: 'H100' } }] }),
        [],
      ),
    ).toBe(false);
    await db.transaction(async (tx) => {
      const pool = (await readPool(tx, 'pool_s'))!;
      // Nothing has 9 GPUs: the shortlist declines, and the whole-pool plan explains why.
      const req = request({ devices: [{ class: 'gpu', count: 9 }] });
      expect(
        await planFromShortlist(tx, pool, req, [], { plugins: [], weights: {}, topN: 5 }),
      ).toBeUndefined();
    });
  });
});
