import type { Migration, SqlExecutor, SqlTx } from '@better-compute/core';
import {
  check,
  checkEqual,
  checkRejects,
  type ConformanceCase,
} from '@better-compute/core/conformance';
import { computeNowMode, restoreSystemClock, setSimClock, useSimClock } from './clock.js';
import { sqlState } from './executor.js';
import { baseMigrations, baseSchemaVersion, baseTables } from './migrations/index.js';

/**
 * One store conformance case. `postgresOnly` cases need concurrent connections (row locks, SKIP
 * LOCKED, snapshots of open transactions): they run on real PostgreSQL, and PGlite runners, whose
 * one connection serializes transactions, skip them.
 */
export interface StoreConformanceCase extends ConformanceCase<SqlExecutor> {
  postgresOnly?: boolean;
}

// --- Fixtures ------------------------------------------------------------------------------------

/** A per-case id prefix, so cases also pass against a database that earlier cases used. */
const unique = () => `c${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const hour = 3_600_000;
/** Bookings live far in the future, clear of anything the system clock reaches. */
const base = Date.UTC(2030, 0, 1);
const past = new Date(Date.UTC(2000, 0, 1));
const farFuture = new Date(Date.UTC(2100, 0, 1));
/** The simulator's epoch in these cases: long before any real clock reading. */
const simStart = Date.UTC(2001, 0, 1);
const at = (ms: number) => new Date(ms);

interface Fleet {
  prefix: string;
  site: string;
  pool: string;
  nodes: string[];
  /** Device ids per node. */
  devices: string[][];
}

/** A site, a pool, and schedulable `host` nodes with healthy, bookable GPUs and a session row. */
async function seedFleet(sql: SqlTx, { nodes = 1, gpus = 2 } = {}): Promise<Fleet> {
  const prefix = unique();
  const fleet: Fleet = {
    prefix,
    site: `${prefix}-site`,
    pool: `${prefix}-pool`,
    nodes: [],
    devices: [],
  };
  await sql.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version)
     VALUES ($1, 'root', 'shared', 'eu-west-1', 1)`,
    [fleet.site],
  );
  await sql.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, 'root', $2, 'metal-host', 'H100', 'exclusive', 'bcd', $3, 1)`,
    [fleet.pool, fleet.site, '{}'],
  );
  for (let n = 0; n < nodes; n++) {
    const node = `${prefix}-node${n}`;
    await sql.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
         cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen,
         shard, version)
       VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1,
         0, 0, 1)`,
      [node, fleet.site, fleet.pool],
    );
    await sql.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [node]);
    const devices: string[] = [];
    for (let g = 0; g < gpus; g++) {
      const device = `${node}-gpu${g}`;
      await sql.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', true, true, $3)`,
        [device, node, JSON.stringify({ gpuProduct: 'H100-SXM5-80GB', gpuModel: 'H100' })],
      );
      devices.push(device);
    }
    fleet.nodes.push(node);
    fleet.devices.push(devices);
  }
  return fleet;
}

/**
 * Runs one statement under a savepoint, as the placer does (§10.3), and returns the SQLSTATE it
 * failed with, or undefined when it succeeded. The surrounding transaction stays usable.
 */
