import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type PlacementContext,
  type PlacementRequest,
  type SqlExecutor,
} from '@better-compute/core';
import { postgres, sqlState, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  bookPartitionChange,
  capacityMigrations,
  chargeQuota,
  createCapacityPort,
  extendAllocation,
  lockPool,
  parseSelector,
  placeFromIndex,
  PoolIndex,
  PoolIndexCache,
  quotaDemand,
  readPool,
  readPoolCapacity,
  rebuildPoolRollup,
  refundQuota,
  releasePartitionChange,
  schedulableSql,
  setQuota,
} from '@better-compute/capacity';

// The §15 torture shape (PLAN.md §10.4, §15 "The 5-minute torture test"), and the v0.5 MIG torture
// test: 8 placers race on one MIG pool — 4 inline (the pool lock), 2 pool-lease batches (the pool
// lock, a cached index), and 2 that IGNORE the pool lock and lease (a stale index, straight to the
// guarded commit statements) — plus extends, releases, cordons, taint writes, `healthy` flips and
// MIG repartitions (a mode or layout change books the GPU's whole atom family, §10.4 point 2).
//
// A trigger mirrors every write to device_bookings into a constraint-free shadow log, with the
// node's schedulability and the atom's health/bookability at the moment of the write. Afterwards
// the history is replayed: no two bookings that share physical GPU capacity (the same atom, a parent
// and its child, or children of different MIG layouts — which EXCLUDE cannot see) were ever live
// over overlapping time; every new booking was schedulable when written; the shadow's final state is
// the table; quota sums, allocations and the rollup agree. TORTURE_OPS / TORTURE_SEED scale and
// replay it (the full 5-minute run: TORTURE_OPS=20000).

