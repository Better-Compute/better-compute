import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NodeView, PlacementRequest, SqlExecutor, SqlTx } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  assertGang,
  capacityMigrations,
  chooseGang,
  inlinePlacer,
  planGangs,
  quotaDemand,
  type NodePlan,
} from '@better-compute/capacity';

// Gang scheduling (PLAN.md §10.3, v0.5): `size` nodes on one topology key, all or nothing, in one
// transaction; plus the §3.3 step 7 gate (a node is schedulable once observedGeneration ≥ 1).

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;

const plan = (nodeId: string, score: number): NodePlan => ({
  nodeId,
  atoms: [`${nodeId}-g0`],
  resources: {},
  scores: {},
  score,
});
const view = (id: string, domain?: string) =>
  ({ id, labels: domain ? { 'fabric.domain': domain } : {} }) as unknown as NodeView;

describe('planGangs', () => {
  const views = [
    view('a1', 'A'),
    view('a2', 'A'),
    view('b1', 'B'),
    view('b2', 'B'),
    view('b3', 'B'),
    view('x'),
  ];
  const ranked = [
    plan('a1', 9),
    plan('b1', 8),
    plan('b2', 7),
    plan('a2', 6),
    plan('b3', 5),
    plan('x', 10),
  ];

  it('groups by the topology key and keeps the best members of groups that are large enough', () => {
    const { gangs } = planGangs(ranked, views, { size: 2, topologyKey: 'fabric.domain' });
    expect(
      gangs.map((gang) => [gang.group, gang.members.map((m) => m.nodeId), gang.score]),
    ).toEqual([
      ['A', ['a1', 'a2'], 15],
      ['B', ['b1', 'b2'], 15],
    ]);
    const three = planGangs(ranked, views, { size: 3, topologyKey: 'fabric.domain' });
    expect(three.gangs.map((gang) => gang.group)).toEqual(['B']);
    expect(planGangs(ranked, views, { size: 4, topologyKey: 'fabric.domain' })).toEqual({
      gangs: [],
      reason: 'no gang of 4 nodes fits in one fabric.domain (at most 3 nodes fit together)',
    });
  });

  it('treats the whole pool as one group without a key, including unlabelled nodes', () => {
    const { gangs } = planGangs(ranked, views, { size: 3 });
    expect(gangs).toHaveLength(1);
    expect(gangs[0]!.members.map((member) => member.nodeId)).toEqual(['a1', 'b1', 'b2']);
  });

  it('picks among the best gangs at random, and validates specs', () => {
    const { gangs } = planGangs(ranked, views, { size: 2, topologyKey: 'fabric.domain' });
    expect(chooseGang(gangs, () => 0.99, 5)!.group).toBe('B');
    expect(chooseGang(gangs, () => 0.99, 1)!.group).toBe('A');
    expect(chooseGang([], () => 0)).toBeUndefined();
    for (const bad of [
      { size: 1 },
      { size: 65 },
      { size: 2.5 },
      { size: 2, topologyKey: '' },
      { size: 2, other: 1 },
      null,
    ])
      expect(() => assertGang(bad), JSON.stringify(bad)).toThrow(/gang:/);
    expect(() => assertGang({ size: 2, topologyKey: 'fabric.domain' })).not.toThrow();
    expect(
      quotaDemand({
        devices: [{ class: 'gpu', count: 4 }],
        resources: { vcpu: 8 },
        gang: { size: 3 },
      }),
    ).toEqual({
      gpu: 12,
      vcpu: 24,
    });
  });
});

