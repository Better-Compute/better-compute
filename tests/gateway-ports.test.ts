import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { sqlEventPublisher, sqlWorkQueue } from '@better-compute/gateway';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// The gateway's default SQL ports (§8.4): the set-based enqueueMany/publishMany must write exactly
// what the same calls one by one would.

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
let db: SqlExecutor;
beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, T0);
});
afterAll(() => db.close());

const rows = async (kind: string) =>
  (
    await db.query<{ key: string; shard: number; gen: number; not_before: Date }>(
      'SELECT key, shard, gen, not_before FROM work_queue WHERE kind = $1 ORDER BY key',
      [kind],
    )
  ).rows.map((row) => ({ ...row, not_before: row.not_before.getTime() }));

describe('sqlWorkQueue.enqueueMany', () => {
  it('matches N single enqueues, including repeated keys within one call and existing rows', async () => {
    const existing = ['k1', 'k2'];
    const batch = ['k2', 'k3', 'k3', 'k1', 'k3', 'k4'];
    await db.transaction(async (tx) => {
      for (const kind of ['single', 'many'])
        for (const key of existing) await sqlWorkQueue.enqueue(tx, kind, key, { notBefore: T0 + 60_000 });
    });
    await setSimClock(db, T0 + 1_000);
    await db.transaction(async (tx) => {
      for (const key of batch) await sqlWorkQueue.enqueue(tx, 'single', key);
      await sqlWorkQueue.enqueueMany!(tx, 'many', batch);
    });
    expect(await rows('many')).toEqual(await rows('single'));
    expect((await rows('many')).map((row) => [row.key, row.gen])).toEqual([
      ['k1', 2],
      ['k2', 2],
      ['k3', 3],
      ['k4', 1],
    ]);
    // Existing rows keep the earlier not_before (LEAST), new ones get compute_now().
    expect((await rows('many')).find((row) => row.key === 'k4')!.not_before).toBe(T0 + 1_000);
    expect((await rows('many')).find((row) => row.key === 'k1')!.not_before).toBe(T0 + 1_000);
  });

  it('honours notBefore and does nothing for an empty list', async () => {
    await db.transaction(async (tx) => {
      await sqlWorkQueue.enqueueMany!(tx, 'later', ['x', 'y'], { notBefore: T0 + 5 * 60_000 });
      await sqlWorkQueue.enqueueMany!(tx, 'later', []);
    });
    expect((await rows('later')).map((row) => [row.key, row.gen, row.not_before])).toEqual([
      ['x', 1, T0 + 5 * 60_000],
      ['y', 1, T0 + 5 * 60_000],
    ]);
  });
});

describe('sqlEventPublisher.publishMany', () => {
  it('writes the same rows as single publishes, in input order', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      type: i % 2 ? 'command.settled' : 'node.event',
      tenantId: 'tenant-a',
      subject: `node/n${i}`,
      data: { i, nested: { ok: true } },
    }));
    const read = async () =>
      (
        await db.query<{ topic: string; payload: Record<string, unknown> }>(
          `SELECT topic, payload FROM outbox WHERE payload->>'tenantId' = 'tenant-a' ORDER BY seq`,
        )
      ).rows.map(({ topic, payload }) => {
        const { id, ...rest } = payload;
        expect(String(id)).toMatch(/^evt_/);
        return { topic, ...rest };
      });
    await db.transaction(async (tx) => {
      for (const event of events) await sqlEventPublisher.publish(tx, event);
    });
    const single = await read();
    await db.query(`DELETE FROM outbox WHERE payload->>'tenantId' = 'tenant-a'`);
    await db.transaction((tx) => sqlEventPublisher.publishMany!(tx, events));
    expect(await read()).toEqual(single);
    expect(single.map((row) => (row as { data: { i: number } }).data.i)).toEqual([0, 1, 2, 3, 4]);
  });
});