const T0 = Date.UTC(2026, 8, 24, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Every booking ends before this; a repartition books the family up to it (idle from now on). */
const HORIZON = T0 + 7 * 24 * HOUR;
const POOL = 'pool_01jz00000000000000000000mg';
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

type Mode = 'whole' | 'A' | 'B';
/** MIG layouts: A = 3g + 4g, B = seven 1g instances. `whole` = the parent is the atom. */
const layouts: Record<Exclude<Mode, 'whole'>, { suffix: string; profile: string }[]> = {
  A: [
    { suffix: 'gi1/ci0', profile: '3g.40gb' },
    { suffix: 'gi2/ci0', profile: '4g.40gb' },
  ],
  B: Array.from({ length: 7 }, (_, k) => ({ suffix: `gi${9 + k}/ci0`, profile: '1g.10gb' })),
};

interface Fleet {
  nodes: string[];
  gpus: string[];
  /** Every device: its family (the parent GPU), whether it is the parent, and its layout. */
  devices: Map<string, { family: string; parent: boolean; layout?: string }>;
}

async function seed(db: SqlExecutor, nodeCount: number, gpusPerNode: number): Promise<Fleet> {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_m', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, 'root', 'site_m', 'metal-host', 'H100', 'mig', 'bcd', '{}', 1)`,
    [POOL],
  );
  for (const resource of ['gpu', 'gpu.mig']) {
    await setQuota(db, 'acme', POOL, resource, 1_000_000);
    await setQuota(db, 'tight', POOL, resource, 6);
  }
  const fleet: Fleet = { nodes: [], gpus: [], devices: new Map() };
  for (let n = 0; n < nodeCount; n++) {
    const node = `node_m${String(n).padStart(2, '0')}`;
    fleet.nodes.push(node);
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                          cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                          identity_gen, shard, version)
       VALUES ($1, 'site_m', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [node, POOL],
    );
    for (let g = 0; g < gpusPerNode; g++) {
      const gpu = `${node}-g${g}`;
      const mode: Mode = (['whole', 'A', 'B'] as const)[(n + g) % 3]!;
      fleet.gpus.push(gpu);
      fleet.devices.set(gpu, { family: gpu, parent: true });
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', $3, true, '{"gpuModel":"H100"}')`,
        [gpu, node, mode === 'whole'],
      );
      for (const [layout, atoms] of Object.entries(layouts))
        for (const atom of atoms) {
          const id = `${gpu}/${atom.suffix}`;
          fleet.devices.set(id, { family: gpu, parent: false, layout });
          await db.query(
            `INSERT INTO devices (id, node_id, parent_id, class, bookable, healthy, attributes)
             VALUES ($1, $2, $3, 'gpu.mig', $4, true, $5::jsonb)`,
            [
              id,
              node,
              gpu,
              mode === layout,
              JSON.stringify({ gpuModel: 'H100', migProfile: atom.profile, layout }),
            ],
          );
        }
    }
  }
  await rebuildPoolRollup(db, { id: POOL, ownerTenantId: 'root' });

  // The shadow: every row change of device_bookings, with what held when it was written.
  await db.query(`CREATE TABLE torture_shadow (
    seq bigserial PRIMARY KEY,
    op text NOT NULL,
    device_id text NOT NULL,
    allocation_id text NOT NULL,
    start_ms float8 NOT NULL,
    end_ms float8 NOT NULL,
    rewrite boolean NOT NULL,
    node_ok boolean,
    atom_ok boolean)`);
  await db.query(`CREATE FUNCTION torture_shadow_log() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP IN ('DELETE', 'UPDATE') THEN
        INSERT INTO torture_shadow (op, device_id, allocation_id, start_ms, end_ms, rewrite)
        VALUES ('-', OLD.device_id, OLD.allocation_id,
                extract(epoch FROM lower(OLD.during)) * 1000, extract(epoch FROM upper(OLD.during)) * 1000,
                TG_OP = 'UPDATE');
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO torture_shadow (op, device_id, allocation_id, start_ms, end_ms, rewrite, node_ok, atom_ok)
        SELECT '+', NEW.device_id, NEW.allocation_id,
               extract(epoch FROM lower(NEW.during)) * 1000, extract(epoch FROM upper(NEW.during)) * 1000,
               TG_OP = 'UPDATE', (${schedulableSql}), d.healthy AND d.bookable
          FROM devices d JOIN nodes n ON n.id = d.node_id JOIN pools p ON p.id = n.pool_id
         WHERE d.id = NEW.device_id;
      END IF;
      RETURN NULL;
    END $$`);
  await db.query(`CREATE TRIGGER torture_shadow AFTER INSERT OR UPDATE OR DELETE ON device_bookings
    FOR EACH ROW EXECUTE FUNCTION torture_shadow_log()`);
  return fleet;
}

interface Result {
  placed: Record<string, number>;
  pending: number;
  quotaRefused: number;
  released: number;
  extended: number;
  extendConflicts: number;
  repartitioned: number;
  repartitionConflicts: number;
  unexpected: unknown[];
}