async function failureState(
  tx: SqlTx,
  text: string,
  params: readonly unknown[] = [],
): Promise<string | undefined> {
  await tx.query('SAVEPOINT conformance_probe');
  try {
    await tx.query(text, params);
    await tx.query('RELEASE SAVEPOINT conformance_probe');
    return undefined;
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT conformance_probe');
    await tx.query('RELEASE SAVEPOINT conformance_probe');
    return sqlState(error) ?? `no SQLSTATE: ${String(error)}`;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `promise` has settled yet; handles its rejection so a failing case never leaks one. */
function track(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

/** How long a statement that should block is watched before the case calls it blocked. */
const blockedMs = 300;
/** A blocked statement fails instead of hanging the suite when a lock is never released. */
const lockTimeout = "SET LOCAL lock_timeout = '10s'";

// --- The SQL whose semantics the schema guarantees (PLAN.md §8.4, §8.5, §10.3) --------------------

const bookAtoms = `INSERT INTO device_bookings (device_id, allocation_id, during)
  SELECT unnest($1::text[]), $2, tstzrange($3, $4) ON CONFLICT DO NOTHING RETURNING device_id`;

const eligibleNodes = `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id
  WHERE n.id = ANY($1::text[]) AND n.role = 'host' AND NOT n.maintenance AND NOT n.cordoned
    AND n.connectivity = 'connected' AND n.provision_state IN ('adopted', 'deployed')
    AND cardinality(n.no_schedule_reasons) = 0
    AND (n.trust = 'platform' OR (n.trust = 'tenant-owned' AND p.owner_tenant_id = n.owner_tenant_id))
  FOR SHARE OF n`;

const eligibleAtoms =
  'SELECT id FROM devices WHERE id = ANY($1::text[]) AND healthy AND bookable FOR SHARE';

const ensureLease = `INSERT INTO leases (name, owner, epoch, expires_at)
  VALUES ($1, NULL, 0, '-infinity') ON CONFLICT (name) DO NOTHING`;

const acquireLease = `UPDATE leases SET owner = $2,
    epoch = CASE WHEN owner = $2 THEN epoch ELSE epoch + 1 END,
    expires_at = compute_now() + make_interval(secs => $3)
  WHERE name = $1 AND (owner = $2 OR expires_at < compute_now()) RETURNING epoch`;

const fenceLease = `SELECT 1 AS held FROM leases
  WHERE name = $1 AND owner = $2 AND epoch = $3 AND expires_at > compute_now() FOR SHARE`;

const enqueueWork = `INSERT INTO work_queue (kind, key, shard, gen, not_before) VALUES ($1, $2, $3, 1, $4)
  ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1,
    not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)
  RETURNING gen, not_before`;

/** The claim of §8.4, narrowed to one kind so cases never take each other's keys. */
const claimWork = `WITH picked AS (
    SELECT kind, key FROM work_queue
    WHERE shard = ANY($1::smallint[]) AND kind = $2 AND not_before <= compute_now()
      AND (claimed_until IS NULL OR claimed_until < compute_now())
    ORDER BY not_before, key LIMIT $3
    FOR UPDATE SKIP LOCKED)
  UPDATE work_queue w SET claimed_until = compute_now() + make_interval(secs => $4)
  FROM picked WHERE w.kind = picked.kind AND w.key = picked.key
  RETURNING w.key, w.gen`;

const completeWork = 'DELETE FROM work_queue WHERE kind = $1 AND key = $2 AND gen = $3';

const insertOutbox = 'INSERT INTO outbox (topic, payload) VALUES ($1, $2)';

/**
 * The outbox reader of §8.4, narrowed to one topic. ORDER BY names the table's columns: a bare
 * `txid` would resolve to the text output alias and sort "1000" before "999".
 */
const readOutbox = `SELECT seq, txid::text AS txid, payload FROM outbox
  WHERE txid < pg_snapshot_xmin(pg_current_snapshot()) AND (txid, seq) > ($1::xid8, $2::bigint)
    AND topic = $3
  ORDER BY outbox.txid, outbox.seq`;

interface OutboxRow {
  seq: number;
  txid: string;
  payload: { n: number | string };
}

const dispatchCommands = `SELECT c.id, c.node_id, c.seq, s.session_epoch
  FROM commands c JOIN node_sessions s USING (node_id)
  WHERE s.gateway_id = $1 AND c.state = 'pending' AND c.not_before <= compute_now()
    AND c.not_after > compute_now()
  ORDER BY c.node_id, c.seq LIMIT $2
  FOR UPDATE OF c SKIP LOCKED FOR SHARE OF s`;

const insertCommand = `INSERT INTO commands (id, node_id, seq, kind, body, state, not_before, not_after,
    retry_safe, self_terminating, attested, idempotency_key)
  VALUES ($1, $2, $3, 'inventory.refresh', $4, 'pending', $5, $6, true, false, false, $7)`;

const sqlNow = async (sql: SqlTx) =>
  (await sql.query<{ now: Date }>('SELECT compute_now() AS now')).rows[0]!.now.getTime();

// --- Cases ---------------------------------------------------------------------------------------

const migrationCases: StoreConformanceCase[] = [
  {
    name: 'migrate: the base schema applies once and a second run is a no-op',
    async run(db) {
      const names = baseMigrations.map((migration) => migration.name);
      const first = await db.migrate();
      checkEqual(
        [...first.applied, ...first.skipped],
        names,
        'the first run accounts for every base migration, in order',
      );
      const second = await db.migrate();
      checkEqual(second.applied, [], 'a second run applies nothing');
      checkEqual(second.skipped, names, 'a second run skips every base migration');
      const ledger = await db.query<{ name: string }>(
        "SELECT name FROM compute_migrations WHERE name LIKE 'core/%' ORDER BY name",
      );
      checkEqual(
        ledger.rows.map((row) => row.name),
        names,
        'the ledger records each base migration once',
      );
      const version = await db.query<{ version: number }>(
        'SELECT version FROM compute_schema_version WHERE id = 1',
      );
      checkEqual(version.rows[0]?.version, baseSchemaVersion, 'compute_schema_version');
    },
  },
  {
    name: 'migrate: module migrations run in order, once each, one transaction per migration',
    async run(db) {
      await db.migrate();
      const probe: Migration[] = [
        {
          name: 'conformance/0001_probe',
          sql: 'CREATE TABLE IF NOT EXISTS plg_conformance_probe (id text PRIMARY KEY)',
        },
        {
          name: 'conformance/0002_probe_row',
          sql: async (tx) => {
            await tx.query(
              "INSERT INTO plg_conformance_probe (id) VALUES ('seeded') ON CONFLICT DO NOTHING",
            );
          },
        },
      ];
      await db.migrate(probe);
      const again = await db.migrate(probe);
      checkEqual(again.applied, [], 'a second run applies no module migration');
      check(
        probe.every((migration) => again.skipped.includes(migration.name)),
        'a second run reports the module migrations as skipped',
      );
      const rows = await db.query('SELECT id FROM plg_conformance_probe');
      checkEqual(rows.rows, [{ id: 'seeded' }], 'the function migration saw the table before it');

      const broken: Migration = {
        name: 'conformance/0003_broken',
        sql: 'CREATE TABLE plg_conformance_broken (id text); SELECT 1 / 0',
      };
      await checkRejects(
        () => db.migrate([...probe, broken]),
        'INTERNAL_ERROR',
        'a failing migration rejects',
      );
      const table = await db.query<{ name: string | null }>(
        "SELECT to_regclass('plg_conformance_broken')::text AS name",
      );
      checkEqual(table.rows[0]?.name, null, 'the failed migration rolled back its own statements');
      const recorded = await db.query('SELECT 1 FROM compute_migrations WHERE name = $1', [
        broken.name,
      ]);
      checkEqual(recorded.rowCount, 0, 'a failed migration is not recorded');
      await checkRejects(
        () => db.migrate([{ name: 'core/0099_module', sql: 'SELECT 1' }]),
        'INVALID_CONFIG',
        'the core owner is reserved for the base schema',
      );
    },
  },
  {
    name: 'migrate: refuses a database that a newer release migrated',
    async run(db) {
      await db.migrate();
      const record = 'INSERT INTO compute_migrations (name, applied_at) VALUES ($1, compute_now())';
      const erase = 'DELETE FROM compute_migrations WHERE name = $1';
      const future = 'core/9999_from_a_newer_release';
      await db.query(record, [future]);
      try {
        const error = await checkRejects(
          () => db.migrate(),
          'INVALID_CONFIG',
          'an unknown later core migration refuses the run',
        );
        check(error.message.includes(future), 'the refusal names the unknown migration');
      } finally {
        await db.query(erase, [future]);
      }

      const newerModule = 'conformance-refusal/0002_newer';
      await db.query(record, [newerModule]);
      try {
        await checkRejects(
          () => db.migrate([{ name: 'conformance-refusal/0001_first', sql: 'SELECT 1' }]),
          'INVALID_CONFIG',
          'a later migration of a configured module refuses the run',
        );
        await db.migrate();
      } finally {
        await db.query(erase, [newerModule]);
      }

      await db.query('UPDATE compute_schema_version SET version = version + 100 WHERE id = 1');
      try {
        await checkRejects(
          () => db.migrate(),
          'INVALID_CONFIG',
          'a newer base schema version refuses the run',
        );
      } finally {
        await db.query('UPDATE compute_schema_version SET version = version - 100 WHERE id = 1');
      }
    },
  },
  {
    name: 'schema: every v0.1 table exists',
    async run(db) {
      await db.migrate();
      const expected = [...baseTables, 'compute_migrations', 'compute_schema_version'];
      const { rows } = await db.query<{ name: string }>(
        `SELECT table_name::text AS name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        [expected],
      );
      const found = new Set(rows.map((row) => row.name));
      checkEqual(
        expected.filter((table) => !found.has(table)),
        [],
        'tables missing from the base schema',
      );
    },
  },
];

const clockCases: StoreConformanceCase[] = [
  {
    name: 'compute_now(): follows the sim clock, including column defaults, then the system clock again',
    async run(db) {
      await db.migrate();
      await useSimClock(db, simStart);
      try {
        checkEqual(await sqlNow(db), simStart, 'compute_now() reads the sim clock');
        checkEqual(await computeNowMode(db), 'sim', 'computeNowMode under the sim clock');
        await setSimClock(db, simStart + 90_000);
        checkEqual(await sqlNow(db), simStart + 90_000, 'setSimClock moves it forward');
        await checkRejects(
          () => setSimClock(db, simStart),
          'INVALID_INPUT',
          'the sim clock never moves backwards',
        );
        const fleet = await seedFleet(db, { gpus: 0 });
        const id = `${fleet.prefix}-cmd`;
        await db.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe,
             self_terminating, attested, idempotency_key)
           VALUES ($1, $2, 1, 'inventory.refresh', $3, 'pending', $4, true, false, false, $1)`,
          [id, fleet.nodes[0], new Uint8Array([1]), at(simStart + hour)],
        );
        const command = await db.query<{ not_before: Date }>(
          'SELECT not_before FROM commands WHERE id = $1',
          [id],
        );
        checkEqual(
          command.rows[0]?.not_before.getTime(),
          simStart + 90_000,
          'DEFAULT compute_now() takes the sim time',
        );
      } finally {
        await restoreSystemClock(db);
      }
      checkEqual(await computeNowMode(db), 'system', 'computeNowMode after restoreSystemClock');
      check(
        (await sqlNow(db)) > Date.UTC(2020, 0, 1),
        'restoreSystemClock returns compute_now() to the server clock',
      );
    },
  },
];

const invariantCases: StoreConformanceCase[] = [
  {
    name: 'device_bookings: EXCLUDE rejects overlaps; ON CONFLICT DO NOTHING returns fewer rows instead',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { gpus: 3 });
        const [a, b, c] = fleet.devices[0]!;
        const alloc = (n: number) => `${fleet.prefix}-alloc${n}`;
        const first = await tx.query(bookAtoms, [[a, b], alloc(1), at(base), at(base + hour)]);
        checkEqual(first.rowCount, 2, 'the first booking takes both atoms');
        const overlap = await tx.query<{ device_id: string }>(bookAtoms, [
          [b, c],
          alloc(2),
          at(base + hour / 2),
          at(base + 2 * hour),
        ]);
        checkEqual(
          overlap.rows.map((row) => row.device_id),
          [c],
          'only the free atom is booked: fewer rows than atoms signals the conflict',
        );
        const adjacent = await tx.query(bookAtoms, [
          [a],
          alloc(3),
          at(base + hour),
          at(base + 2 * hour),
        ]);
        checkEqual(
          adjacent.rowCount,
          1,
          'ranges are half-open: a booking may start where one ends',
        );
        const usable = await tx.query('SELECT 1 AS ok');
        checkEqual(usable.rows, [{ ok: 1 }], 'the transaction is still usable after the conflict');
        checkEqual(
          await failureState(
            tx,
            'INSERT INTO device_bookings (device_id, allocation_id, during) VALUES ($1, $2, tstzrange($3, $4))',
            [a, alloc(4), at(base + 10 * 60_000), at(base + 20 * 60_000)],
          ),
          '23P01',
          'a plain INSERT of an overlap raises exclusion_violation',
        );
        checkEqual(
          await failureState(tx, bookAtoms, [
            [c],
            alloc(5),
            at(base + 5 * hour),
            at(base + 5 * hour),
          ]),
          '23514',
          'an empty range violates the CHECK',
        );
        const booked = await tx.query(
          'SELECT device_id FROM device_bookings WHERE allocation_id LIKE $1',
          [`${fleet.prefix}-%`],
        );
        checkEqual(booked.rowCount, 4, 'exactly the non-conflicting bookings exist');
      });
    },
  },
  {
    name: 'device_bookings: extending into a later booking raises exclusion_violation inside a savepoint',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { gpus: 1 });
        const [atom] = fleet.devices[0]!;
        const early = `${fleet.prefix}-early`;
        await tx.query(bookAtoms, [[atom], early, at(base), at(base + hour)]);
        await tx.query(bookAtoms, [
          [atom],
          `${fleet.prefix}-late`,
          at(base + 2 * hour),
          at(base + 3 * hour),
        ]);
        const extend =
          'UPDATE device_bookings SET during = tstzrange(lower(during), $2) WHERE allocation_id = $1';
        checkEqual(
          await failureState(tx, extend, [early, at(base + 2 * hour + 1)]),
          '23P01',
          'an extension that overlaps the next booking is excluded',
        );
        checkEqual(
          await failureState(tx, extend, [early, at(base + 2 * hour)]),
          undefined,
          'an extension up to the next booking is allowed',
        );
        const { rows } = await tx.query<{ upper: Date }>(
          'SELECT upper(during) AS upper FROM device_bookings WHERE allocation_id = $1',
          [early],
        );
        checkEqual(rows[0]?.upper.getTime(), base + 2 * hour, 'the allowed extension took effect');
      });
    },
  },
  {
    name: 'node_resources: the guarded increment returns no row instead of raising; the CHECK backstops it',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { gpus: 0 });
        const node = fleet.nodes[0]!;
        await tx.query(
          `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated)
           VALUES ($1, 'vcpu', 10, 1.5, 0)`,
          [node],
        );
        const claim = `UPDATE node_resources SET allocated = allocated + $2
          WHERE node_id = $1 AND resource = 'vcpu' AND allocated + $2 <= floor(allocatable * ratio)
          RETURNING allocated`;
        checkEqual(
          (await tx.query(claim, [node, 10])).rows,
          [{ allocated: 10 }],
          'within the limit',
        );
        checkEqual((await tx.query(claim, [node, 10])).rowCount, 0, 'over floor(10 × 1.5): 0 rows');
        checkEqual((await tx.query(claim, [node, 5])).rows, [{ allocated: 15 }], 'up to the limit');
        const unguarded = `UPDATE node_resources SET allocated = allocated + $2
          WHERE node_id = $1 AND resource = 'vcpu'`;
        checkEqual(
          await failureState(tx, unguarded, [node, 1]),
          '23514',
          'an unguarded increment hits the CHECK',
        );
        checkEqual(
          await failureState(tx, unguarded, [node, -16]),
          '23514',
          'a counter never goes below zero',
        );
        const { rows } = await tx.query(
          "SELECT allocated FROM node_resources WHERE node_id = $1 AND resource = 'vcpu'",
          [node],
        );
        checkEqual(rows, [{ allocated: 15 }], 'the failed statements changed nothing');
      });
    },
  },
  {
    name: 'quota_usage: the guarded update enforces max, and a missing row grants nothing',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { gpus: 0 });
        const tenant = `${fleet.prefix}-org`;
        await tx.query(
          "INSERT INTO quota_usage (tenant_id, pool_id, resource, max, used) VALUES ($1, $2, 'gpu', 8, 0)",
          [tenant, fleet.pool],
        );
        const take = `UPDATE quota_usage SET used = used + $3
          WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu' AND used + $3 <= max
          RETURNING used`;
        checkEqual(
          (await tx.query(take, [tenant, fleet.pool, 4])).rows,
          [{ used: 4 }],
          'take 4 of 8',
        );
        checkEqual(
          (await tx.query(take, [tenant, fleet.pool, 5])).rowCount,
          0,
          '4 + 5 > 8: 0 rows',
        );
        checkEqual(
          (await tx.query(take, [tenant, fleet.pool, 4])).rows,
          [{ used: 8 }],
          'up to max',
        );
        checkEqual(
          (await tx.query(take, [tenant, `${fleet.prefix}-not-offered`, 1])).rowCount,
          0,
          'a pool without a quota row grants 0',
        );
        checkEqual(
          await failureState(
            tx,
            "UPDATE quota_usage SET used = used + 1 WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu'",
            [tenant, fleet.pool],
          ),
          '23514',
          'an unguarded update past max hits the CHECK',
        );
      });
    },
  },
  {
    name: 'reservations: idempotency keys are unique per (tenant, owner identity)',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const prefix = unique();
        const draft = `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash,
            owner_identity_id, idempotency_key, version)
          VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, 1)
          ON CONFLICT (tenant_id, owner_identity_id, idempotency_key) DO NOTHING RETURNING id`;
        const insert = (id: string, tenant: string, identity: string) =>
          tx.query(draft, [
            `${prefix}-${id}`,
            `${prefix}-${tenant}`,
            `${prefix}-pool`,
            JSON.stringify({ devices: [{ class: 'gpu', count: 4 }], duration: '8h' }),
            new Uint8Array(32),
            `${prefix}-${identity}`,
            'key-1',
          ]);
        checkEqual((await insert('r1', 'org', 'alice')).rowCount, 1, 'the first draft is created');
        checkEqual((await insert('r2', 'org', 'alice')).rowCount, 0, 'the same key again: no row');
        checkEqual(
          await failureState(
            tx,
            `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash,
               owner_identity_id, idempotency_key, version)
             VALUES ($1, $2, $3, 'draft', '{}', '\\x00', $4, 'key-1', 1)`,
            [`${prefix}-r3`, `${prefix}-org`, `${prefix}-pool`, `${prefix}-alice`],
          ),
          '23505',
          'a plain INSERT of the same key raises unique_violation',
        );
        checkEqual(
          (await insert('r4', 'org', 'bob')).rowCount,
          1,
          'another identity has its own key',
        );
        checkEqual((await insert('r5', 'other', 'alice')).rowCount, 1, 'another tenant too');
      });
    },
  },
  {
    name: 'nodes: trusted hardware keys are unique, and a site agent belongs to no pool',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { nodes: 3, gpus: 0 });
        const [first, second, third] = fleet.nodes;
        const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const setKey =
          'UPDATE nodes SET hardware_key = $2, hardware_key_trusted = $3 WHERE id = $1';
        checkEqual(await failureState(tx, setKey, [first, key, true]), undefined, 'a trusted key');
        checkEqual(
          await failureState(tx, setKey, [second, key, false]),
          undefined,
          'an untrusted duplicate is allowed',
        );
        checkEqual(
          await failureState(tx, setKey, [third, key, true]),
          '23505',
          'a second trusted node with the same key is rejected',
        );
        checkEqual(
          await failureState(tx, "UPDATE nodes SET role = 'site' WHERE id = $1", [first]),
          '23514',
          'a site agent in a pool violates the CHECK',
        );
        checkEqual(
          await failureState(tx, "UPDATE nodes SET role = 'site', pool_id = NULL WHERE id = $1", [
            first,
          ]),
          undefined,
          'a site agent without a pool is allowed',
        );
      });
    },
  },
  {
    name: 'commands and iam_inbox: per-node seq and idempotency keys are unique; inbox events dedupe',
    async run(db) {
      await db.migrate();
      await db.transaction(async (tx) => {
        const fleet = await seedFleet(tx, { nodes: 2, gpus: 0 });
        const [node, other] = fleet.nodes;
        const command = (id: string, onNode: string | undefined, seq: number, key: string) => [
          `${fleet.prefix}-${id}`,
          onNode,
          seq,
          new Uint8Array([1]),
          past,
          farFuture,
          key,
        ];
        checkEqual(
          await failureState(tx, insertCommand, command('c1', node, 1, 'k1')),
          undefined,
          'first',
        );
        checkEqual(
          await failureState(tx, insertCommand, command('c2', node, 1, 'k2')),
          '23505',
          'seq is unique per node',
        );
        checkEqual(
          await failureState(tx, insertCommand, command('c3', node, 2, 'k1')),
          '23505',
          'the idempotency key is unique per node',
        );
        checkEqual(
          await failureState(tx, insertCommand, command('c4', other, 1, 'k1')),
          undefined,
          'another node has its own sequence and keys',
        );
        const deliver = `INSERT INTO iam_inbox (event_id, tenant_id, sequence, occurred_at, action, body, received_at)
          VALUES ($1, $2, 7, $3, 'identity:offboard', $4, compute_now()) ON CONFLICT (event_id) DO NOTHING`;
        const event = [`${fleet.prefix}-evt`, `${fleet.prefix}-org`, past, '{"identityId":"x"}'];
        checkEqual((await tx.query(deliver, event)).rowCount, 1, 'the first delivery is stored');
        checkEqual((await tx.query(deliver, event)).rowCount, 0, 'a redelivery is dropped');
      });
    },
  },
];

