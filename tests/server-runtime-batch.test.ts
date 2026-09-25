import { afterEach, describe, expect, it } from 'vitest';
import {
  defineModule,
  defineSink,
  isComputeError,
  shardOf,
  type ComputeEvent,
  type ReconcileContext,
  type SqlTx,
} from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { seedNode, sibling, workRows } from './support/runtime.js';

// The set-based ports of 9cadaa9 (PLAN.md §8.4): `WorkQueue.enqueueMany` and
// `EventPublisher.publishMany`, one statement per batch, leaving exactly what the same single calls
// would. The gateway's group commit uses them when the host's ports have them.

afterEach(closeFixtures);

/** A transaction handle that counts the statements run through it. */
function counting(tx: SqlTx) {
  const counted = {
    statements: 0,
    query: ((text: string, params?: readonly unknown[]) => {
      counted.statements += 1;
      return tx.query(text, params);
    }) as SqlTx['query'],
  };
  return counted as SqlTx & { statements: number };
}

/** The rows of a kind, comparable across kinds. */
const snapshot = async (sql: SqlTx, kind: string) =>
  (await workRows(sql, kind)).map((row) => ({
    key: row.key,
    shard: row.shard,
    gen: Number(row.gen),
    notBefore: row.not_before.getTime(),
    claimed: row.claimed_until !== null,
  }));

describe('WorkQueue.enqueueMany', () => {
  it('leaves exactly the rows of the same single enqueues, duplicates and existing keys included', async () => {
    const { compute, database, clock } = await computeFixture();
    const { work } = compute.context;
    const later = clock.now() + 60_000;
    const rounds: { keys: string[]; notBefore?: number }[] = [
      { keys: ['a', 'b', 'a', 'c', 'a'], notBefore: later },
      { keys: ['b', 'd', 'd'] },
      { keys: ['c', 'e'], notBefore: later + 5_000 },
      { keys: ['e', 'e', 'a'] },
    ];
    for (const { keys, notBefore } of rounds) {
      const options = notBefore === undefined ? {} : { notBefore };
      await compute.context.sql.transaction((tx) =>
        work.enqueueMany!(tx, 'batched', keys, options),
      );
      await compute.context.sql.transaction(async (tx) => {
        for (const key of keys) await work.enqueue(tx, 'single', key, options);
      });
      expect(await snapshot(database, 'batched')).toEqual(await snapshot(database, 'single'));
    }
    const rows = await snapshot(database, 'batched');
    expect(rows.find((row) => row.key === 'a')).toMatchObject({ gen: 4, shard: shardOf('a') });
    expect(rows.find((row) => row.key === 'd')).toMatchObject({ gen: 2, notBefore: clock.now() });
    expect(rows.find((row) => row.key === 'c')).toMatchObject({ gen: 2, notBefore: later });
  });

  it('writes the whole batch in one statement, and nothing for an empty one', async () => {
    const { compute, database } = await computeFixture();
    await compute.context.sql.transaction(async (tx) => {
      const spy = counting(tx);
      await compute.context.work.enqueueMany!(spy, 'probe', ['k1', 'k2', 'k1', 'k3']);
      expect(spy.statements).toBe(1);
      await compute.context.work.enqueueMany!(spy, 'probe', []);
      expect(spy.statements).toBe(1);
    });
    expect((await workRows(database, 'probe')).map((row) => [row.key, Number(row.gen)])).toEqual([
      ['k1', 2],
      ['k2', 1],
      ['k3', 1],
    ]);
  });

  it('checks the kind, every key and notBefore before writing anything', async () => {
    const { compute, database } = await computeFixture();
    const { work } = compute.context;
    for (const call of [
      () => work.enqueueMany!(database, 'Bad Kind', ['k']),
      () => work.enqueueMany!(database, 'probe', ['ok', '']),
      () => work.enqueueMany!(database, 'probe', ['ok', 'x'.repeat(513)]),
      () => work.enqueueMany!(database, 'probe', ['ok', 7 as never]),
      () => work.enqueueMany!(database, 'probe', 'k1' as never),
      () => work.enqueueMany!(database, 'probe', ['ok'], { notBefore: Number.NaN }),
    ])
      await expect(call()).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
    expect(await workRows(database, 'probe')).toEqual([]);
  });

  it('rolls back with its transaction', async () => {
    const { compute, database } = await computeFixture();
    await expect(
      compute.context.sql.transaction(async (tx) => {
        await compute.context.work.enqueueMany!(tx, 'probe', ['k1', 'k2']);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await workRows(database, 'probe')).toEqual([]);
  });

  it('re-dirties a key its reconciler is running, so the run is repeated', async () => {
    const runs: string[] = [];
    let redirty = true;
    const racer = defineModule({
      name: 'racer',
      reconcilers: [
        {
          name: 'race',
          shardBy: 'none',
          async run(context: ReconcileContext, key: string) {
            runs.push(key);
            if (redirty) {
              redirty = false;
              await context.sql.transaction((tx) =>
                context.work.enqueueMany!(tx, 'race', [key, 'other']),
              );
            }
            return 'DONE';
          },
        },
      ],
    });
    const { compute, database } = await computeFixture({ modules: [racer] });
    await compute.context.sql.transaction((tx) =>
      compute.context.work.enqueueMany!(tx, 'race', ['k1']),
    );
    expect(await compute.jobs.race!.tick()).toBe(1);
    // The claimed row was bumped mid-run: DONE at the claimed gen left it due again.
    expect((await workRows(database, 'race')).map((row) => row.key).sort()).toEqual([
      'k1',
      'other',
    ]);
    await compute.jobs.race!.tick();
    await compute.jobs.race!.tick();
    expect(runs.sort()).toEqual(['k1', 'k1', 'other']);
    expect(await workRows(database, 'race')).toEqual([]);
  });
});

describe('EventPublisher.publishMany', () => {
  const event = (type: string, tenantId: string, index: number) => ({
    type,
    tenantId,
    subject: `node/n${index}`,
    data: { index, nested: { list: [index, 'x'] } },
  });

  it('writes the rows of the same single publishes, in input order, in one statement', async () => {
    const fixture = await computeFixture();
    const { compute, database, clock } = fixture;
    const tenantId = fixture.tenants.acme.id;
    const batch = [
      event('node.connected', tenantId, 1),
      event('node.status', tenantId, 2),
      { type: 'node.disconnected', tenantId, subject: 'node/n3', data: undefined as never },
      event('command.settled', tenantId, 4),
    ];
    await compute.context.sql.transaction(async (tx) => {
      const spy = counting(tx);
      await compute.context.events.publishMany!(spy, batch);
      expect(spy.statements).toBe(1);
    });
    await compute.context.sql.transaction(async (tx) => {
      for (const item of batch) await compute.context.events.publish(tx, item);
    });
    const { rows } = await database.query<{
      seq: string;
      topic: string;
      payload: Record<string, unknown>;
    }>('SELECT seq::text AS seq, topic, payload FROM outbox ORDER BY outbox.seq');
    expect(rows).toHaveLength(8);
    const strip = (row: (typeof rows)[number]) => {
      const { id, ...rest } = row.payload;
      expect(String(id)).toMatch(/^evt_/);
      return { topic: row.topic, payload: rest };
    };
    const batched = rows.slice(0, 4).map(strip);
    const single = rows.slice(4).map(strip);
    expect(batched).toEqual(single);
    expect(batched.map((row) => row.topic)).toEqual(batch.map((item) => item.type));
    expect(batched[0]!.payload).toMatchObject({
      type: 'node.connected',
      tenantId,
      subject: 'node/n1',
      data: { index: 1, nested: { list: [1, 'x'] } },
    });
    expect(batched[2]!.payload.data).toBeNull();
    for (const row of batched)
      expect(new Date(String(row.payload.time)).getTime()).toBe(clock.now());
    expect(new Set(rows.map((row) => row.payload.id)).size).toBe(8);
  });

  it('checks every event before writing anything; an empty batch writes nothing', async () => {
    const fixture = await computeFixture();
    const { events } = fixture.compute.context;
    const good = { type: 'node.connected', tenantId: 't', subject: 'node/n', data: null };
    for (const bad of [
      { ...good, type: 'noDot' },
      { ...good, tenantId: '' },
      { ...good, subject: '' },
      { ...good, data: { big: 'x'.repeat(70_000) } },
      { ...good, data: { n: 10n } as never },
    ])
      await expect(events.publishMany!(fixture.database, [good, bad])).rejects.toSatisfy(
        (error: unknown) => isComputeError(error, 'INVALID_INPUT'),
      );
    await expect(events.publishMany!(fixture.database, good as never)).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'INVALID_INPUT'),
    );
    await events.publishMany!(fixture.database, []);
    const { rows } = await fixture.database.query('SELECT 1 FROM outbox');
    expect(rows).toEqual([]);
  });

  it('reaches sinks like single publishes: once each, in (txid, seq) order', async () => {
    const fixture = await computeFixture();
    const delivered: ComputeEvent[] = [];
    const sink = defineSink({
      kind: 'events',
      id: 'collect',
      async deliver(events) {
        delivered.push(...events);
      },
    });
    const compute = await sibling(fixture, { sinks: { events: [sink] } });
    const tenantId = fixture.tenants.acme.id;
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publishMany!(tx, [
        event('node.a', tenantId, 1),
        event('node.b', tenantId, 2),
      ]),
    );
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publish(tx, event('node.c', tenantId, 3)),
    );
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(3);
    expect(delivered.map((item) => item.type)).toEqual(['node.a', 'node.b', 'node.c']);
    expect(delivered.map((item) => item.subject)).toEqual(['node/n1', 'node/n2', 'node/n3']);
  });
});