describe('the inline placer with gangs', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate([...capacityMigrations]);
  });
  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    for (const table of [
      'pool_capacity_rollup',
      'device_bookings',
      'allocations',
      'node_labels',
      'devices',
      'nodes',
      'pools',
      'sites',
    ])
      await db.query(`DELETE FROM ${table}`);
    await useSimClock(db, T0);
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_g', 'root', 'shared', 'eu', 1)`,
    );
    await db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_g', 'root', 'site_g', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    );
    for (const [node, domain] of [
      ['n_a1', 'A'],
      ['n_a2', 'A'],
      ['n_b1', 'B'],
      ['n_b2', 'B'],
      ['n_b3', 'B'],
    ] as const) {
      await db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                            connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, 'site_g', 'pool_g', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
        [node],
      );
      await db.query(
        `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'fabric.domain', $2, 'inventory')`,
        [node, domain],
      );
      for (let g = 0; g < 4; g++)
        await db.query(
          `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, $2, 'gpu', true, true, '{}')`,
          [`${node}-g${g}`, node],
        );
    }
  });

  const placer = inlinePlacer();
  const context = { clock: { now: () => T0 }, random: () => 0, plugins: [], weights: {}, topN: 1 };
  let sequence = 0;
  const request = (extra: Partial<PlacementRequest> = {}): PlacementRequest => ({
    tenantId: 'acme',
    poolId: 'pool_g',
    reservationId: `rsv_${++sequence}`,
    devices: [{ class: 'gpu', count: 4 }],
    during: { start: T0, end: T0 + HOUR },
    gang: { size: 2, topologyKey: 'fabric.domain' },
    ...extra,
  });
  const place = (req: PlacementRequest, tx?: (inner: SqlTx) => SqlTx) =>
    db.transaction((inner) => placer.place(tx ? tx(inner) : inner, req, context));
  const bookedNodes = async () =>
    (
      await db.query<{ node_id: string; n: string }>(
        `SELECT d.node_id, count(*)::text AS n FROM device_bookings b JOIN devices d ON d.id = b.device_id
          GROUP BY d.node_id ORDER BY d.node_id`,
      )
    ).rows.map((row) => [row.node_id, Number(row.n)]);

  it('books every member on one topology value, one allocation per node', async () => {
    const outcome = await place(request());
    expect(outcome.status).toBe('placed');
    if (outcome.status !== 'placed') return;
    expect(outcome.allocations.map((allocation) => allocation.nodeId)).toEqual(['n_a1', 'n_a2']);
    expect(new Set(outcome.allocations.map((allocation) => allocation.owner.id)).size).toBe(1);
    expect(await bookedNodes()).toEqual([
      ['n_a1', 4],
      ['n_a2', 4],
    ]);
    // Domain A is full: a three-node gang only fits in B, a four-node gang nowhere.
    expect(await place(request({ gang: { size: 3, topologyKey: 'fabric.domain' } }))).toMatchObject(
      { status: 'placed' },
    );
    expect(await place(request())).toMatchObject({
      status: 'pending',
      reason: 'no node fits (5 nodes): 5 × fits: 0 of 4 gpu free',
    });
  });

  it('rolls the whole gang back when one member loses a race, and replans without it', async () => {
    let raced = false;
    const outcome = await place(request(), (inner) => ({
      async query(text, params) {
        // Cordon the second member just before it is locked.
        if (!raced && text.includes('FOR SHARE OF n') && params?.[0] === 'n_a2') {
          raced = true;
          await inner.query(`UPDATE nodes SET cordoned = true WHERE id = 'n_a2'`);
        }
        return inner.query(text, params);
      },
    }));
    expect(raced).toBe(true);
    expect(outcome).toMatchObject({
      status: 'placed',
      allocations: [{ nodeId: 'n_b1' }, { nodeId: 'n_b2' }],
    });
    // Nothing of the first attempt survived on n_a1.
    expect(await bookedNodes()).toEqual([
      ['n_b1', 4],
      ['n_b2', 4],
    ]);
    const { rows } = await db.query(`SELECT 1 FROM allocations WHERE node_id = 'n_a1'`);
    expect(rows).toEqual([]);
  });

  it('answers pending with the conflict trail when every replan loses', async () => {
    const outcome = await place(request({ gang: { size: 2 } }), (inner) => ({
      async query(text, params) {
        if (text.includes('FOR SHARE OF n') && params?.[0] !== 'n_a1')
          await inner.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [params![0]]);
        return inner.query(text, params);
      },
    }));
    expect(outcome.status).toBe('pending');
    expect(await bookedNodes()).toEqual([]);
  });

  it('holds back nodes that have not converged their first spec (§3.3 step 7)', async () => {
    await db.query(`UPDATE nodes SET observed_generation = 0 WHERE id IN ('n_b1', 'n_b2', 'n_b3')`);
    expect(await place(request({ gang: { size: 3, topologyKey: 'fabric.domain' } }))).toMatchObject(
      {
        status: 'pending',
        reason: expect.stringContaining('awaiting its first converged spec'),
      },
    );
    await db.query(`UPDATE nodes SET observed_generation = 1`);
    expect(await place(request({ gang: { size: 3, topologyKey: 'fabric.domain' } }))).toMatchObject(
      { status: 'placed' },
    );
  });

  it('rejects invalid gangs before taking any lock', async () => {
    await expect(place(request({ gang: { size: 1 } }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