const queueCases: StoreConformanceCase[] = [
  {
    name: 'leases: acquire, renew and takeover follow the §8.5 epoch fencing',
    async run(db) {
      await db.migrate();
      const name = `shard:${unique()}`;
      const acquire = async (owner: string) =>
        (await db.query<{ epoch: number }>(acquireLease, [name, owner, 15])).rows[0]?.epoch;
      const fenced = (owner: string, epoch: number) =>
        db.transaction(
          async (tx) => (await tx.query(fenceLease, [name, owner, epoch])).rowCount === 1,
        );
      await useSimClock(db, simStart);
      try {
        await db.query(ensureLease, [name]);
        checkEqual(await acquire('worker-a'), 1, 'the first owner takes epoch 1');
        checkEqual(await acquire('worker-a'), 1, 'renewal keeps the epoch');
        checkEqual(await acquire('worker-b'), undefined, 'nobody takes an unexpired lease');
        check(await fenced('worker-a', 1), 'the holder passes its fence');
        const { rows } = await db.query<{ expires_at: Date }>(
          'SELECT expires_at FROM leases WHERE name = $1',
          [name],
        );
        checkEqual(
          rows[0]?.expires_at.getTime(),
          simStart + 15_000,
          'the TTL runs on compute_now()',
        );
        await setSimClock(db, simStart + 16_000);
        check(!(await fenced('worker-a', 1)), 'an expired lease fails its fence');
        checkEqual(await acquire('worker-b'), 2, 'a takeover after expiry bumps the epoch');
        check(!(await fenced('worker-a', 1)), 'the old epoch is fenced out');
        check(await fenced('worker-b', 2), 'the new holder passes its fence');
        checkEqual(await acquire('worker-a'), undefined, 'the previous owner cannot renew');
        await db.query(
          "UPDATE leases SET expires_at = '-infinity' WHERE name = $1 AND owner = $2",
          [name, 'worker-b'],
        );
        checkEqual(await acquire('worker-a'), 3, 'a released lease is taken at once, epoch + 1');
      } finally {
        await restoreSystemClock(db);
      }
    },
  },
  {
    name: 'work_queue: enqueue coalesces into gen + 1, and a key re-dirtied mid-processing survives',
    async run(db) {
      await db.migrate();
      const kind = `conformance.${unique()}`;
      const enqueue = async (key: string, notBefore: Date) =>
        (await db.query<{ gen: number; not_before: Date }>(enqueueWork, [kind, key, 3, notBefore]))
          .rows[0]!;
      const claim = async (shards: number[]) =>
        (await db.query<{ key: string; gen: number }>(claimWork, [shards, kind, 10, 30])).rows
          .map((row) => `${row.key}@${row.gen}`)
          .sort();
      checkEqual((await enqueue('n1', past)).gen, 1, 'a new key starts at gen 1');
      checkEqual((await enqueue('n1', past)).gen, 2, 'enqueueing again coalesces into gen + 1');
      await enqueue('n2', farFuture);
      await enqueue('n2', past);
      const kept = await enqueue('n2', farFuture);
      checkEqual(
        kept.not_before.getTime(),
        past.getTime(),
        'not_before keeps the earliest wake-up',
      );
      checkEqual(await claim([4]), [], 'other shards claim nothing');
      checkEqual(await claim([3]), ['n1@2', 'n2@3'], 'the claim returns each key with its gen');
      checkEqual(await claim([3]), [], 'claimed keys are not claimed again');
      checkEqual((await enqueue('n1', past)).gen, 3, 're-dirtied while claimed');
      const stale = await db.query(completeWork, [kind, 'n1', 2]);
      checkEqual(stale.rowCount, 0, 'completing the claimed gen keeps a re-dirtied key');
      await db.query('UPDATE work_queue SET claimed_until = NULL WHERE kind = $1 AND key = $2', [
        kind,
        'n1',
      ]);
      checkEqual(await claim([3]), ['n1@3'], 'the surviving key is claimed again at its new gen');
      checkEqual((await db.query(completeWork, [kind, 'n1', 3])).rowCount, 1, 'completion deletes');
      checkEqual((await db.query(completeWork, [kind, 'n2', 3])).rowCount, 1, 'completion deletes');
    },
  },
  {
    name: 'outbox: readers see committed transactions in (txid, seq) order, never one in progress',
    async run(db) {
      await db.migrate();
      const topic = `conformance.${unique()}`;
      const payloads = (rows: OutboxRow[]) => rows.map((row) => row.payload.n);
      await db.transaction(async (tx) => {
        await tx.query(insertOutbox, [topic, '{"n":1}']);
        await tx.query(insertOutbox, [topic, '{"n":2}']);
      });
      await db.transaction((tx) => tx.query(insertOutbox, [topic, '{"n":3}']));
      const all = (await db.query<OutboxRow>(readOutbox, ['0', 0, topic])).rows;
      checkEqual(payloads(all), [1, 2, 3], 'every committed row, in order');
      check(all[0]!.txid === all[1]!.txid, "one transaction's rows share its txid");
      check(BigInt(all[2]!.txid) > BigInt(all[1]!.txid), 'a later transaction has a later txid');
      const resumed = await db.query<OutboxRow>(readOutbox, [all[1]!.txid, all[1]!.seq, topic]);
      checkEqual(payloads(resumed.rows), [3], 'the cursor resumes after the last row it read');
      const last = all[2]!;
      await db.transaction(async (tx) => {
        await tx.query(insertOutbox, [topic, '{"n":4}']);
        const inside = await tx.query(readOutbox, [last.txid, last.seq, topic]);
        checkEqual(
          inside.rowCount,
          0,
          "a reader never sees an open transaction's rows, even its own",
        );
      });
      const later = await db.query<OutboxRow>(readOutbox, [last.txid, last.seq, topic]);
      checkEqual(payloads(later.rows), [4], 'the row appears once its transaction commits');
    },
  },
  {
    name: 'outbox: the cursor orders txids numerically across a change in digit count',
    async run(db) {
      await db.migrate();
      const topic = `conformance.${unique()}`;
      const current = async () =>
        BigInt((await db.query<{ x: string }>('SELECT pg_current_xact_id()::text AS x')).rows[0]!.x);
      // One row just below a power of ten, then burn xids so the next row's txid has one more digit.
      let xid = await current();
      const boundary = 10n ** BigInt(xid.toString().length);
      // A long-lived server may be far from the next power of ten; burning that many xids is not
      // worth it there. Fresh databases (every PGlite run, CI's Postgres) are always close.
      if (boundary - xid > 20_000n) return;
      while (xid < boundary - 3n) xid = await current();
      await db.transaction((tx) => tx.query(insertOutbox, [topic, '{"n":1}']));
      while (xid < boundary) xid = await current();
      await db.transaction((tx) => tx.query(insertOutbox, [topic, '{"n":2}']));
      const rows = (await db.query<OutboxRow>(readOutbox, ['0', 0, topic])).rows;
      checkEqual(
        rows.map((row) => row.payload.n),
        [1, 2],
        'the shorter txid sorts first',
      );
      check(rows[1]!.txid.length > rows[0]!.txid.length, 'the two txids differ in digit count');
      const resumed = await db.query<OutboxRow>(readOutbox, [rows[0]!.txid, rows[0]!.seq, topic]);
      checkEqual(resumed.rows.map((row) => row.payload.n), [2], 'the cursor resumes across the boundary');
    },
  },
];

