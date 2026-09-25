import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isComputeError,
  reservationQuotaStates,
  type Caller,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { postgres, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  capacityModule,
  quotaDemand,
  readPoolCapacity,
  rebuildPoolRollup,
  reservationWork,
  setQuota,
  type CapacityApi,
} from '@better-compute/capacity';

// The reservation-level torture workload (PLAN.md §10.4, v0.4/v0.5 paths). A seeded, interleaved mix:
// - creates through the inline placer and the pool-lease placer, spot and regular, now and later, so
//   regular requests preempt spot work;
// - pool-lease batches, lifecycle reconciles, releases, cancels;
// - cordons and GPU health flips.
// Afterwards the invariants are checked from the tables: device-time exclusivity; bookings that
// match their allocations; quota equal to the demand of non-terminal reservations; allocations only
// where the state says so; regular reservations never preempted; the rollup equal to a rebuild.

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;
const POOL = 'pool_01jz00000000000000000000tt';
const url = process.env.BETTER_COMPUTE_POSTGRES_URL;

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

const caller: Caller = {
  identityId: 'usr_t',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 'ses_t',
  sessionKind: 'user',
  mfa: false,
};

/** Runs the workload on `db` (migrated, sim clock at T0) and checks every invariant. */
async function runTorture(db: SqlExecutor, concurrency: number): Promise<void> {
  const context = (sql: SqlExecutor): ModuleContext =>
    ({
      sql,
      clock: { now: () => T0 },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      authz: { async upsert() {}, async remove() {}, async setPending() {} },
      events: { async publish() {} },
      work: { async enqueue() {} },
      desired: { async invalidate() {} },
    }) as unknown as ModuleContext;
  const within = (tx: SqlTx): SqlExecutor => ({
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  });

  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_t', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ($1, 'root', 'site_t', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [POOL],
  );
  await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'acme')`, [POOL]);
  await setQuota(db, 'acme', POOL, 'gpu', 1_000_000);
  const nodes: string[] = [];
  const devices: string[] = [];
  for (let n = 0; n < 8; n++) {
    const id = `node_t${n}`;
    nodes.push(id);
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                            cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                            identity_gen, shard, version)
         VALUES ($1, 'site_t', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [id, POOL],
    );
    for (let g = 0; g < 4; g++) {
      devices.push(`${id}-g${g}`);
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
           VALUES ($1, $2, 'gpu', true, true, '{}')`,
        [`${id}-g${g}`, id],
      );
    }
  }
  await rebuildPoolRollup(db, { id: POOL, ownerTenantId: 'root' });

  const seed = Number(process.env.TORTURE_SEED ?? 0x5eed);
  const random = prng(seed);
  const inline = capacityModule({ random, topN: 3 });
  const batching = capacityModule({ random, topN: 3, placer: 'pool-lease', maxBatch: 8 });
  const apis = [inline, batching].map((module) => module.api!(context(db)) as CapacityApi);
  type Definition = {
    validate(raw: unknown): unknown;
    handler(context: MethodContext, input: unknown): Promise<unknown>;
    admission?: {
      prepare(
        c: MethodContext,
        i: unknown,
        tx: SqlTx,
      ): Promise<{ status: string; result?: unknown }>;
    };
  };
  const call = async (api: CapacityApi, group: string, method: string, raw: unknown) => {
    const definition = (api as unknown as Record<string, Record<string, Definition>>)[group]![
      method
    ]!;
    const input = definition.validate(raw);
    const ctx = (tx: SqlTx) =>
      ({ ...context(within(tx)), caller, requestId: 'req' }) as MethodContext;
    if (definition.admission) {
      const plan = await db.transaction((tx) => definition.admission!.prepare(ctx(tx), input, tx));
      if (plan.status === 'replay') return plan.result;
    }
    return db.transaction((tx) => definition.handler(ctx(tx), input));
  };
  const run = (module: typeof inline, kind: string, key: string) =>
    module
      .reconcilers!.find((entry) => entry.name === kind)!
      .run({ ...context(db), signal: new AbortController().signal }, key);

  const ids: string[] = [];
  const unexpected: unknown[] = [];
  let next = 0;
  // Racing lifecycle steps on one reservation lose with CONFLICT; releasing a terminal or cancelling
  // a started one is INVALID_STATE. Both are answers, not faults.
  const refusals = { CONFLICT: 0, INVALID_STATE: 0 };
  const tolerated = (error: unknown) => {
    for (const code of ['CONFLICT', 'INVALID_STATE'] as const)
      if (isComputeError(error, code)) return ++refusals[code] > 0;
    return false;
  };
  async function step(index: number): Promise<void> {
    const roll = random();
    if (roll < 0.45) {
      const start = random() < 0.6 ? undefined : T0 + Math.floor(random() * 12) * 15 * 60_000;
      const created = (await call(apis[random() < 0.5 ? 0 : 1]!, 'reservations', 'create', {
        tenantId: 'acme',
        poolId: POOL,
        devices: [{ class: 'gpu', count: 1 + Math.floor(random() * 3) }],
        duration: `${1 + Math.floor(random() * 3)}h`,
        idempotencyKey: `k${index}`,
        ...(start !== undefined ? { start } : {}),
        ...(random() < 0.4 ? { spot: true } : {}),
      })) as { id: string };
      ids.push(created.id);
    } else if (roll < 0.6) {
      await run(batching, 'capacity.placer', POOL);
    } else if (roll < 0.75) {
      if (ids.length) await run(inline, reservationWork, ids[Math.floor(random() * ids.length)]!);
    } else if (roll < 0.85) {
      if (!ids.length) return;
      const id = ids[Math.floor(random() * ids.length)]!;
      await call(apis[0]!, 'reservations', random() < 0.5 ? 'release' : 'cancel', {
        tenantId: 'acme',
        reservationId: id,
      });
    } else if (roll < 0.92) {
      await db.query(`UPDATE nodes SET cordoned = NOT cordoned WHERE id = $1`, [
        nodes[Math.floor(random() * nodes.length)],
      ]);
    } else {
      await db.query(`UPDATE devices SET healthy = NOT healthy WHERE id = $1`, [
        devices[Math.floor(random() * devices.length)],
      ]);
    }
  }
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < 600) {
        const index = next++;
        try {
          await step(index);
        } catch (error) {
          if (!tolerated(error)) unexpected.push(error);
        }
      }
    }),
  );
  expect(unexpected, `seed ${seed}`).toEqual([]);
  if (process.env.TORTURE_SEED) console.log(`seed ${seed}`, JSON.stringify(refusals));

  // 1. Device-time exclusivity.
  const overlaps = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM device_bookings a JOIN device_bookings b
         ON a.device_id = b.device_id AND a.ctid < b.ctid AND a.during && b.during`,
  );
  expect(overlaps.rows[0]!.n, 'overlapping bookings').toBe('0');

  // 2. Live allocations hold exactly their atoms for exactly their (possibly cut-back) interval.
  const mismatched = await db.query(
    `SELECT a.id FROM allocations a LEFT JOIN device_bookings b ON b.allocation_id = a.id
        WHERE a.released_at IS NULL
        GROUP BY a.id, a.atoms, a.during
       HAVING count(b.device_id) <> cardinality(a.atoms) OR bool_or(b.during <> a.during)`,
  );
  expect(mismatched.rows, 'allocations whose bookings disagree').toEqual([]);

  // 3. Quota equals the demand of non-terminal reservations (D9).
  const { rows: reservations } = await db.query<{
    id: string;
    state: string;
    request: { devices: { class: string; count: number }[]; spot?: boolean };
    conditions: { type: string }[];
  }>(`SELECT id, state, request, conditions FROM reservations`);
  let demand = 0;
  for (const row of reservations)
    if ((reservationQuotaStates as readonly string[]).includes(row.state))
      demand += quotaDemand(row.request).gpu ?? 0;
  const quota = await db.query<{ used: string }>(
    `SELECT used::text AS used FROM quota_usage WHERE tenant_id = 'acme' AND pool_id = $1 AND resource = 'gpu'`,
    [POOL],
  );
  expect(Number(quota.rows[0]!.used), 'quota used').toBe(demand);

  // 4. Allocations only where the state says so; only spot reservations were ever preempted.
  const live = await db.query<{ owner_id: string }>(
    `SELECT DISTINCT owner_id FROM allocations WHERE released_at IS NULL`,
  );
  const holding = new Set(live.rows.map((row) => row.owner_id));
  for (const row of reservations) {
    const shouldHold = ['placed', 'binding', 'active'].includes(row.state);
    expect(holding.has(row.id), `${row.id} is ${row.state}`).toBe(shouldHold);
    if (row.request.spot !== true)
      expect(row.conditions.map((condition) => condition.type)).not.toContain('Preempted');
  }

  // 5. The incrementally maintained rollup equals a rebuild.
  const incremental = (await readPoolCapacity(db, POOL)).find((row) => row.resource === 'gpu')!;
  const rebuilt = (await rebuildPoolRollup(db, { id: POOL, ownerTenantId: 'root' })).find(
    (row) => row.resource === 'gpu',
  )!;
  expect([incremental.allocated, incremental.reserved]).toEqual([
    rebuilt.allocated,
    rebuilt.reserved,
  ]);

  // The mix exercised the paths it is here for.
  const states = reservations.map((row) => row.state);
  expect(states.filter((state) => state === 'placed').length).toBeGreaterThan(10);
  expect(reservations.some((row) => row.conditions.some((c) => c.type === 'Preempted'))).toBe(true);
  expect(states).toContain('pending');
}

describe('reservations under an interleaved torture workload (PGlite)', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate([...capacityMigrations]);
    await useSimClock(db, T0);
  });
  afterAll(async () => {
    await db.close();
  });

  it('keeps every invariant over 600 operations', () => runTorture(db, 6), 240_000);
});

/** The same database with search_path pinned to `schema` (then public, where btree_gist lives). */
function inSchema(connection: string, schema: string): string {
  const parsed = new URL(connection);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

// With BETTER_COMPUTE_POSTGRES_URL: the same workload truly concurrent, so pool-lease batches, inline
// placements, preemption and releases race for real (a deadlock or serialization failure fails it).
describe.skipIf(!url)('reservations under real concurrency (PostgreSQL)', () => {
  let admin: SqlExecutor;
  let db: SqlExecutor;
  let schema: string;
  beforeAll(async () => {
    admin = postgres({ url: url! });
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    schema = `bc_rsv_torture_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  it(
    'keeps every invariant over 600 concurrent operations, without deadlocks',
    () => runTorture(db, 16),
    300_000,
  );
});
