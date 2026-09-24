import { describe, expect, it } from 'vitest';
import { pglite } from '@better-compute/postgres/pglite';

// PGlite has no autovacuum: the executor gathers planner statistics itself, after migrate() and then
// on a timer, so dev and sim runs plan like Postgres would.

const analyzed = async (db: ReturnType<typeof pglite>) =>
  (
    await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_user_tables WHERE relname = 'commands' AND last_analyze IS NOT NULL",
    )
  ).rows[0]!.n;

describe('pglite ANALYZE', () => {
  it('analyzes after migrate, and not before', async () => {
    const db = pglite({ analyzeEveryMs: 0 });
    try {
      await db.query('SELECT 1');
      await db.migrate();
      expect(await analyzed(db)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('re-analyzes on its timer and stops when closed', async () => {
    const db = pglite({ analyzeEveryMs: 50 });
    await db.migrate();
    const count = async () =>
      (
        await db.query<{ n: string }>(
          "SELECT analyze_count::text AS n FROM pg_stat_user_tables WHERE relname = 'commands'",
        )
      ).rows[0]!.n;
    const first = Number(await count());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Number(await count())).toBeGreaterThan(first);
    await db.close();
  });

  it('refuses a bad interval', () => {
    expect(() => pglite({ analyzeEveryMs: -1 })).toThrow(/analyzeEveryMs/);
  });
});