const concurrencyCases: StoreConformanceCase[] = [
  {
    name: 'concurrency: FOR SHARE on node and atom rows linearizes placement with cordons and quarantines',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const fleet = await db.transaction((tx) => seedFleet(tx, { nodes: 2, gpus: 1 }));
      const [first, second] = fleet.nodes as [string, string];
      const [firstAtoms, secondAtoms] = fleet.devices as [string[], string[]];

      // The placer locks first: the cordon and the quarantine wait for it to commit.
      const locked = deferred();
      const place = deferred();
      const placer = db.transaction(async (tx) => {
        const nodes = await tx.query(eligibleNodes, [[first]]);
        const atoms = await tx.query(eligibleAtoms, [firstAtoms]);
        locked.resolve();
        await place.promise;
        return [nodes.rowCount, atoms.rowCount];
      });
      try {
        await locked.promise;
        const cordon = db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          await tx.query('UPDATE nodes SET cordoned = true, version = version + 1 WHERE id = $1', [
            first,
          ]);
        });
        const quarantine = db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          await tx.query('UPDATE devices SET healthy = false WHERE id = ANY($1::text[])', [
            firstAtoms,
          ]);
        });
        const cordoned = track(cordon);
        const quarantined = track(quarantine);
        await pause(blockedMs);
        check(!cordoned(), "a cordon waits for the placer's FOR SHARE lock on the node");
        check(!quarantined(), "a quarantine waits for the placer's FOR SHARE lock on the atom");
        place.resolve();
        checkEqual(await placer, [1, 1], 'the placer saw the node and the atom as eligible');
        await Promise.all([cordon, quarantine]);
      } finally {
        place.resolve();
      }

      // The cordon writes first: the placer waits, then sees it.
      const written = deferred();
      const commit = deferred();
      const writer = db.transaction(async (tx) => {
        await tx.query('UPDATE nodes SET cordoned = true, version = version + 1 WHERE id = $1', [
          second,
        ]);
        await tx.query('UPDATE devices SET healthy = false WHERE id = ANY($1::text[])', [
          secondAtoms,
        ]);
        written.resolve();
        await commit.promise;
      });
      try {
        await written.promise;
        const late = db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          const nodes = await tx.query(eligibleNodes, [[second]]);
          const atoms = await tx.query(eligibleAtoms, [secondAtoms]);
          return [nodes.rowCount, atoms.rowCount];
        });
        const settled = track(late);
        await pause(blockedMs);
        check(!settled(), 'the placer waits for the uncommitted cordon');
        commit.resolve();
        await writer;
        checkEqual(await late, [0, 0], 'whichever commits second sees the first');
      } finally {
        commit.resolve();
      }
    },
  },
  {
    name: "concurrency: a lease takeover waits until the zombie's fenced transaction ends",
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const name = `pool:${unique()}`;
      await useSimClock(db, simStart);
      try {
        await db.query(ensureLease, [name]);
        const [held] = (await db.query<{ epoch: number }>(acquireLease, [name, 'zombie', 15])).rows;
        checkEqual(held?.epoch, 1, 'the zombie holds epoch 1');
        const fenced = deferred();
        const finish = deferred();
        const zombie = db.transaction(async (tx) => {
          const fence = await tx.query(fenceLease, [name, 'zombie', 1]);
          fenced.resolve();
          await finish.promise;
          return fence.rowCount;
        });
        try {
          await fenced.promise;
          await setSimClock(db, simStart + 16_000);
          const takeover = db.transaction(async (tx) => {
            await tx.query(lockTimeout);
            return (await tx.query<{ epoch: number }>(acquireLease, [name, 'successor', 15]))
              .rows[0]?.epoch;
          });
          const settled = track(takeover);
          await pause(blockedMs);
          check(!settled(), "the takeover blocks behind the zombie's FOR SHARE fence");
          finish.resolve();
          checkEqual(await zombie, 1, 'the zombie saw its lease as valid when it fenced');
          checkEqual(await takeover, 2, 'the takeover then succeeds with epoch + 1');
          const late = await db.transaction((tx) => tx.query(fenceLease, [name, 'zombie', 1]));
          checkEqual(late.rowCount, 0, 'the zombie fails its next fence');
        } finally {
          finish.resolve();
        }
      } finally {
        await restoreSystemClock(db);
      }
    },
  },
  {
    name: 'concurrency: SKIP LOCKED gives concurrent claimers disjoint work_queue keys',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const kind = `conformance.${unique()}`;
      await db.transaction(async (tx) => {
        for (let i = 0; i < 30; i++) await tx.query(enqueueWork, [kind, `k${i}`, 5, past]);
      });
      const claimed = [deferred(), deferred(), deferred()];
      const finish = deferred();
      const workers = claimed.map((signal) =>
        db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          const { rows } = await tx.query<{ key: string }>(claimWork, [[5], kind, 10, 30]);
          signal.resolve();
          await finish.promise;
          return rows.map((row) => row.key);
        }),
      );
      try {
        await Promise.all(claimed.map((signal) => signal.promise));
        finish.resolve();
        const keys = (await Promise.all(workers)).flat();
        checkEqual(keys.length, 30, 'three claimers of ten take all thirty keys');
        checkEqual(new Set(keys).size, 30, 'no key is claimed twice');
      } finally {
        finish.resolve();
      }
    },
  },
  {
    name: 'concurrency: dispatch skips locked commands and serializes with the Hello epoch bump',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const fleet = await db.transaction(async (tx) => {
        const seeded = await seedFleet(tx, { nodes: 2, gpus: 0 });
        await tx.query(
          'UPDATE node_sessions SET gateway_id = $1, session_epoch = 1 WHERE node_id = ANY($2::text[])',
          [`${seeded.prefix}-gw`, seeded.nodes],
        );
        for (const node of seeded.nodes)
          for (const seq of [1, 2])
            await tx.query(insertCommand, [
              `${node}-cmd${seq}`,
              node,
              seq,
              new Uint8Array([seq]),
              past,
              farFuture,
              `${node}-key${seq}`,
            ]);
        return seeded;
      });
      const gateway = `${fleet.prefix}-gw`;
      const [first] = fleet.nodes as [string, string];
      const locked = deferred();
      const finish = deferred();
      const dispatcher = db.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; session_epoch: number }>(dispatchCommands, [
          gateway,
          2,
        ]);
        locked.resolve();
        await finish.promise;
        await tx.query(
          "UPDATE commands SET state = 'dispatched', session_epoch = $2 WHERE id = ANY($1::text[]) AND state = 'pending'",
          [rows.map((row) => row.id), rows[0]?.session_epoch],
        );
        return rows.map((row) => row.id);
      });
      try {
        await locked.promise;
        const second = await db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          const { rows } = await tx.query<{ id: string }>(dispatchCommands, [gateway, 10]);
          return rows.map((row) => row.id);
        });
        checkEqual(
          second.sort(),
          fleet.nodes.slice(1).flatMap((node) => [`${node}-cmd1`, `${node}-cmd2`]),
          'a concurrent dispatcher skips the locked commands and takes the rest',
        );
        const hello = db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          const { rows } = await tx.query<{ session_epoch: number }>(
            `UPDATE node_sessions SET session_epoch = session_epoch + 1, gateway_id = $2
             WHERE node_id = $1 RETURNING session_epoch`,
            [first, `${fleet.prefix}-gw2`],
          );
          return rows[0]?.session_epoch;
        });
        const settled = track(hello);
        await pause(blockedMs);
        check(
          !settled(),
          "Hello's epoch bump waits for the dispatch's FOR SHARE on the session row",
        );
        finish.resolve();
        checkEqual(
          (await dispatcher).sort(),
          [`${first}-cmd1`, `${first}-cmd2`],
          "the first dispatcher took the first node's commands in seq order",
        );
        checkEqual(await hello, 2, 'the epoch bump lands after the dispatch commits');
      } finally {
        finish.resolve();
      }
    },
  },
  {
    name: 'concurrency: the outbox cursor never passes a transaction that is still open',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const topic = `conformance.${unique()}`;
      const inserted = deferred();
      const finish = deferred();
      const long = db.transaction(async (tx) => {
        await tx.query(insertOutbox, [topic, '{"n":"long"}']);
        inserted.resolve();
        await finish.promise;
      });
      try {
        await inserted.promise;
        await db.transaction((tx) => tx.query(insertOutbox, [topic, '{"n":"short"}']));
        const early = await db.query(readOutbox, ['0', 0, topic]);
        checkEqual(early.rowCount, 0, 'a later commit stays hidden behind the open earlier txid');
        finish.resolve();
        await long;
        const all = await db.query<OutboxRow>(readOutbox, ['0', 0, topic]);
        checkEqual(
          all.rows.map((row) => row.payload.n),
          ['long', 'short'],
          'once the long transaction commits, both appear in txid order',
        );
      } finally {
        finish.resolve();
      }
    },
  },
  {
    name: 'concurrency: concurrent guarded quota updates never exceed max',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const fleet = await db.transaction((tx) => seedFleet(tx, { gpus: 0 }));
      const tenant = `${fleet.prefix}-org`;
      await db.query(
        "INSERT INTO quota_usage (tenant_id, pool_id, resource, max, used) VALUES ($1, $2, 'gpu', 5, 0)",
        [tenant, fleet.pool],
      );
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          db.transaction(async (tx) => {
            await tx.query(lockTimeout);
            const taken = await tx.query(
              `UPDATE quota_usage SET used = used + 1
               WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu' AND used + 1 <= max
               RETURNING used`,
              [tenant, fleet.pool],
            );
            await pause(20);
            return taken.rowCount;
          }),
        ),
      );
      checkEqual(outcomes.filter((count) => count === 1).length, 5, 'exactly max updates succeed');
      const { rows } = await db.query(
        "SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'gpu'",
        [tenant, fleet.pool],
      );
      checkEqual(rows, [{ used: 5 }], 'used never passes max');
    },
  },
  {
    name: 'concurrency: of two concurrent overlapping bookings exactly one commits',
    postgresOnly: true,
    async run(db) {
      await db.migrate();
      const fleet = await db.transaction((tx) => seedFleet(tx, { gpus: 1 }));
      const [atom] = fleet.devices[0]!;
      const booked = deferred();
      const finish = deferred();
      const winner = db.transaction(async (tx) => {
        const { rowCount } = await tx.query(bookAtoms, [
          [atom],
          `${fleet.prefix}-a`,
          at(base),
          at(base + hour),
        ]);
        booked.resolve();
        await finish.promise;
        return rowCount;
      });
      try {
        await booked.promise;
        const loser = db.transaction(async (tx) => {
          await tx.query(lockTimeout);
          return (
            await tx.query(bookAtoms, [
              [atom],
              `${fleet.prefix}-b`,
              at(base + hour / 2),
              at(base + 2 * hour),
            ])
          ).rowCount;
        });
        const settled = track(loser);
        await pause(blockedMs);
        check(!settled(), 'the second booking waits for the first transaction to decide');
        finish.resolve();
        checkEqual(await winner, 1, 'the first booking is inserted');
        checkEqual(await loser, 0, 'the second finds the committed conflict and inserts nothing');
      } finally {
        finish.resolve();
      }
      const { rowCount } = await db.query('SELECT 1 FROM device_bookings WHERE device_id = $1', [
        atom,
      ]);
      checkEqual(rowCount, 1, 'one booking exists');
    },
  },
];

/**
 * What the base schema guarantees, as store conformance cases (PLAN.md §15): exclusion and
 * extension conflicts, guarded counters and quota, idempotency keys, lease fencing, work-queue
 * coalescing, outbox ordering, the sim clock and migrations. Give each case a fresh executor (a
 * fresh schema on PostgreSQL); the cases also tolerate a database earlier cases used, and each one
 * migrates first. PGlite runners skip `postgresOnly` cases.
 */
export function storeConformanceCases(): StoreConformanceCase[] {
  return [
    ...migrationCases,
    ...clockCases,
    ...invariantCases,
    ...queueCases,
    ...concurrencyCases,
  ].map((test) => ({ ...test }));
}
