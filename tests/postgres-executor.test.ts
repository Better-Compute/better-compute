import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { postgres, sqlState } from '@better-compute/postgres';

// The node-postgres executor. Option checks run everywhere; the rest needs a real database
// (BETTER_COMPUTE_POSTGRES_URL) and runs in a schema of its own.

const url = process.env.BETTER_COMPUTE_POSTGRES_URL;

describe('postgres() options', () => {
  it('needs exactly one of url and pool', () => {
    expect(() => postgres(undefined as never)).toThrow(/url/);
    expect(() => postgres({})).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => postgres({ url: 'postgres://localhost/x', pool: {} as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });

  it('checks the url, the pool size and the statement timeout', () => {
    const bad = [
      { url: 'mysql://localhost/x' },
      { url: 'postgres://localhost/x', max: 0 },
      { url: 'postgres://localhost/x', max: 101 },
      { url: 'postgres://localhost/x', statementTimeoutMs: 0 },
      { url: 'postgres://localhost/x', statementTimeoutMs: 1.5 },
      { pool: { query() {} } as never },
    ];
    for (const options of bad)
      expect(() => postgres(options)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('connects lazily', async () => {
    const db = postgres({ url: 'postgres://nobody@127.0.0.1:1/none' });
    expect(db.kind).toBe('postgres');
    expect(db.dialect).toBe('postgres');
    await db.close();
    await expect(db.query('SELECT 1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe.skipIf(!url)('postgres() on PostgreSQL', () => {
  const schema = `bc_executor_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let admin: SqlExecutor;
  let db: SqlExecutor;

  beforeAll(async () => {
    admin = postgres({ url: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    db = postgres({ url: scoped.toString(), statementTimeoutMs: 1000 });
    await db.query('CREATE TABLE items (id text PRIMARY KEY)');
  });
  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.close();
  });

  const ids = async () =>
    (await db.query<{ id: string }>('SELECT id FROM items ORDER BY id')).rows.map((row) => row.id);

  it('reads int8 as a number and interval as text, like PGlite', async () => {
    const { rows } = await db.query(
      `SELECT 42::int8 AS int8, 9007199254740993::int8 AS huge, '{1,NULL,3}'::int8[] AS int8s,
              interval '90 minutes' AS span, 1.5::numeric AS numeric`,
    );
    expect(rows[0]).toEqual({
      int8: 42,
      huge: 9007199254740993n,
      int8s: [1, null, 3],
      span: '01:30:00',
      numeric: '1.5',
    });
  });

  it('runs one statement per query()', async () => {
    const failure = await db.query('SELECT 1; SELECT 2').catch((error: unknown) => error);
    expect(sqlState(failure)).toBe('42601');
  });

  it('applies statementTimeoutMs in transactions and to standalone statements', async () => {
    expect(sqlState(await db.query('SELECT pg_sleep(2)').catch((error: unknown) => error))).toBe(
      '57014',
    );
    const inside = await db
      .transaction((tx) => tx.query('SELECT pg_sleep(2)'))
      .catch((error: unknown) => error);
    expect(sqlState(inside)).toBe('57014');
  });

  it('turns nested transactions into savepoints', async () => {
    await db.query('DELETE FROM items');
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items VALUES ('outer')");
      await db
        .transaction(async (inner) => {
          await inner.query("INSERT INTO items VALUES ('rolled-back')");
          throw new Error('inner');
        })
        .catch(() => undefined);
      await db.transaction((inner) => inner.query("INSERT INTO items VALUES ('kept')"));
    });
    expect(await ids()).toEqual(['kept', 'outer']);
  });

  it('rejects a commit that PostgreSQL turned into a rollback', async () => {
    await db.query('DELETE FROM items');
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO items VALUES ('a')");
        await tx.query("INSERT INTO items VALUES ('a')").catch(() => undefined);
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await ids()).toEqual([]);
  });

  it('runs concurrent top-level transactions on separate connections', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = db.transaction(async (tx) => {
      await tx.query("INSERT INTO items VALUES ('first')");
      await gate;
    });
    // Not serialized behind the open transaction, and blind to its uncommitted row.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM items WHERE id = 'first'");
    expect(rows).toEqual([{ n: 0 }]);
    release();
    await first;
  });

  it('migrates a fresh schema', async () => {
    const result = await db.migrate();
    expect(result.applied).toEqual([
      'core/0001_clock',
      'core/0002_base',
      'core/0003_v01',
      'core/0004_command_cancel',
      'core/0005_audit_commit_order',
      'core/0006_pool_archive',
      'core/0007_device_health',
      'core/0008_session_versions',
      'core/0009_runtime',
      'core/0010_v02_server',
      'core/0011_v02_security',
      'core/0012_v02_evidence',
    ]);
    expect((await db.migrate()).applied).toEqual([]);
  });
});
