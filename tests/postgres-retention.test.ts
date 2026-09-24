import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { loadCursor, pruneBehindCursors, saveCursor, setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// core/0009_runtime: durable cursors and retention behind every cursor of a stream (PLAN.md §8.4).

let db: SqlExecutor;
const START = Date.UTC(2026, 8, 1);

async function write(topic: string, n: number) {
  for (let i = 0; i < n; i++) await db.query(`INSERT INTO outbox (topic, payload) VALUES ($1, '{"tenantId":"t1"}')`, [topic]);
}
const rows = async () =>
  (await db.query<{ seq: number; txid_text: string }>('SELECT seq, txid::text AS txid_text FROM outbox ORDER BY outbox.txid, outbox.seq')).rows;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, START);
});
afterAll(() => db.close());

describe('cursors', () => {
  it('saves and loads a position', async () => {
    expect(await loadCursor(db, 'sink:webhooks')).toBeUndefined();
    await saveCursor(db, { name: 'sink:webhooks', txid: '123', seq: 4 });
    await saveCursor(db, { name: 'sink:webhooks', txid: '130', seq: 9 });
    expect(await loadCursor(db, 'sink:webhooks')).toEqual({ txid: '130', seq: 9 });
    await db.query('DELETE FROM outbox_cursors');
  });
});

describe('pruneBehindCursors', () => {
  it('never prunes a stream without cursors', async () => {
    await write('a', 3);
    await setSimClock(db, START + 2 * 3600_000);
    expect(await pruneBehindCursors(db, 'outbox')).toBe(0);
  });

  it('prunes only what every cursor passed, and only past the minimum age', async () => {
    const all = await rows();
    // Two readers: the slow one is at the second row, the fast one at the last.
    await saveCursor(db, { name: 'slow', txid: all[1]!.txid_text, seq: all[1]!.seq });
    await saveCursor(db, { name: 'fast', txid: all[2]!.txid_text, seq: all[2]!.seq });
    expect(await pruneBehindCursors(db, 'outbox', { minAgeSeconds: 3 * 3600 })).toBe(0); // too young
    expect(await pruneBehindCursors(db, 'outbox', { minAgeSeconds: 3600 })).toBe(2);
    expect((await rows()).map((r) => r.seq)).toEqual([all[2]!.seq]);
  });

  it('works in batches and keeps the authz_changes stream separate', async () => {
    await write('b', 5);
    const all = await rows();
    await saveCursor(db, { name: 'slow', txid: all.at(-1)!.txid_text, seq: all.at(-1)!.seq });
    await saveCursor(db, { name: 'fast', txid: all.at(-1)!.txid_text, seq: all.at(-1)!.seq });
    await setSimClock(db, START + 5 * 3600_000);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await rows()).toEqual([]);
    await db.query(`INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ('pool', 'p1', 't1', 'upsert')`);
    expect(await pruneBehindCursors(db, 'authz_changes', { minAgeSeconds: 0 })).toBe(0); // no authz cursor
    await expect(pruneBehindCursors(db, 'webhooks' as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('adds work_queue.attempts, commands.owner and the tenant indexes', async () => {
    const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name, column_name) IN (('work_queue', 'attempts'), ('commands', 'owner'), ('outbox', 'created_at'))
        ORDER BY table_name`,
    );
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual(['commands.owner', 'outbox.created_at', 'work_queue.attempts']);
    const { rows: indexes } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('outbox_tenant_cursor', 'usage_windows_tenant', 'join_tokens_tenant_pool') ORDER BY 1`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(['join_tokens_tenant_pool', 'outbox_tenant_cursor', 'usage_windows_tenant']);
  });
});
