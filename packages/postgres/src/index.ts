/**
 * PostgreSQL storage for better-compute: the `postgres()` executor, the adapter-owned base schema
 * and its migrations, the sim-clock helpers and a Kysely dialect. PGlite lives in `./pglite` and
 * store conformance in `./conformance`, so this entry never loads either.
 */
export { postgres, type PostgresOptions } from './node-postgres.js';
export { sqlState } from './executor.js';
export { baseMigrations, baseSchemaVersion, baseTables } from './migrations/index.js';
export { computeNowMode, restoreSystemClock, setSimClock, useSimClock } from './clock.js';
export { kyselyDialect } from './kysely.js';
