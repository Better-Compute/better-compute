import { afterEach, describe, expect, it } from 'vitest';
import { defineSink, isComputeError, type ComputeEvent } from '@better-compute/core';
import { eventPattern } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { sibling } from './support/runtime.js';

// Events through the outbox (PLAN.md §8.4, §9.3): publish in the caller's transaction, read in
// (txid, seq) order below the snapshot's xmin, OutboxDispatch to sinks (at least once, one lease),
// and compute.events.subscribe in every process. PGlite has one connection, so this covers the
// single-connection subset: commit order equals txid order here.

afterEach(closeFixtures);

function collectingSink(id: string, fail: { times: number } = { times: 0 }) {
  const delivered: ComputeEvent[][] = [];
  const sink = defineSink({
    kind: 'events',
    id,
    async deliver(events) {
      if (fail.times > 0) {
        fail.times -= 1;
        throw new Error('webhook endpoint down');
      }
      delivered.push([...events]);
    },
  });
  return { sink, delivered };
}

const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {} });

describe('EventPublisher', () => {
  it('writes { id, type, tenantId, subject, data, time } with topic = type, in the transaction', async () => {
    const fixture = await computeFixture();
    const { compute, database } = fixture;
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publish(tx, {
        type: 'reservation.placed',
        tenantId: fixture.tenants.acme.id,
        subject: 'reservation/rsv_1',
        data: { gpus: 4 },
      }),
    );
    await expect(
      database.transaction(async (tx) => {
        await compute.context.events.publish(tx, {
          type: 'reservation.failed',
          tenantId: fixture.tenants.acme.id,
          subject: 'reservation/rsv_2',
          data: null,
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const { rows } = await database.query<{ topic: string; payload: Record<string, unknown> }>(
      'SELECT topic, payload FROM outbox ORDER BY seq',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.topic).toBe('reservation.placed');
    expect(rows[0]!.payload).toMatchObject({
      type: 'reservation.placed',
      tenantId: fixture.tenants.acme.id,
      subject: 'reservation/rsv_1',
      data: { gpus: 4 },
    });
    expect(String(rows[0]!.payload.id)).toMatch(/^evt_/);
    expect(new Date(String(rows[0]!.payload.time)).getTime()).toBe(fixture.clock.now());
  });

  it('refuses malformed events', async () => {
    const fixture = await computeFixture();
    const { events } = fixture.compute.context;
    const base = { type: 'node.connected', tenantId: 't', subject: 'node/n', data: null };
    for (const event of [
      { ...base, type: 'noDot' },
      { ...base, tenantId: '' },
      { ...base, subject: '' },
      { ...base, data: { big: 'x'.repeat(70_000) } },
      { ...base, data: { n: 10n } as never },
    ])
      await expect(events.publish(fixture.database, event)).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
  });
});

describe('OutboxDispatch', () => {
  it('delivers every committed event to each sink once, in (txid, seq) order', async () => {
    const fixture = await computeFixture();
    const first = collectingSink('first');
    const second = collectingSink('second');
    const compute = await sibling(fixture, { sinks: { events: [first.sink, second.sink] } });
    const publish = (...types: string[]) =>
      compute.context.sql.transaction(async (tx) => {
        for (const type of types)
          await compute.context.events.publish(tx, {
            type,
            tenantId: fixture.tenants.acme.id,
            subject: 'node/n1',
            data: { type },
          });
      });
    await publish('node.a', 'node.b');
    await publish('node.c');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(6); // 3 events × 2 sinks
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(0);
    await publish('node.d');
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(2);

    for (const { delivered } of [first, second]) {
      const events = delivered.flat();
      expect(events.map((event) => event.type)).toEqual(['node.a', 'node.b', 'node.c', 'node.d']);
      expect(new Set(events.map((event) => event.id)).size).toBe(4);
      // `sequence` is the (txid, seq) cursor and increases.
      const cursors = events.map((event) => event.sequence.split(':').map(BigInt));
      for (let index = 1; index < cursors.length; index++) {
        const [pt, ps] = cursors[index - 1]!;
        const [t, s] = cursors[index]!;
        expect(t! > pt! || (t === pt && s! > ps!)).toBe(true);
      }
      expect(events[0]!.time).toBe(new Date(fixture.clock.now()).toISOString());
    }
  });

  it('backs a failing sink off without holding the others back, then catches it up', async () => {
    const fixture = await computeFixture();
    const flaky = collectingSink('flaky', { times: 2 });
    const steady = collectingSink('steady');
    const compute = await sibling(fixture, {
      sinks: { events: [flaky.sink, steady.sink] },
      log: quiet(),
    });
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publish(tx, {
        type: 'node.connected',
        tenantId: fixture.tenants.acme.id,
        subject: 'node/n1',
        data: null,
      }),
    );
    const tick = () => compute.jobs['outbox-dispatch']!.tick();
    expect(await tick()).toBe(1); // steady only; flaky fails (retry in 1 s)
    expect(await tick()).toBe(0); // flaky still backing off
    await fixture.advance(1_000);
    expect(await tick()).toBe(0); // flaky fails again (retry in 2 s)
    await fixture.advance(2_000);
    expect(await tick()).toBe(1);
    expect(flaky.delivered.flat().map((event) => event.type)).toEqual(['node.connected']);
    expect(steady.delivered.flat()).toHaveLength(1);
  });

  it('delivers only while holding its singleton lease', async () => {
    const fixture = await computeFixture();
    const sink = collectingSink('only');
    const compute = await sibling(fixture, { sinks: { events: [sink.sink] } });
    await fixture.database.query(
      `INSERT INTO leases (name, owner, epoch, expires_at)
       VALUES ('singleton:outbox-dispatch', 'another-worker', 1, compute_now() + interval '1 minute')`,
    );
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publish(tx, {
        type: 'node.x',
        tenantId: 't',
        subject: 's',
        data: null,
      }),
    );
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBe(0);
    expect(sink.delivered).toEqual([]);
  });
});

describe('compute.events.subscribe', () => {
  it('delivers committed events matching the pattern to in-process subscribers', async () => {
    const fixture = await computeFixture({ log: quiet() });
    const { compute } = fixture;
    const publish = (type: string) =>
      compute.context.sql.transaction((tx) =>
        compute.context.events.publish(tx, { type, tenantId: 't', subject: 's', data: null }),
      );
    await publish('reservation.placed'); // before anyone subscribed: not delivered
    const reservations: string[] = [];
    const everything: string[] = [];
    const stop = compute.events.subscribe(
      'reservation.*',
      (event) => void reservations.push(event.type),
    );
    compute.events.subscribe('*', (event) => {
      everything.push(event.type);
      throw new Error('a broken subscriber is isolated');
    });
    await publish('reservation.active');
    await publish('node.connected');
    expect(await compute.jobs['event-subscribers']!.tick()).toBe(2);
    expect(reservations).toEqual(['reservation.active']);
    expect(everything).toEqual(['reservation.active', 'node.connected']);

    stop();
    await publish('reservation.released');
    await compute.jobs['event-subscribers']!.tick();
    expect(reservations).toEqual(['reservation.active']);
    expect(everything).toEqual(['reservation.active', 'node.connected', 'reservation.released']);
  });

  it('matches types with * wildcards', () => {
    expect(eventPattern('node.*')('node.connected')).toBe(true);
    expect(eventPattern('node.*')('nodes.connected')).toBe(false);
    expect(eventPattern('*.failed')('reservation.failed')).toBe(true);
    expect(eventPattern('node.connected')('node.connected')).toBe(true);
    expect(eventPattern('*')('anything.at.all')).toBe(true);
    expect(() => eventPattern('')).toThrow();
  });
});
