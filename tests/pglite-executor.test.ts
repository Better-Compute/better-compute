import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError, type SqlExecutor } from '@better-compute/core';
import { kyselyDialect, sqlState } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// The PGlite executor: one connection, transactions serialized behind an async mutex, nested
// transactions as savepoints, rollback on throw.

let db: SqlExecutor;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  db = pglite();
  await db.query('CREATE TABLE items (id text PRIMARY KEY, n int NOT NULL DEFAULT 0)');
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query('DELETE FROM items');
});

const ids = async () =>
  (await db.query<{ id: string }>('SELECT id FROM items ORDER BY id')).rows.map((row) => row.id);

describe('pglite()', () => {
  it('is synchronous, lazy and reports its kind', () => {
    const lazy = pglite();
    expect(lazy.kind).toBe('pglite');
    expect(lazy.dialect).toBe('postgres');
    return lazy.close();
  });

  it('validates its options', () => {
    expect(() => pglite({ dataDir: '' })).toThrow(ComputeError);
    expect(() => pglite({ extensions: null as never })).toThrow(/extensions/);
  });

  it('runs PostgreSQL 16 or later with btree_gist available', async () => {
    const { rows } = await db.query<{ version: number }>(
      "SELECT current_setting('server_version_num')::int AS version",
    );
    expect(rows[0]!.version).toBeGreaterThanOrEqual(160000);
    const extension = await db.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist'",
    );
    expect(extension.rowCount).toBe(1);
  });
});

describe('values', () => {
  it('reads the same shapes as the postgres() executor', async () => {
    const { rows } = await db.query(
      `SELECT 42::int8 AS int8, 9007199254740993::int8 AS huge, 1.5::numeric AS numeric,
              '\\x0102'::bytea AS bytes, '{"a":[1]}'::jsonb AS json,
              '2026-01-02T03:04:05.678Z'::timestamptz AS at, '{a,b}'::text[] AS texts,
              '{1,2}'::int8[] AS int8s, interval '90 minutes' AS span, true AS flag`,
    );
    expect(rows[0]).toEqual({
      int8: 42,
      huge: 9007199254740993n,
      numeric: '1.5',
      bytes: new Uint8Array([1, 2]),
      json: { a: [1] },
      at: new Date('2026-01-02T03:04:05.678Z'),
      texts: ['a', 'b'],
      int8s: [1, 2],
      span: '01:30:00',
      flag: true,
    });
  });

  it('takes jsonb as JSON text, bytea as Uint8Array and timestamps as Date', async () => {
    const { rows } = await db.query(
      'SELECT $1::jsonb AS json, $2::bytea AS bytes, $3::timestamptz AS at, $4::text[] AS texts',
      ['[1,2]', new Uint8Array([9]), new Date(0), ['x', 'y']],
    );
    expect(rows[0]).toEqual({
      json: [1, 2],
      bytes: new Uint8Array([9]),
      at: new Date(0),
      texts: ['x', 'y'],
    });
  });

  it('reports rowCount for reads and writes', async () => {
    await db.query("INSERT INTO items (id) VALUES ('a'), ('b')");
    expect((await db.query('UPDATE items SET n = n + 1')).rowCount).toBe(2);
    expect((await db.query('SELECT * FROM items')).rowCount).toBe(2);
    expect((await db.query("DELETE FROM items WHERE id = 'zzz'")).rowCount).toBe(0);
  });

  it('runs exactly one statement per query(), as postgres() does', async () => {
    const failure = await db.query('SELECT 1; SELECT 2').catch((error: unknown) => error);
    expect(sqlState(failure)).toBe('42601');
  });
});

