import { afterEach, describe, expect, it } from 'vitest';
import { defineSink, type ComputeEvent } from '@better-compute/core';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { sibling } from './support/runtime.js';

// Durable OutboxDispatch cursors (PLAN.md §8.4, core/0009_runtime): each event sink's position is
// saved in `outbox_cursors` (`sink:<id>`, stream `outbox`) after every delivered batch and loaded
// whenever a process takes the outbox-dispatch lease, so a new holder resumes instead of
// redelivering from the origin. Saves only move a cursor forward.

afterEach(closeFixtures);

function collectingSink(id: string) {
  const delivered: ComputeEvent[] = [];
  const sink = defineSink({
    kind: 'events',
    id,
    async deliver(events) {
      delivered.push(...events);
    },
  });
  return { sink, delivered, types: () => delivered.map((event) => event.type) };
}

const quiet = () => {
  const entries: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void entries.push({ level, message });
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

async function publish(
  compute: { context: ComputeFixture['compute']['context'] },
  ...types: string[]
) {
  await compute.context.sql.transaction(async (tx) => {
    for (const type of types)
      await compute.context.events.publish(tx, { type, tenantId: 't', subject: 's', data: null });
  });
}

async function storedCursor(fixture: ComputeFixture, name: string) {
  const { rows } = await fixture.database.query<{
    stream: string;
    txid_text: string;
    seq_text: string;
  }>(
    'SELECT stream, txid::text AS txid_text, seq::text AS seq_text FROM outbox_cursors WHERE name = $1',
    [name],
  );
  return rows[0]
    ? { stream: rows[0].stream, sequence: `${rows[0].txid_text}:${rows[0].seq_text}` }
    : undefined;
}

describe('durable sink cursors', () => {
  it('saves each sink cursor after a delivered batch, at the last delivered event', async () => {
    const fixture = await computeFixture();
    const first = collectingSink('first');
    const second = collectingSink('second');
    const compute = await sibling(fixture, { sinks: { events: [first.sink, second.sink] } });
    expect(await storedCursor(fixture, 'sink:first')).toBeUndefined();
    await publish(compute, 'node.a', 'node.b');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(4);
    const last = first.delivered.at(-1)!.sequence;
    expect(await storedCursor(fixture, 'sink:first')).toEqual({ stream: 'outbox', sequence: last });
    expect(await storedCursor(fixture, 'sink:second')).toEqual({
      stream: 'outbox',
      sequence: last,
    });
  });

  it('lets a new holder resume where the last one saved, without redelivery', async () => {
    const fixture = await computeFixture();
    const before = collectingSink('webhook');
    const holder = await sibling(fixture, { sinks: { events: [before.sink] } });
    await publish(holder, 'node.a', 'node.b');
    expect(await holder.jobs['outbox-dispatch']!.tick()).toBe(2);
    await holder.stop(); // releases the outbox-dispatch lease

    const after = collectingSink('webhook');
    const fresh = collectingSink('fresh'); // no stored cursor: starts at the origin
    const next = await sibling(fixture, { sinks: { events: [after.sink, fresh.sink] } });
    expect(await next.jobs['outbox-dispatch']!.tick()).toBe(2); // fresh only
    expect(after.types()).toEqual([]);
    expect(fresh.types()).toEqual(['node.a', 'node.b']);
    await publish(next, 'node.c');
    expect(await next.jobs['outbox-dispatch']!.tick()).toBe(2);
    expect(after.types()).toEqual(['node.c']);
    expect(before.types()).toEqual(['node.a', 'node.b']);
  });

  it('reloads the stored cursors when it takes the lease again under a new epoch', async () => {
    const fixture = await computeFixture();
    const sink = collectingSink('reload');
    const compute = await sibling(fixture, { sinks: { events: [sink.sink] } });
    await publish(compute, 'node.a');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(1);
    // Meanwhile another worker held the lease and delivered node.b: its cursor is ahead.
    await publish(compute, 'node.b');
    const { rows } = await fixture.database.query<{ txid_text: string; seq_text: string }>(
      "SELECT txid::text AS txid_text, seq::text AS seq_text FROM outbox WHERE topic = 'node.b'",
    );
    await fixture.database.query(
      `UPDATE outbox_cursors SET txid = $1::xid8, seq = $2::bigint WHERE name = 'sink:reload'`,
      [rows[0]!.txid_text, rows[0]!.seq_text],
    );
    await fixture.database.query(
      `UPDATE leases SET owner = 'another-worker', epoch = epoch + 1, expires_at = compute_now()
        WHERE name = 'singleton:outbox-dispatch:reload'`,
    );
    await fixture.advance(11_000); // past the renewal point: the next pass goes to the table
    await publish(compute, 'node.c');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(1);
    expect(sink.types()).toEqual(['node.a', 'node.c']);
  });

  it('never moves a stored cursor back (a late save by a stale holder)', async () => {
    const fixture = await computeFixture();
    const sink = collectingSink('forward');
    // Reads 4 events per pass (batchSize × 4).
    const compute = await sibling(fixture, {
      sinks: { events: [sink.sink] },
      worker: { batchSize: 1 },
    });
    await publish(compute, 'node.e1');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(1);
    await publish(compute, 'node.e2', 'node.e3', 'node.e4', 'node.e5', 'node.e6');
    // Another holder already delivered through e6 and saved it; this process has not reloaded.
    const { rows } = await fixture.database.query<{ txid_text: string; seq_text: string }>(
      "SELECT txid::text AS txid_text, seq::text AS seq_text FROM outbox WHERE topic = 'node.e6'",
    );
    const e6 = `${rows[0]!.txid_text}:${rows[0]!.seq_text}`;
    await fixture.database.query(
      `UPDATE outbox_cursors SET txid = $1::xid8, seq = $2::bigint WHERE name = 'sink:forward'`,
      [rows[0]!.txid_text, rows[0]!.seq_text],
    );
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(4); // e2..e5, saved as e5
    expect((await storedCursor(fixture, 'sink:forward'))!.sequence).toBe(e6);
  });

  it('refuses two event sinks with one id (their cursors would collide)', async () => {
    const fixture = await computeFixture();
    await expect(
      sibling(fixture, {
        sinks: { events: [collectingSink('same').sink, { ...collectingSink('same').sink }] },
      }),
    ).rejects.toThrow(/Event sink same is listed twice|registered twice/);
  });

  it('keeps cursors in memory on a schema without outbox_cursors', async () => {
    const fixture = await computeFixture();
    await fixture.database.query('DROP TABLE outbox_cursors');
    const log = quiet();
    const sink = collectingSink('memory');
    const compute = await sibling(fixture, { sinks: { events: [sink.sink] }, log });
    await publish(compute, 'node.a');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(1);
    await publish(compute, 'node.b');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(1);
    expect(sink.types()).toEqual(['node.a', 'node.b']);
    expect(log.entries.filter((entry) => /outbox_cursors/.test(entry.message))).toHaveLength(1);
  });
});
