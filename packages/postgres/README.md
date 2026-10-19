# @better-compute/postgres

PostgreSQL and PGlite storage for better-compute: the `SqlExecutor` implementations, the base schema and its migration ledger, the `compute_now()` clock, a Kysely dialect and the store conformance suite.

## Install

```sh
npm install @better-compute/postgres
```

It is also included in the umbrella package as `better-compute/postgres`, with the PGlite entry at `better-compute/pglite`:

```sh
npm install better-compute
```

`@electric-sql/pglite` is an optional peer dependency, needed only for the `./pglite` entry (and the conformance suite run on PGlite): `npm install @electric-sql/pglite`.

It needs Node.js 22.12 or later and PostgreSQL 16 or later (CI runs 17).

## Usage

```ts
import { betterCompute } from 'better-compute';
import { postgres } from '@better-compute/postgres';

const database = postgres({ url: process.env.DATABASE_URL!, max: 20, statementTimeoutMs: 15_000 });
await database.migrate(); // compute.initialize() does this, adding module and plugin migrations
const compute = betterCompute({ database /* , iam, secret, baseURL, … */ });
```

The package provides:

- the `SqlExecutor` implementations `postgres()` (node-postgres) and `pglite()` (`./pglite`);
- the base schema, applied through an append-only migration ledger;
- the `compute_now()` clock and its sim-clock helpers;
- a Kysely dialect;
- the store conformance suite (`./conformance`).

## PostgreSQL

