import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type PlacementOutcome,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { postgres, sqlState, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  choosePlan,
  createCapacityPort,
  inlinePlacer,
  loadNodeViews,
  planPlacement,
  readPool,
  readPoolCapacity,
  rebuildPoolRollup,
  setQuota,
} from '@better-compute/capacity';

// The v0.1 capacity exit test (PLAN.md §16, §10.4): a seeded workload of reservations interleaved
// with releases, cordons, taints, `healthy` flips and lock-ignoring booking writers, after which
// every §10.4 invariant is checked in SQL. PGlite interleaves transactions on one connection; with
// BETTER_COMPUTE_POSTGRES_URL set the workload also runs truly concurrently, and linearization
// probes pause a placement mid-transaction to race cordons and quarantines against it.

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;
const url = process.env.BETTER_COMPUTE_POSTGRES_URL;

/** mulberry32: a small seeded PRNG, so a failing run replays from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fleet {
  poolId: string;
  churnNodes: string[];
  frozenNodes: string[];
  churnDevices: string[];
  deadDevices: string[];
  devices: string[];
}

async function seedFleet(db: SqlExecutor, nodes: number, gpus: number): Promise<Fleet> {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_t', 'root', 'shared', 'eu', 1)`,
  );
  const poolId = 'pool_t';
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, 'root', 'site_t', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [poolId],
  );
  await setQuota(db, 'acme', poolId, 'gpu', 1_000_000);
  await setQuota(db, 'acme', poolId, 'vcpu', 1_000_000);
  await setQuota(db, 'tight', poolId, 'gpu', 16);
  await setQuota(db, 'tight', poolId, 'vcpu', 1_000_000);
  const fleet: Fleet = {
    poolId,
    churnNodes: [],
    frozenNodes: [],
    churnDevices: [],
    deadDevices: [],
    devices: [],
  };
  for (let n = 0; n < nodes; n++) {
    const id = `node_t${String(n).padStart(3, '0')}`;
    // The last two nodes are cordoned for the whole run: nothing may ever land on them.
    const frozen = n >= nodes - 2;
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                          cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                          identity_gen, shard, version)
       VALUES ($1, 'site_t', $2, 'root', 'host', 'adopted', false, $3, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [id, poolId, frozen],
    );
    (frozen ? fleet.frozenNodes : fleet.churnNodes).push(id);
    await db.query(
      `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, 'vcpu', 64, 2, 0)`,
      [id],
    );
    for (let g = 0; g < gpus; g++) {
      const deviceId = `${id}-g${g}`;
      // One GPU per four nodes is dead for the whole run.
      const dead = g === 0 && n % 4 === 0;
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', true, $3, '{"gpuModel":"H100"}')`,
        [deviceId, id, !dead],
      );
      fleet.devices.push(deviceId);
      if (dead) fleet.deadDevices.push(deviceId);
      else if (!frozen && g === gpus - 1) fleet.churnDevices.push(deviceId);
    }
  }
  await rebuildPoolRollup(db, { id: poolId, ownerTenantId: 'root' });
  return fleet;
}

interface WorkloadResult {
  placed: number;
  pending: number;
  quotaRefused: number;
  released: number;
  attackerRejected: number;
  attackerLanded: number;
  unexpected: unknown[];
}

async function runWorkload(
  db: SqlExecutor,
  fleet: Fleet,
  options: { ops: number; concurrency: number; seed: number },
): Promise<WorkloadResult> {
  const random = prng(options.seed);
  const port = createCapacityPort({ clock: { now: () => T0 } }, { random, topN: 5 });
  const live: string[] = [];
  const result: WorkloadResult = {
    placed: 0,
    pending: 0,
    quotaRefused: 0,
    released: 0,
    attackerRejected: 0,
    attackerLanded: 0,
    unexpected: [],
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const iso = (ms: number) => new Date(ms).toISOString();
  let next = 0;
  let attacker = 0;

  async function step(index: number): Promise<void> {
    const roll = random();
    if (roll < 0.62) {
      const start = T0 + Math.floor(random() * 24) * 15 * 60_000;
      const request = {
        tenantId: random() < 0.15 ? 'tight' : 'acme',
        poolId: fleet.poolId,
        instanceId: `inst_${index}`,
        devices: [{ class: 'gpu' as const, count: 1 + Math.floor(random() * 4) }],
        resources: { vcpu: Math.floor(random() * 9) },
        during: { start, end: start + (1 + Math.floor(random() * 3)) * HOUR },
      };
      try {
        const outcome: PlacementOutcome = await db.transaction((tx) => port.reserve(tx, request));
        if (outcome.status === 'placed') {
          result.placed++;
          live.push(outcome.allocations[0]!.id);
        } else result.pending++;
      } catch (error) {
        if (isComputeError(error, 'QUOTA_EXCEEDED')) result.quotaRefused++;
        else throw error;
      }
    } else if (roll < 0.77) {
      if (live.length === 0) return;
      const allocationId = live.splice(Math.floor(random() * live.length), 1)[0]!;
      await db.transaction((tx) => port.release(tx, allocationId));
      result.released++;
    } else if (roll < 0.83) {
      await db.query(
        `UPDATE nodes SET cordoned = NOT cordoned, version = version + 1 WHERE id = $1`,
        [pick(fleet.churnNodes)],
      );
    } else if (roll < 0.89) {
      await db.query(
        `UPDATE nodes SET no_schedule_reasons = CASE WHEN cardinality(no_schedule_reasons) = 0
                THEN ARRAY['GpuCountMismatch'] ELSE '{}' END, version = version + 1 WHERE id = $1`,
        [pick(fleet.churnNodes)],
      );
    } else if (roll < 0.95) {
      await db.query(`UPDATE devices SET healthy = NOT healthy WHERE id = $1`, [
        pick(fleet.churnDevices),
      ]);
    } else {
      // A lock-ignoring writer: books straight into device_bookings. Only EXCLUDE stands in its way.
      const start = T0 + Math.floor(random() * 24) * 15 * 60_000;
      try {
        await db.query(
          `INSERT INTO device_bookings (device_id, allocation_id, during)
           VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz))`,
          [pick(fleet.devices), `attacker_${attacker++}`, iso(start), iso(start + HOUR)],
        );
        result.attackerLanded++;
      } catch (error) {
        if (sqlState(error) === '23P01') result.attackerRejected++;
        else throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      while (next < options.ops) {
        const index = next++;
        try {
          await step(index);
        } catch (error) {
          result.unexpected.push(error);
        }
      }
    }),
  );
  return result;
}

/** Every §10.4 invariant, checked from the tables. */
async function checkInvariants(db: SqlExecutor, fleet: Fleet): Promise<void> {
  // 1. Device-time exclusivity, attackers included.
  const overlaps = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM device_bookings a JOIN device_bookings b
       ON a.device_id = b.device_id AND a.ctid < b.ctid AND a.during && b.during`,
  );
  expect(Number(overlaps.rows[0]!.count), 'overlapping bookings').toBe(0);

  // 2. Nothing placed on nodes cordoned throughout, or on GPUs dead throughout.
  const forbidden = await db.query<{ device_id: string }>(
    `SELECT b.device_id FROM device_bookings b JOIN allocations a ON a.id = b.allocation_id
      JOIN devices d ON d.id = b.device_id
      WHERE d.node_id = ANY($1::text[]) OR d.id = ANY($2::text[])`,
    [fleet.frozenNodes, fleet.deadDevices],
  );
  expect(forbidden.rows, 'bookings on always-ineligible capacity').toEqual([]);

  // 3. Every live allocation holds exactly its atoms for exactly its interval; released ones hold
  //    nothing (the clock never moves, so a release at T0 deletes every booking it had).
  const mismatched = await db.query<{ id: string }>(
    `SELECT a.id FROM allocations a
      LEFT JOIN device_bookings b ON b.allocation_id = a.id
      GROUP BY a.id, a.atoms, a.during, a.released_at
     HAVING (a.released_at IS NULL AND (count(b.device_id) <> cardinality(a.atoms)
                OR bool_or(b.during <> a.during) OR NOT (array_agg(b.device_id) @> a.atoms)))
         OR (a.released_at IS NOT NULL AND count(b.device_id) > 0)`,
  );
  expect(mismatched.rows, 'allocations whose bookings disagree').toEqual([]);

  // 4. Scalars: node_resources.allocated is the sum of live claims, within floor(allocatable × ratio).
  const scalars = await db.query<{ node_id: string; allocated: string; claimed: string }>(
    `SELECT r.node_id, r.allocated, COALESCE(sum((a.resources->>'vcpu')::bigint), 0) AS claimed
       FROM node_resources r
       LEFT JOIN allocations a ON a.node_id = r.node_id AND a.released_at IS NULL
      WHERE r.resource = 'vcpu'
      GROUP BY r.node_id, r.allocated
     HAVING r.allocated <> COALESCE(sum((a.resources->>'vcpu')::bigint), 0)
         OR r.allocated > 128`,
  );
  expect(scalars.rows, 'scalar counters that drifted').toEqual([]);

  // 5. Quota: `used` equals the live demand of each tenant, and never exceeds `max`.
  const quota = await db.query<{ tenant_id: string; resource: string; used: string; live: string }>(
    `WITH live AS (
       SELECT a.tenant_id, 'gpu' AS resource, cardinality(a.atoms)::bigint AS amount
         FROM allocations a WHERE a.released_at IS NULL
       UNION ALL
       SELECT a.tenant_id, 'vcpu', (a.resources->>'vcpu')::bigint
         FROM allocations a WHERE a.released_at IS NULL AND (a.resources->>'vcpu')::bigint > 0)
     SELECT q.tenant_id, q.resource, q.used, COALESCE(sum(l.amount), 0) AS live
       FROM quota_usage q LEFT JOIN live l ON l.tenant_id = q.tenant_id AND l.resource = q.resource
      GROUP BY q.tenant_id, q.resource, q.used, q.max
     HAVING q.used <> COALESCE(sum(l.amount), 0) OR q.used > q.max`,
  );
  expect(quota.rows, 'quota counters that drifted').toEqual([]);

  // 6. The rollup the booking transactions maintained equals a rebuild from the tables.
  const incremental = (await readPoolCapacity(db, fleet.poolId)).find(
    (row) => row.resource === 'gpu',
  )!;
  const rebuilt = (await rebuildPoolRollup(db, { id: fleet.poolId, ownerTenantId: 'root' })).find(
    (row) => row.resource === 'gpu',
  )!;
  // Attacker rows are bookings too; the deltas never saw them, the rebuild does.
  const attacked = await db.query<{ now: string | number; later: string | number }>(
    `SELECT count(*) FILTER (WHERE during @> compute_now()) AS now,
            count(*) FILTER (WHERE lower(during) > compute_now()) AS later
       FROM device_bookings WHERE allocation_id LIKE 'attacker_%'`,
  );
  expect(incremental.allocated + Number(attacked.rows[0]!.now), 'rollup allocated').toBe(
    rebuilt.allocated,
  );
  expect(incremental.reserved + Number(attacked.rows[0]!.later), 'rollup reserved').toBe(
    rebuilt.reserved,
  );
}

async function freshPglite(): Promise<SqlExecutor> {
  const db = pglite();
  await db.migrate([...capacityMigrations]);
  await useSimClock(db, T0);
  return db;
}

describe('capacity under an interleaved torture workload (PGlite)', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = await freshPglite();
  });
  afterAll(async () => {
    await db.close();
  });

  it('keeps every §10.4 invariant over 1,000 operations', async () => {
    const fleet = await seedFleet(db, 12, 8);
    const seed = 0xc0ffee;
    const result = await runWorkload(db, fleet, { ops: 1000, concurrency: 8, seed });
    expect(result.unexpected, `seed ${seed}`).toEqual([]);
    // The mix really exercised every path.
    expect(result.placed).toBeGreaterThan(200);
    expect(result.pending).toBeGreaterThan(0);
    expect(result.quotaRefused).toBeGreaterThan(0);
    expect(result.released).toBeGreaterThan(50);
    expect(result.attackerRejected).toBeGreaterThan(0);
    await checkInvariants(db, fleet);
  }, 240_000);
});

/** The same database with search_path pinned to `schema` (then public, where btree_gist lives). */
function inSchema(connection: string, schema: string): string {
  const parsed = new URL(connection);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describe.skipIf(!url)('capacity under real concurrency (PostgreSQL)', () => {
  let admin: SqlExecutor;
  let db: SqlExecutor;
  let schema: string;

  beforeAll(async () => {
    admin = postgres({ url: url! });
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    schema = `bc_capacity_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = postgres({ url: inSchema(url!, schema), max: 20 });
    await db.migrate([...capacityMigrations]);
    await useSimClock(db, T0);
  });
  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.close();
  });

  it('keeps every §10.4 invariant over 1,000 concurrent operations, without deadlocks', async () => {
    const fleet = await seedFleet(db, 24, 8);
    const seed = 0x5eed;
    const result = await runWorkload(db, fleet, { ops: 1000, concurrency: 16, seed });
    expect(
      result.unexpected.map((error) => `${sqlState(error) ?? ''} ${String(error)}`),
      `seed ${seed}`,
    ).toEqual([]);
    expect(result.placed).toBeGreaterThan(200);
    await checkInvariants(db, fleet);
  }, 300_000);

  /**
   * Runs a placement that pauses right after a statement containing `pauseAfter` ran, until
   * `resume()`; `paused` resolves with that statement's parameters (what it locked).
   */
  function pausedPlacement(pauseAfter: string, nodeCount: number) {
    let resume!: () => void;
    let reached!: (params: readonly unknown[]) => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const paused = new Promise<readonly unknown[]>((resolve) => (reached = resolve));
    const placer = inlinePlacer();
    const done = db.transaction(async (tx) => {
      const intercept: SqlTx = {
        async query(text, params) {
          const result = await tx.query(text, params);
          if (text.includes(pauseAfter)) {
            reached(params ?? []);
            await gate;
          }
          return result;
        },
      };
      return placer.place(
        intercept,
        {
          tenantId: 'acme',
          poolId: 'pool_t',
          instanceId: `inst_probe_${nodeCount}`,
          devices: [{ class: 'gpu', count: 1 }],
          during: { start: T0 + 30 * HOUR, end: T0 + 31 * HOUR },
        },
        { clock: { now: () => T0 }, random: () => 0, plugins: [], weights: {}, topN: 1 },
      );
    });
    return { done, paused, resume };
  }

  const settle = (ms: number) =>
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

  it('a cordon waits for a placement that locked the node, then applies', async () => {
    const probe = pausedPlacement('FOR SHARE OF n', 1);
    const [nodeId] = (await probe.paused) as [string];
    const cordon = db.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [nodeId]);
    expect(await Promise.race([cordon.then(() => 'applied'), settle(300)])).toBe('timeout');
    probe.resume();
    const outcome = await probe.done;
    await cordon;
    // The placement linearized first: it booked the node the cordon then applied to.
    expect(outcome).toMatchObject({ status: 'placed', allocations: [{ nodeId }] });
    await db.query(`UPDATE nodes SET cordoned = false WHERE id = $1`, [nodeId]);
  });

  it('a placement that locks a node after an uncommitted cordon sees it and replans', async () => {
    // The node the placer will try first: the same pure plan over the same snapshot.
    const during = { start: T0 + 30 * HOUR, end: T0 + 31 * HOUR };
    const pool = (await readPool(db, 'pool_t'))!;
    const plan = planPlacement(
      {
        tenantId: 'acme',
        poolId: 'pool_t',
        instanceId: 'x',
        devices: [{ class: 'gpu', count: 1 }],
        during,
      },
      await loadNodeViews(db, pool, during),
      pool,
    );
    const nodeId = choosePlan(plan.ranked, () => 0, 1)!.nodeId;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const cordoning = db.transaction(async (tx) => {
      await tx.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [nodeId]);
      locked();
      await hold;
    });
    await isLocked;
    const probe = pausedPlacement('this never matches', 2);
    probe.resume();
    expect(await Promise.race([probe.done.then(() => 'placed'), settle(300)])).toBe('timeout');
    release();
    await cordoning;
    const outcome = await probe.done;
    expect(outcome.status).toBe('placed');
    if (outcome.status === 'placed') expect(outcome.allocations[0]!.nodeId).not.toBe(nodeId);
    await db.query(`UPDATE nodes SET cordoned = false WHERE id = $1`, [nodeId]);
  });

  it('a quarantine waits for a placement that locked the atom', async () => {
    const probe = pausedPlacement('AND healthy AND bookable FOR SHARE', 3);
    const [atoms] = (await probe.paused) as [string[]];
    const quarantine = db.query(`UPDATE devices SET healthy = false WHERE id = $1`, [atoms[0]]);
    expect(await Promise.race([quarantine.then(() => 'applied'), settle(300)])).toBe('timeout');
    probe.resume();
    expect(await probe.done).toMatchObject({ status: 'placed', allocations: [{ atoms }] });
    await quarantine;
    await db.query(`UPDATE devices SET healthy = true WHERE id = $1`, [atoms[0]]);
  });
});
