import { afterAll, beforeAll, describe, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { postgres } from '@better-compute/postgres';
import { storeConformanceCases } from '@better-compute/postgres/conformance';

// The full store conformance suite, concurrency cases included, on real PostgreSQL. Each case gets
// a fresh schema. Set BETTER_COMPUTE_POSTGRES_URL to a database the test may create schemas in
// (and btree_gist in, unless it is installed already).

const url = process.env.BETTER_COMPUTE_POSTGRES_URL;

/** The same database with search_path pinned to `schema` (then public, where btree_gist lives). */
function inSchema(connection: string, schema: string): string {
  const parsed = new URL(connection);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describe.skipIf(!url)('store conformance on PostgreSQL (a fresh schema per case)', () => {
  let admin: SqlExecutor;

  beforeAll(async () => {
    admin = postgres({ url: url! });
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
  });
  afterAll(async () => {
    await admin?.close();
  });

  for (const test of storeConformanceCases())
    it(test.name, async () => {
      const schema = `bc_conformance_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      // Concurrency cases hold up to nine transactions open at once.
      const db = postgres({ url: inSchema(url!, schema), max: 12 });
      try {
        await test.run(db);
      } finally {
        await db.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    });
});