async function runTorture(
  db: SqlExecutor,
  fleet: Fleet,
  options: { ops: number; seed: number },
): Promise<Result> {
  const random = prng(options.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const context: PlacementContext = {
    clock: { now: () => T0 },
    random,
    plugins: [],
    weights: {},
    topN: 3,
  };
  const port = createCapacityPort({ clock: { now: () => T0 } }, { random, topN: 3 });
  const live: string[] = [];
  const result: Result = {
    placed: { inline: 0, batch: 0, ignoring: 0 },
    pending: 0,
    quotaRefused: 0,
    released: 0,
    extended: 0,
    extendConflicts: 0,
    repartitioned: 0,
    repartitionConflicts: 0,
    unexpected: [],
  };
  let sequence = 0;
  const request = (): PlacementRequest => {
    const start = T0 + Math.floor(random() * 64) * 15 * MIN;
    const during = { start, end: start + (1 + Math.floor(random() * 4)) * HOUR };
    const tenantId = random() < 0.1 ? 'tight' : 'acme';
    const id = `rsv_t${++sequence}`;
    const roll = random();
    const devices: PlacementRequest['devices'] =
      roll < 0.35
        ? [{ class: 'gpu', count: 1 + Math.floor(random() * 2) }]
        : roll < 0.7
          ? [{ class: 'gpu.mig', count: 1 + Math.floor(random() * 3) }]
          : [
              {
                class: 'gpu.mig',
                count: 1,
                selector: parseSelector(
                  `migProfile in (${pick(['1g.10gb', '3g.40gb', '4g.40gb'])})`,
                ),
              },
            ];
    return { tenantId, poolId: POOL, reservationId: id, devices, during };
  };
  /** Charges quota in its own transaction (quota before pools, the lock order); false if refused. */
  const charge = async (req: PlacementRequest) => {
    try {
      await db.transaction((tx) => chargeQuota(tx, req.tenantId, POOL, quotaDemand(req)));
      return true;
    } catch (error) {
      if (!isComputeError(error, 'QUOTA_EXCEEDED')) throw error;
      result.quotaRefused++;
      return false;
    }
  };
  const refund = (reqs: PlacementRequest[]) =>
    reqs.length === 0
      ? Promise.resolve()
      : db.transaction(async (tx) => {
          for (const req of reqs) await refundQuota(tx, req.tenantId, POOL, quotaDemand(req));
        });

  // Placer kinds, one per worker: 0-3 inline, 4-5 pool-lease batches, 6-7 lock- and lease-ignoring.
  const cache = new PoolIndexCache();
  let batchClock = T0;
  const stale: (PoolIndex | undefined)[] = [];
  const staleAge: number[] = [];
  async function place(worker: number): Promise<void> {
    if (worker < 4) {
      const req = request();
      try {
        const outcome = await db.transaction((tx) => port.reserve(tx, req));
        if (outcome.status === 'placed') {
          result.placed.inline!++;
          live.push(outcome.allocations[0]!.id);
        } else result.pending++;
      } catch (error) {
        if (isComputeError(error, 'QUOTA_EXCEEDED')) result.quotaRefused++;
        else throw error;
      }
      return;
    }
    const batch: PlacementRequest[] = [];
    for (let i = 0; i < (worker < 6 ? 4 : 1); i++) {
      const req = request();
      if (await charge(req)) batch.push(req);
    }
    // Committed placements, by request; everything else is refunded afterwards.
    const committed = new Map<PlacementRequest, string>();
    try {
      if (worker < 6) {
        // The pool-lease worker: pool lock, the cached index (rebuilt when older than 5 s).
        batchClock += 1_500;
        let keep: (() => void) | undefined;
        const placed = await db.transaction(async (tx) => {
          const pool = await lockPool(tx, POOL);
          const checkout = await cache.checkout(tx, pool, batchClock);
          keep = checkout.keep;
          const out = new Map<PlacementRequest, string>();
          for (const req of batch) {
            const outcome = await placeFromIndex(tx, checkout.index, req, context);
            if (outcome.status === 'placed') out.set(req, outcome.allocations[0]!.id);
          }
          return out;
        });
        keep?.();
        for (const [req, id] of placed) committed.set(req, id);
        result.placed.batch! += placed.size;
      } else {
        // Ignores the pool lock and the lease: an index up to 12 of its own steps old, no lockPool.
        // Only the guarded statements (nodes/atoms FOR SHARE, EXCLUDE) stand between it and the rest.
        const slot = worker - 6;
        staleAge[slot] = (staleAge[slot] ?? 0) + 1;
        if (!stale[slot] || staleAge[slot]! > 12) {
          stale[slot] = await db.transaction(async (tx) =>
            PoolIndex.load(tx, (await readPool(tx, POOL))!, T0),
          );
          staleAge[slot] = 0;
        }
        for (const req of batch) {
          const outcome = await db.transaction((tx) =>
            placeFromIndex(tx, stale[slot]!, req, context),
          );
          if (outcome.status === 'placed') {
            committed.set(req, outcome.allocations[0]!.id);
            result.placed.ignoring!++;
          }
        }
      }
    } finally {
      live.push(...committed.values());
      const unplaced = batch.filter((req) => !committed.has(req));
      result.pending += unplaced.length;
      await refund(unplaced);
    }
  }

  async function chaos(): Promise<void> {
    const roll = random();
    if (roll < 0.4) {
      if (live.length === 0) return;
      const allocationId = live.splice(Math.floor(random() * live.length), 1)[0]!;
      await db.transaction((tx) => port.release(tx, allocationId));
      result.released++;
    } else if (roll < 0.5) {
      if (live.length === 0) return;
      const allocationId = pick(live);
      const outcome = await db.transaction(async (tx) => {
        const { rows } = await tx.query<{ end_ms: number }>(
          `SELECT (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms FROM allocations WHERE id = $1`,
          [allocationId],
        );
        const end = Number(rows[0]!.end_ms) + (1 + Math.floor(random() * 8)) * 15 * MIN;
        return extendAllocation(tx, allocationId, Math.min(end, HORIZON - HOUR));
      });
      if (outcome.status === 'extended') result.extended++;
      else result.extendConflicts++;
    } else if (roll < 0.58) {
      await db.query(
        `UPDATE nodes SET cordoned = NOT cordoned, version = version + 1 WHERE id = $1`,
        [pick(fleet.nodes)],
      );
    } else if (roll < 0.65) {
      await db.query(
        `UPDATE nodes SET no_schedule_reasons = CASE WHEN cardinality(no_schedule_reasons) = 0
                THEN ARRAY['XidStorm'] ELSE '{}' END, version = version + 1 WHERE id = $1`,
        [pick(fleet.nodes)],
      );
    } else if (roll < 0.8) {
      await db.query(`UPDATE devices SET healthy = NOT healthy WHERE id = $1`, [
        pick([...fleet.devices.keys()]),
      ]);
    } else {
      // A MIG mode or layout change: the whole family, idle from now to the horizon, then the flip.
      const gpu = pick(fleet.gpus);
      const next = pick(['whole', 'A', 'B'] as const);
      await db.transaction(async (tx) => {
        const change = await bookPartitionChange(tx, {
          gpuId: gpu,
          during: { start: T0, end: HORIZON },
        });
        if (change.status !== 'booked') {
          result.repartitionConflicts++;
          return;
        }
        await tx.query(
          `UPDATE devices SET bookable = CASE WHEN id = $1 THEN $2 = 'whole'
                                              ELSE attributes->>'layout' = $2 END
            WHERE id = $1 OR parent_id = $1`,
          [gpu, next],
        );
        await releasePartitionChange(tx, change.bookingId);
        // As inventory does after a device change: the rollup follows the new atoms.
        await rebuildPoolRollup(tx, { id: POOL, ownerTenantId: 'root' });
        result.repartitioned++;
      });
    }
  }

  let next = 0;
  // Racing steps lose with CONFLICT or INVALID_STATE (a released allocation, a lost race): answers.
  const tolerated = (error: unknown) =>
    isComputeError(error, 'CONFLICT') || isComputeError(error, 'INVALID_STATE');
  await Promise.all(
    Array.from({ length: 8 }, async (_, worker) => {
      while (next < options.ops) {
        next++;
        try {
          if (random() < 0.5) await place(worker);
          else await chaos();
        } catch (error) {
          if (!tolerated(error)) result.unexpected.push(error);
        }
      }
    }),
  );
  return result;
}

/** Physical GPU capacity shared by two atoms of one family (what EXCLUDE on device_id cannot see). */
function share(fleet: Fleet, a: string, b: string): boolean {
  if (a === b) return true;
  const x = fleet.devices.get(a);
  const y = fleet.devices.get(b);
  if (!x || !y || x.family !== y.family) return false;
  return x.parent || y.parent || x.layout !== y.layout;
}

async function checkInvariants(db: SqlExecutor, fleet: Fleet): Promise<{ bookings: number }> {
  // 1. Replay the shadow: each booking lives from its '+' to its '-' (sequence numbers).
  // (seq::text aliased apart from seq: ORDER BY an alias of the cast would sort text.)
  const { rows: log } = await db.query<{
    seq_text: string;
    op: '+' | '-';
    device_id: string;
    allocation_id: string;
    start_ms: number;
    end_ms: number;
    rewrite: boolean;
    node_ok: boolean | null;
    atom_ok: boolean | null;
  }>(`SELECT s.seq::text AS seq_text, s.op, s.device_id, s.allocation_id, s.start_ms, s.end_ms,
             s.rewrite, s.node_ok, s.atom_ok
        FROM torture_shadow s ORDER BY s.seq`);
  interface Life {
    device: string;
    allocation: string;
    start: number;
    end: number;
    born: number;
    died: number;
  }
  const open = new Map<string, Life>();
  const lives: Life[] = [];
  const unschedulable: string[] = [];
  const key = (row: {
    device_id: string;
    allocation_id: string;
    start_ms: number;
    end_ms: number;
  }) => `${row.device_id}|${row.allocation_id}|${Number(row.start_ms)}|${Number(row.end_ms)}`;
  for (const row of log) {
    const seq = Number(row.seq_text);
    if (row.op === '+') {
      open.set(key(row), {
        device: row.device_id,
        allocation: row.allocation_id,
        start: Number(row.start_ms),
        end: Number(row.end_ms),
        born: seq,
        died: Infinity,
      });
      // A new booking (not an extend or a release cut-back) lands only on schedulable capacity.
      if (!row.rewrite && !row.allocation_id.startsWith('partition:'))
        if (!row.node_ok || !row.atom_ok)
          unschedulable.push(`${row.allocation_id} on ${row.device_id} (seq ${seq})`);
    } else {
      const life = open.get(key(row));
      expect(life, `shadow '-' without '+' at seq ${seq}`).toBeDefined();
      life!.died = seq;
      lives.push(life!);
      open.delete(key(row));
    }
  }
  lives.push(...open.values());
  expect(unschedulable, 'bookings written on unschedulable capacity').toEqual([]);

  // 2. No two bookings sharing physical capacity were ever live over overlapping time.
  const byFamily = new Map<string, Life[]>();
  for (const life of lives) {
    const family = fleet.devices.get(life.device)?.family ?? life.device;
    byFamily.set(family, [...(byFamily.get(family) ?? []), life]);
  }
  const overlaps: string[] = [];
  for (const family of byFamily.values())
    for (let i = 0; i < family.length; i++)
      for (let j = i + 1; j < family.length; j++) {
        const a = family[i]!;
        const b = family[j]!;
        if (a.allocation === b.allocation || !share(fleet, a.device, b.device)) continue;
        if (a.start < b.end && b.start < a.end && a.born < b.died && b.born < a.died)
          overlaps.push(`${a.allocation}@${a.device} × ${b.allocation}@${b.device}`);
      }
  expect(overlaps, 'bookings sharing a GPU at the same time').toEqual([]);

  // 3. The shadow saw every write: its live set is the table.
  const { rows: table } = await db.query<{
    device_id: string;
    allocation_id: string;
    start_ms: number;
    end_ms: number;
  }>(
    `SELECT device_id, allocation_id, (extract(epoch FROM lower(during)) * 1000)::float8 AS start_ms,
            (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms FROM device_bookings`,
  );
  expect(new Set(table.map(key))).toEqual(new Set(open.keys()));
  expect(table.some((row) => row.allocation_id.startsWith('partition:'))).toBe(false);

  // 4. Live allocations hold exactly their atoms for their interval; released ones hold nothing.
  const mismatched = await db.query<{ id: string }>(
    `SELECT a.id FROM allocations a LEFT JOIN device_bookings b ON b.allocation_id = a.id
      GROUP BY a.id, a.atoms, a.during, a.released_at
     HAVING (a.released_at IS NULL AND (count(b.device_id) <> cardinality(a.atoms)
                OR bool_or(b.during <> a.during) OR NOT (array_agg(b.device_id) @> a.atoms)))
         OR (a.released_at IS NOT NULL AND count(b.device_id) > 0)`,
  );
  expect(mismatched.rows, 'allocations whose bookings disagree').toEqual([]);

  // 5. Quota: `used` is the live atom count per tenant and class, never above `max`.
  const quota = await db.query<{ tenant_id: string; resource: string }>(
    `WITH live AS (
       SELECT a.tenant_id, d.class AS resource, count(*)::bigint AS amount
         FROM allocations a CROSS JOIN LATERAL unnest(a.atoms) atom JOIN devices d ON d.id = atom
        WHERE a.released_at IS NULL GROUP BY a.tenant_id, d.class)
     SELECT q.tenant_id, q.resource FROM quota_usage q
       LEFT JOIN live l ON l.tenant_id = q.tenant_id AND l.resource = q.resource
      WHERE q.pool_id = $1 AND (q.used <> COALESCE(l.amount, 0) OR q.used > q.max)`,
    [POOL],
  );
  expect(quota.rows, 'quota counters that drifted').toEqual([]);

  // 6. The incrementally maintained rollup equals a rebuild.
  const incremental = await readPoolCapacity(db, POOL);
  const rebuilt = await rebuildPoolRollup(db, { id: POOL, ownerTenantId: 'root' });
  const counters = (rows: typeof rebuilt) =>
    rows
      .map((row) => [row.resource, row.allocated, row.reserved])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  expect(counters(incremental), 'rollup').toEqual(counters(rebuilt));
  return { bookings: lives.length };
}

const ops = Number(process.env.TORTURE_OPS ?? 1200);
const seedValue = Number(process.env.TORTURE_SEED ?? 0x3161);

describe('the capacity torture test on a MIG pool (PGlite, interleaved)', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate([...capacityMigrations]);
    await useSimClock(db, T0);
  });
  afterAll(async () => {
    await db.close();
  });

  it(`keeps every invariant over ${ops} operations`, async () => {
    const fleet = await seed(db, 10, 4);
    const result = await runTorture(db, fleet, { ops, seed: seedValue });
    expect(result.unexpected, `seed ${seedValue}`).toEqual([]);
    const { bookings } = await checkInvariants(db, fleet);
    if (process.env.TORTURE_SEED)
      console.log(`seed ${seedValue}`, JSON.stringify(result), bookings);
    // The mix exercised what it is here for.
    expect(result.placed.inline).toBeGreaterThan(50);
    expect(result.placed.batch).toBeGreaterThan(50);
    expect(result.placed.ignoring).toBeGreaterThan(20);
    expect(result.pending).toBeGreaterThan(0);
    expect(result.quotaRefused).toBeGreaterThan(0);
    expect(result.released).toBeGreaterThan(30);
    expect(result.extended).toBeGreaterThan(5);
    expect(result.repartitioned).toBeGreaterThan(5);
    expect(result.repartitionConflicts).toBeGreaterThan(5);
  }, 300_000);
});

/** The same database with search_path pinned to `schema` (then public, where btree_gist lives). */
function inSchema(connection: string, schema: string): string {
  const parsed = new URL(connection);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

// With BETTER_COMPUTE_POSTGRES_URL: the 8 placers and the chaos run truly concurrently. The shadow's
// sequence is write order, not commit order, so this checks a slightly weaker history there.
describe.skipIf(!url)('the capacity torture test on a MIG pool (PostgreSQL, concurrent)', () => {
  let admin: SqlExecutor;
  let db: SqlExecutor;
  let schema: string;
  beforeAll(async () => {
    admin = postgres({ url: url! });
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    schema = `bc_torture_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  it(`keeps every invariant over ${ops * 2} concurrent operations, without deadlocks`, async () => {
    const fleet = await seed(db, 16, 4);
    const result = await runTorture(db, fleet, { ops: ops * 2, seed: seedValue });
    expect(
      result.unexpected.map((error) => `${sqlState(error) ?? ''} ${String(error)}`),
      `seed ${seedValue}`,
    ).toEqual([]);
    await checkInvariants(db, fleet);
  }, 600_000);
});