describe('transactions', () => {
  it('commits when fn resolves and returns its value', async () => {
    const value = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('a')");
      return 7;
    });
    expect(value).toBe(7);
    expect(await ids()).toEqual(['a']);
  });

  it('rolls back when fn throws and rethrows the same error', async () => {
    const failure = new Error('boom');
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO items (id) VALUES ('a')");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await ids()).toEqual([]);
  });

  it('rolls back and rejects when fn swallows a statement error', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO items (id) VALUES ('a')");
        await tx.query("INSERT INTO items (id) VALUES ('a')").catch(() => undefined);
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await ids()).toEqual([]);
  });

  it('rejects use of a transaction handle after it completed', async () => {
    let leaked: { query(text: string): Promise<unknown> } | undefined;
    await db.transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query('SELECT 1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('applies isolation and read-only options', async () => {
    const isolation = await db.transaction(
      async (tx) =>
        (
          await tx.query<{ level: string }>(
            "SELECT current_setting('transaction_isolation') AS level",
          )
        ).rows[0]!.level,
      { isolation: 'serializable' },
    );
    expect(isolation).toBe('serializable');
    const failure = await db
      .transaction((tx) => tx.query("INSERT INTO items (id) VALUES ('a')"), { readOnly: true })
      .catch((error: unknown) => error);
    expect(sqlState(failure)).toBe('25006');
    await expect(
      db.transaction(async () => undefined, { isolation: 'chaos' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('the mutex', () => {
  it('runs concurrent transactions one at a time, in arrival order', async () => {
    const events: string[] = [];
    const run = (name: string, ms: number) =>
      db.transaction(async (tx) => {
        events.push(`${name}:start`);
        await pause(ms);
        await tx.query('INSERT INTO items (id) VALUES ($1)', [name]);
        events.push(`${name}:end`);
      });
    await Promise.all([run('a', 40), run('b', 0), run('c', 10)]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(await ids()).toEqual(['a', 'b', 'c']);
  });

  it('holds standalone statements until the running transaction commits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('a')");
      await gate;
    });
    await pause(10);
    const reader = db.query('SELECT count(*)::int AS n FROM items');
    let read = false;
    void reader.then(() => (read = true));
    await pause(30);
    expect(read).toBe(false);
    release();
    await writer;
    expect((await reader).rows).toEqual([{ n: 1 }]);
  });

  it('does not serialize work that joins the running transaction', async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('a')");
      // The executor itself, inside the transaction's call chain, joins it instead of waiting.
      return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM items')).rows[0]!.n;
    });
    expect(seen).toBe(1);
  });

  it('keeps working after a transaction fails', async () => {
    await db.transaction(async () => Promise.reject(new Error('first'))).catch(() => undefined);
    await db.transaction((tx) => tx.query("INSERT INTO items (id) VALUES ('b')"));
    expect(await ids()).toEqual(['b']);
  });
});

describe('nested transactions', () => {
  it('run as savepoints: a failed one rolls back alone', async () => {
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('outer')");
      await expect(
        db.transaction(async (inner) => {
          await inner.query("INSERT INTO items (id) VALUES ('rolled-back')");
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
      await db.transaction((inner) => inner.query("INSERT INTO items (id) VALUES ('kept')"));
    });
    expect(await ids()).toEqual(['kept', 'outer']);
  });

  it('nest to any depth', async () => {
    await db.transaction(async () => {
      await db.transaction(async (one) => {
        await one.query("INSERT INTO items (id) VALUES ('one')");
        await db
          .transaction(async (two) => {
            await two.query("INSERT INTO items (id) VALUES ('two')");
            await db.transaction((three) => three.query("INSERT INTO items (id) VALUES ('three')"));
            throw new Error('two');
          })
          .catch(() => undefined);
      });
    });
    expect(await ids()).toEqual(['one']);
  });

  it('recover from a statement error inside them', async () => {
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('a')");
      const failure = await db
        .transaction((inner) => inner.query("INSERT INTO items (id) VALUES ('a')"))
        .catch((error: unknown) => error);
      expect(sqlState(failure)).toBe('23505');
      await tx.query("INSERT INTO items (id) VALUES ('b')");
    });
    expect(await ids()).toEqual(['a', 'b']);
  });

  it('roll back and reject when their fn swallows a statement error', async () => {
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id) VALUES ('a')");
      await expect(
        db.transaction(async (inner) => {
          await inner.query("INSERT INTO items (id) VALUES ('c')");
          await inner.query("INSERT INTO items (id) VALUES ('a')").catch(() => undefined);
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      await tx.query("INSERT INTO items (id) VALUES ('b')");
    });
    expect(await ids()).toEqual(['a', 'b']);
  });

  it('opened side by side run one after another', async () => {
    const events: string[] = [];
    await db.transaction(async () => {
      const nested = (name: string, ms: number) =>
        db.transaction(async (tx) => {
          events.push(`${name}:start`);
          await pause(ms);
          await tx.query('INSERT INTO items (id) VALUES ($1)', [name]);
          events.push(`${name}:end`);
        });
      await Promise.all([nested('a', 20), nested('b', 0)]);
    });
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(await ids()).toEqual(['a', 'b']);
  });

  it('cannot change isolation or read-only mode', async () => {
    await db.transaction(async () => {
      await expect(
        db.transaction(async () => undefined, { isolation: 'serializable' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(db.transaction(async () => undefined, { readOnly: true })).rejects.toMatchObject(
        { code: 'INVALID_INPUT' },
      );
      await db.transaction(async () => undefined, { isolation: 'read committed' });
    });
  });

  it('close their handle when they end, while the outer one stays open', async () => {
    let inner: { query(text: string): Promise<unknown> } | undefined;
    await db.transaction(async (tx) => {
      await db.transaction(async (handle) => {
        inner = handle;
      });
      await expect(inner!.query('SELECT 1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      await tx.query('SELECT 1');
    });
  });
});

describe('kyselyDialect', () => {
  // kysely is the package's dependency, not the workspace root's, so these drive the dialect's
  // driver directly with compiled queries as Kysely would hand them over.
  const compiled = (sql: string, parameters: unknown[], kind: string) =>
    ({ sql, parameters, query: { kind } }) as never;

  it('runs compiled queries through the executor, counting affected rows for writes', async () => {
    const driver = kyselyDialect(db).createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    const inserted = await connection.executeQuery(
      compiled('INSERT INTO items (id, n) VALUES ($1, $2)', ['k', 3], 'InsertQueryNode'),
    );
    expect(inserted).toEqual({ rows: [], numAffectedRows: 1n });
    const selected = await connection.executeQuery(
      compiled('SELECT id, n FROM items WHERE id = $1', ['k'], 'SelectQueryNode'),
    );
    expect(selected).toEqual({ rows: [{ id: 'k', n: 3 }] });
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  it('joins the executor transaction it runs in, and refuses transactions of its own', async () => {
    const driver = kyselyDialect(db).createDriver();
    const connection = await driver.acquireConnection();
    await expect(
      db.transaction(async () => {
        await connection.executeQuery(
          compiled("INSERT INTO items (id) VALUES ('in-tx')", [], 'InsertQueryNode'),
        );
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await ids()).toEqual([]);
    await expect(driver.beginTransaction(connection, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('builds the PostgreSQL compiler, adapter and introspector', () => {
    const dialect = kyselyDialect(db);
    expect(dialect.createQueryCompiler().constructor.name).toBe('PostgresQueryCompiler');
    expect(dialect.createAdapter().supportsReturning).toBe(true);
  });
});

describe('close()', () => {
  it('waits for the running transaction, then refuses new work', async () => {
    const own = pglite();
    await own.query('CREATE TABLE t (id int)');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = own.transaction(async (tx) => {
      await gate;
      await tx.query('INSERT INTO t VALUES (1)');
    });
    await pause(10);
    const closing = own.close();
    release();
    await running;
    await closing;
    await expect(own.query('SELECT 1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(own.transaction(async () => undefined)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    await own.close();
  });

  it('cannot run inside one of its transactions', async () => {
    await expect(db.transaction(() => db.close())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect((await db.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  });
});