describe('the CommandSweeper on the set-based ports', () => {
  it('wakes each node once per pass and publishes command.settled in command id order', async () => {
    const fixture = await computeFixture();
    const { compute, database, clock, advance } = fixture;
    const tenantId = fixture.tenants.acme.id;
    const nodes = [
      await seedNode(database, { tenantId, id: 'node_a' }),
      await seedNode(database, { tenantId, id: 'node_b' }),
    ];
    const ids: string[] = [];
    for (let index = 0; index < 5; index++)
      ids.push(
        (
          await compute.context.sql.transaction((tx) =>
            compute.context.commands.enqueue(tx, {
              nodeId: nodes[index % 2]!.id,
              kind: 'diag.nvml',
              payload: undefined,
              idempotencyKey: `batch-${index}`,
              notAfter: clock.now() + 1_000,
            }),
          )
        ).id,
      );
    await advance(1_000);
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(5);
    expect(
      (await workRows(database, 'node')).map((row) => [row.key, Number(row.gen)]).sort(),
    ).toEqual([
      ['node_a', 1],
      ['node_b', 1],
    ]);
    const { rows } = await database.query<{
      payload: { subject: string; data: { state: string } };
    }>("SELECT payload FROM outbox WHERE topic = 'command.settled' ORDER BY seq");
    expect(rows.map((row) => row.payload.subject)).toEqual(
      [...ids].sort().map((id) => `command/${id}`),
    );
    expect(new Set(rows.map((row) => row.payload.data.state))).toEqual(new Set(['expired']));
  });
});
