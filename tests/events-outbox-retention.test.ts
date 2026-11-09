import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { eventsMigrations, fanOutWebhooks } from '@better-compute/events';
import { pruneBehindCursors, saveCursor, setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// The webhook fan-out reads the outbox like any sink, but keeps its position in the events module's own
// table (`event_cursors`). Outbox retention has to wait for it too: it used to floor on `outbox_cursors`
// only, so with a sink ahead of a lagging fan-out the events in between were deleted unread.

let db: SqlExecutor;
const START = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;

const write = async (n: number) => {
  for (let i = 0; i < n; i++)
    await db.query(`INSERT INTO outbox (topic, payload) VALUES ('x.y', '{"tenantId":"t1"}')`);
};
const rows = async () =>
  (
    await db.query<{ seq: number; txid_text: string }>(
      'SELECT seq, txid::text AS txid_text FROM outbox ORDER BY outbox.txid, outbox.seq',
    )
  ).rows;
const fanOutAt = (row: { txid_text: string; seq: number }) =>
  db.query(
    `INSERT INTO event_cursors (name, txid, seq) VALUES ('webhooks', $1::xid8, $2)
     ON CONFLICT (name) DO UPDATE SET txid = EXCLUDED.txid, seq = EXCLUDED.seq`,
    [row.txid_text, row.seq],
  );

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await db.migrate([...eventsMigrations]);
  await useSimClock(db, START);
});
afterAll(() => db.close());

describe('outbox retention and the webhook fan-out cursor', () => {
  it('never deletes what the fan-out has not read, however far a sink is ahead', async () => {
    await write(4);
    const all = await rows();
    // A sink has read everything; the fan-out is still at the first row.
    await saveCursor(db, { name: 'sink:audit', txid: all[3]!.txid_text, seq: all[3]!.seq });
    await fanOutAt(all[0]!);
    await setSimClock(db, START + 2 * HOUR);
    expect(await pruneBehindCursors(db, 'outbox')).toBe(1);
    expect((await rows()).map((row) => row.seq)).toEqual(all.slice(1).map((row) => row.seq));

    // The fan-out catches up (its real pass, from its saved cursor): the rest may go.
    expect(await fanOutWebhooks(db)).toMatchObject({ events: 3 });
    expect(await pruneBehindCursors(db, 'outbox')).toBe(3);
    expect(await rows()).toEqual([]);
  });

  it('prunes behind the fan-out alone when no sink keeps a cursor', async () => {
    await db.query('DELETE FROM outbox_cursors');
    await write(3);
    const all = await rows();
    await fanOutAt(all[1]!);
    await setSimClock(db, START + 4 * HOUR);
    expect(await pruneBehindCursors(db, 'outbox')).toBe(2);
    expect((await rows()).map((row) => row.seq)).toEqual([all[2]!.seq]);
  });

  it('keeps the authz_changes stream to its own cursors', async () => {
    await db.query(`INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ('pool', 'p1', 't1', 'upsert')`);
    await setSimClock(db, START + 6 * HOUR);
    // The fan-out cursor is far ahead, but it reads the outbox, not authz_changes.
    expect(await pruneBehindCursors(db, 'authz_changes')).toBe(0);
  });
});
