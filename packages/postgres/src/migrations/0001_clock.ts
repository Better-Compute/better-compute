import type { Migration } from '@better-compute/core';

// The one migration allowed to read the database clock directly (scripts/check-sql-now.mjs exempts
// this file by its name and marker). Everything else reads time through compute_now() (P9).

const header =
  'CREATE OR REPLACE FUNCTION compute_now() RETURNS timestamptz LANGUAGE sql STABLE AS';

/** Replaces `compute_now()` with the database's own clock: production. */
export const systemClockFunction = `${header} $$ SELECT now() $$`;

/** Replaces `compute_now()` with `compute_sim_clock`, which the simulator advances on each tick. */
export const simClockFunction = `${header} $$ SELECT ts FROM compute_sim_clock WHERE id = 1 $$`;

/** `btree_gist` (text equality inside `EXCLUDE USING gist`), the sim clock table and `compute_now()`. */
export const clockMigration: Migration = {
  name: 'core/0001_clock',
  sql: `
-- defines compute_now()
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Tests only: computeFixture({ clock: 'sim' }) points compute_now() here (useSimClock).
CREATE TABLE compute_sim_clock (id int PRIMARY KEY CHECK (id = 1), ts timestamptz NOT NULL);
CREATE FUNCTION compute_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT now() $$;
`,
};