**Extensions and privileges.** The first migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist`. `EXCLUDE USING gist` needs btree_gist for text equality on `device_bookings`. btree_gist is a trusted extension, so a database owner with `CREATE` can install it. On managed services where that is not allowed, a superuser installs it once beforehand. `migrate()` refuses servers older than 16.

**PgBouncer.** `postgres()` is safe behind PgBouncer in transaction mode:

- It keeps no session state. The statement timeout is `SET LOCAL` inside each transaction, and no connection startup parameters are set.
- It never uses `LISTEN`/`NOTIFY`.
- It uses only unnamed prepared statements.
- It takes no session-level advisory locks. Concurrent migrators serialize on a transaction-level `pg_advisory_xact_lock(1650683248, 1)`, which is released at `COMMIT`.

Leases, the work queue and the outbox are tables, so they work through the pooler.

**Options.**

- Pass exactly one of `url` or `pool`.
- `pool` is a `pg.Pool` you own (TLS, IAM auth, a pooler endpoint). `close()` leaves it open.
- `max` defaults to 10. A connection attempt gives up after 10 seconds.
- `statementTimeoutMs` is applied at the start of every transaction. Standalone statements then run in a short transaction of their own. Migrations run without it, because index builds can take minutes.

## Transactions

`transaction(fn, { isolation?, readOnly? })` runs `fn` on one connection between `BEGIN` and `COMMIT`, and rolls back when `fn` throws. The default isolation is `read committed`: guarded updates and row locks carry the invariants.

- **A caught statement error still aborts.** If a statement fails and `fn` catches the error, PostgreSQL has already aborted the transaction. The executor detects the `COMMIT` that PostgreSQL turned into a `ROLLBACK` and rejects with `INTERNAL_ERROR`. To try a statement that may fail, give it a savepoint of its own.
- **The executor joins the caller's transaction.** Inside `fn`'s async call chain, the executor's own `query()` runs in that transaction, and `transaction()` opens a savepoint. The savepoint is released on success. When the nested `fn` throws, it is rolled back to, and the outer transaction carries on.
  - Code that received the executor and code that received `tx` therefore behave the same.
  - A nested transaction cannot change the isolation level or read-only mode.
  - Nested transactions opened side by side in one scope run one after another.
- **Handles expire.** A `tx` handle rejects every use once its transaction or savepoint has ended.

`query()` runs exactly one statement over the extended protocol on both executors. `sqlState(error)` reads the SQLSTATE, such as `23P01` (exclusion violation) or `40001` (serialization failure), from errors of either driver.

**Values** read the same from both executors:

| PostgreSQL                                 | JavaScript                                   |
| ------------------------------------------ | -------------------------------------------- |
| `int2`, `int4`, `float8`                   | number                                       |
| `int8` (and `int8[]`)                      | number, or a `bigint` beyond 2^53            |
| `numeric`, `xid8`, `tstzrange`, `interval` | string                                       |
| `timestamptz`                              | `Date`                                       |
| `jsonb`                                    | parsed value                                 |
| `bytea`                                    | `Uint8Array` (a `Buffer` from node-postgres) |
| arrays                                     | arrays                                       |

Pass parameters in these forms:

- `jsonb` as JSON text (`JSON.stringify(value)`). node-postgres would encode a JS array as a PostgreSQL array literal.
- Timestamps as `Date`. node-postgres cannot pass an epoch number to a `timestamptz`, so convert in SQL with `to_timestamp($1 / 1000.0)` if you must pass one.
- `bytea` as `Uint8Array`.

## Schema and migrations

`migrate(extra?)` bootstraps the ledger tables `compute_migrations(name, applied_at)` and `compute_schema_version`. It then applies the base schema (owner `core`, see `baseMigrations`), and after it `extra` in order.

- Each migration runs in its own transaction and is recorded in the ledger in that same transaction. A failed migration leaves nothing behind.
- Re-running is a no-op.
- Names follow `<owner>/<nnnn>_<slug>`, with numbers only growing within an owner. The `core` owner is reserved for the base schema.
- `migrate()` refuses to run, with `INVALID_CONFIG` naming the entries, when the ledger holds a migration this build cannot account for:
  - a later number from an owner it knows, meaning a newer release migrated the database;
  - an unknown name at or below its last number, meaning a migration was renamed or removed;
  - or a newer base schema version.

  Migrations of modules that are not configured are ignored.

The base schema holds the control plane's core tables and the indexes behind their access paths, `authz_changes` (the projection's change feed), and tables such as `gateways`, `allocations`, `usage_windows`, `usage_dead_letters`, `node_certs`, `inventory_snapshots`, `audit_events` and `pool_capacity_rollup`. `baseTables` lists every table. New tables arrive as new migrations; released migrations never change.

## Partitioned history and retention

`core/0018_partitioned_history` range-partitions the history tables by UTC month: `audit_events` on `occurred_at`, `inventory_snapshots` on `collected_at` and `usage_windows` on `window_start`. Their primary keys include that column. Each table also has a `<table>_default` partition, so an insert never fails for want of a month (sim clocks, skewed rows). `compute_history_partition(parent, at)` creates the month holding `at`, first moving that month's rows out of the default partition.

`retentionModule()` runs one singleton pass every 5 minutes. Hosts register it next to their modules:

- it keeps the next 2 months' partitions created ahead (`history.monthsAhead`);
- it prunes `outbox` and `authz_changes` behind every durable cursor (`saveCursor`/`loadCursor`), and `authz_changes` older than a day while no reader keeps a cursor;
- it prunes settled commands older than 30 days, expired attestation uses, and superseded inventory snapshots older than 180 days. A node's newest snapshot and the one it is applied from always stay;
- it prunes recorded usage windows only when `history.usageOlderThanDays` is set, and only for allocations that ended that long ago, never one with an open dead letter;
- it drops emptied past months.

Audit rows are never pruned by a timer. `detachHistoryPartition(tx, 'audit_events', 'audit_events_pYYYYMM')` archives a month; run `markAuditArchived` from `@better-compute/audit` first. `retentionModule().selfCheck` (doctor) reports missing month partitions, recent rows stranded in a default partition, and cursors that stopped moving.

## One clock

All SQL reads time through `compute_now()`, never `now()`, and column defaults use `compute_now()` too. A repository check enforces this; the only exception is the migration that defines the function.

For tests and the simulator:

- `useSimClock(sql, startMs)` points `compute_now()` at `compute_sim_clock`.
- `setSimClock(sql, ms)` moves it forward. It never moves backwards.
- `restoreSystemClock(sql)` points it back at the server's clock.

These settings are database-wide. `computeNowMode(sql)` reports `system`, `sim`, `custom` or `missing`, and `doctor` flags anything but `system` in production.

## PGlite

`pglite({ dataDir?, extensions? })` from `@better-compute/postgres/pglite` runs PostgreSQL in WebAssembly. `better-compute dev` and the test suites use it.

- `@electric-sql/pglite` is an optional peer dependency. It loads on the first statement, and `btree_gist` is always included.
- The executor has one connection. Transactions and standalone statements run one at a time behind an async mutex. Code inside a transaction that waits for another top-level transaction deadlocks, so concurrency tests belong on real PostgreSQL.
- Without `dataDir`, the database lives in memory.
- The session time zone is UTC.

## Kysely

`new Kysely<Tables>({ dialect: kyselyDialect(database) })` compiles typed queries and runs them through a `SqlExecutor` or one of its transactions. Queries made through an executor join the caller's transaction, like `query()`. Kysely's own `transaction()` is refused; use the executor's.

## Store conformance

`storeConformanceCases()` from `@better-compute/postgres/conformance` covers what the schema guarantees:

- `EXCLUDE` bookings, where overlaps come back as fewer rows from `ON CONFLICT DO NOTHING`;
- extension conflicts inside savepoints;
- guarded counters and quota;
- reservation idempotency keys;
- lease acquire, renew and takeover with epoch fencing;
- work-queue `gen` coalescing;
- outbox `(txid, seq)` cursor ordering;
- the sim clock;
- migrations.

Cases marked `postgresOnly` need concurrent connections: `FOR SHARE` against cordons and quarantines, lease takeover against a zombie's fence, `SKIP LOCKED` claims and dispatch, the outbox behind a long transaction, concurrent quota and bookings. PGlite runners skip them.

```ts
import { storeConformanceCases } from '@better-compute/postgres/conformance';
import { pglite } from '@better-compute/postgres/pglite';

for (const test of storeConformanceCases().filter((c) => !c.postgresOnly))
  it(test.name, async () => {
    const db = pglite();
    try {
      await test.run(db);
    } finally {
      await db.close();
    }
  });
```

In the better-compute repository, the schema and PGlite tests run on PGlite, and the conformance and executor tests run against real PostgreSQL, with a fresh schema per case, when `BETTER_COMPUTE_POSTGRES_URL` points at a database where they may create schemas: `pnpm test:postgres`.

## Documentation

- [Database](https://better-compute.com/docs/operations/database)
- [Retention](https://better-compute.com/docs/operations/retention)
- [Consistency](https://better-compute.com/docs/guides/concepts/consistency)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
