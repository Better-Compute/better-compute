# @better-compute/postgres

PostgreSQL storage for better-compute. It provides:

- the `SqlExecutor` implementations `postgres()` (node-postgres) and `pglite()` (`./pglite`);
- the base schema, applied through an append-only migration ledger;
- the `compute_now()` clock and its sim-clock helpers;
- a Kysely dialect;
- the store conformance suite (`./conformance`).

It needs Node.js 22.12 or later and PostgreSQL 16 or later (CI runs 17).

```ts
import { betterCompute } from 'better-compute';
import { postgres } from 'better-compute/postgres';

const database = postgres({ url: process.env.DATABASE_URL!, max: 20, statementTimeoutMs: 15_000 });
await database.migrate(); // compute.initialize() does this, adding module and plugin migrations
const compute = betterCompute({ database /* , iam, secret, baseURL, … */ });
```

## PostgreSQL

**Extensions and privileges.** The first migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist`. `EXCLUDE USING gist` needs btree_gist for text equality on `device_bookings`. btree_gist is a trusted extension, so a database owner with `CREATE` can install it. On managed services where that is not allowed, a superuser installs it once beforehand. `migrate()` refuses servers older than 16.

**PgBouncer.** `postgres()` is safe behind PgBouncer in transaction mode:

- It keeps no session state. The statement timeout is `SET LOCAL` inside each transaction, and no connection startup parameters are set.
- It never uses `LISTEN`/`NOTIFY`.
- It uses only unnamed prepared statements.
- It takes no session-level advisory locks. Concurrent migrators serialize on a transaction-level `pg_advisory_xact_lock(1650683248, 1)`, which is released at `COMMIT`.

Leases, the work queue and the outbox are tables (PLAN.md §8.4–8.5), so they work through the pooler.

**Options.**

- Pass exactly one of `url` or `pool`.
- `pool` is a `pg.Pool` you own (TLS, IAM auth, a pooler endpoint). `close()` leaves it open.
- `max` defaults to 10. A connection attempt gives up after 10 seconds.
- `statementTimeoutMs` is applied at the start of every transaction. Standalone statements then run in a short transaction of their own. Migrations run without it, because index builds can take minutes.

## Transactions

`transaction(fn, { isolation?, readOnly? })` runs `fn` on one connection between `BEGIN` and `COMMIT`, and rolls back when `fn` throws. The default isolation is `read committed`: guarded updates and row locks carry the invariants (P4).

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

The base schema is the frozen v0.1 schema of PLAN.md §8.3:

- the §8.3 tables as written;
- the indexes behind the access paths the plan spells out;
- `authz_changes`, the projection's change feed;
- the v0.1 tables from the plan's "also" list: `gateways`, `allocations`, `usage_windows`, `usage_dead_letters`, `node_certs`, `inventory_snapshots`, `audit_events` and `pool_capacity_rollup`.

`baseTables` lists every table. Later phases add their tables as new migrations. Released migrations never change.

## One clock

All SQL reads time through `compute_now()`, never `now()` (P9). `scripts/check-sql-now.mjs` enforces this. The only exception is `src/migrations/0001_clock.ts`, which defines the function. Column defaults use `compute_now()` too.

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

`storeConformanceCases()` from `./conformance` covers what the schema guarantees (PLAN.md §15):

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

In this repository, `tests/postgres-schema.test.ts` and `tests/pglite-*.test.ts` run on PGlite. `tests/postgres-conformance.test.ts` and `tests/postgres-executor.test.ts` run against real PostgreSQL, with a fresh schema per case, when `BETTER_COMPUTE_POSTGRES_URL` points at a database where they may create schemas: `pnpm test:postgres`.

License: Apache-2.0.
