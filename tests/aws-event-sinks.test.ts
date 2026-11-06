import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, type ComputeEvent, type EventSink } from '@better-compute/core';
import { chunkBy, eventBridgeSink, snsSink, sqsSink } from '@better-compute/aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';
import { eventBridgeFake, snsFake, sqsFake } from './support/aws-platform-emulator/messaging.js';
import { sibling } from './support/runtime.js';

describe('chunkBy', () => {
  it('chunkBy respects count and byte limits and keeps order', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunkBy(items, { maxCount: 3, maxBytes: 100, size: () => 1 })).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunkBy(items, { maxCount: 10, maxBytes: 10, size: (n) => n })).toEqual([[1, 2, 3, 4], [5], [6], [7]]);
  });

  it('an item over maxBytes is its own chunk', () => {
    expect(chunkBy([1, 50, 2], { maxCount: 10, maxBytes: 10, size: (n) => n })).toEqual([[1], [50], [2]]);
    expect(chunkBy([], { maxCount: 10, maxBytes: 10, size: () => 1 })).toEqual([]);
  });
});

function event(n: number, extra: Partial<ComputeEvent> = {}): ComputeEvent {
  return {
    id: `evt_${String(n).padStart(4, '0')}`,
    type: 'instance.running',
    tenantId: n % 2 ? 'acme' : 'globex',
    subject: `instance/ins_${n}`,
    time: new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString(),
    sequence: String(n),
    data: { n },
    ...extra,
  };
}

/** One shape over the three sinks: what each delivered (event ids in order) and FIFO fields. */
interface SinkCase {
  name: string;
  make(emu: AwsEmulator, fifo?: boolean): {
    sink: EventSink;
    delivered(): { eventId: string; groupId?: string; dedupeId?: string; attributes: Record<string, string> }[];
    batches(): number[];
    refuse(fn: (eventId: string) => string | undefined): void;
  };
}

const base = (emu: AwsEmulator) => ({
  region: 'us-east-1',
  credentials: emu.credentials,
  fetch: emu.fetch,
  endpoint: 'http://emu.local',
  clock: emu.clock,
});

const cases: SinkCase[] = [
  {
    name: 'EventBridge',
    make(emu) {
      const fake = eventBridgeFake(emu);
      return {
        sink: eventBridgeSink({ ...base(emu), eventBusName: 'bc-bus' }),
        delivered: () =>
          fake.entries.map((entry) => ({
            eventId: (JSON.parse(String(entry.Detail)) as ComputeEvent).id,
            attributes: { type: String(entry.DetailType), source: String(entry.Source), bus: String(entry.EventBusName) },
          })),
        batches: () => fake.batches,
        refuse: (fn) => (fake.refuse = (entry) => fn((JSON.parse(String(entry.Detail)) as ComputeEvent).id)),
      };
    },
  },
  {
    name: 'SNS',
    make(emu, fifo) {
      const fake = snsFake(emu);
      const attributes = (entry: Record<string, string>) => {
        const out: Record<string, string> = {};
        for (let n = 1; entry[`MessageAttributes.entry.${n}.Name`]; n++)
          out[entry[`MessageAttributes.entry.${n}.Name`]!] = entry[`MessageAttributes.entry.${n}.Value.StringValue`]!;
        return out;
      };
      return {
        sink: snsSink({ ...base(emu), topicArn: `arn:aws:sns:us-east-1:111111111111:bc-events${fifo ? '.fifo' : ''}` }),
        delivered: () =>
          fake.messages.map((entry) => ({
            eventId: (JSON.parse(entry.Message!) as ComputeEvent).id,
            groupId: entry.MessageGroupId,
            dedupeId: entry.MessageDeduplicationId,
            attributes: attributes(entry),
          })),
        batches: () => fake.batches,
        refuse: (fn) => (fake.refuse = (entry) => fn((JSON.parse(String(entry.Message)) as ComputeEvent).id)),
      };
    },
  },
  {
    name: 'SQS',
    make(emu, fifo) {
      const fake = sqsFake(emu);
      return {
        sink: sqsSink({ ...base(emu), queueUrl: `https://sqs.us-east-1.amazonaws.com/111111111111/bc-events${fifo ? '.fifo' : ''}` }),
        delivered: () =>
          fake.messages.map((entry) => ({
            eventId: (JSON.parse(String(entry.MessageBody)) as ComputeEvent).id,
            groupId: entry.MessageGroupId as string | undefined,
            dedupeId: entry.MessageDeduplicationId as string | undefined,
            attributes: Object.fromEntries(
              Object.entries(entry.MessageAttributes as Record<string, { StringValue: string }>).map(([k, v]) => [k, v.StringValue]),
            ),
          })),
        batches: () => fake.batches,
        refuse: (fn) => (fake.refuse = (entry) => fn((JSON.parse(String(entry.MessageBody)) as ComputeEvent).id)),
      };
    },
  },
];

describe.each(cases)('$name sink', (sinkCase) => {
  it('delivers events in batches of at most 10', async () => {
    const emu = new AwsEmulator();
    const world = sinkCase.make(emu);
    const events = Array.from({ length: 23 }, (_, n) => event(n));
    await world.sink.deliver(events);
    expect(world.batches()).toEqual([10, 10, 3]);
    expect(world.delivered().map((entry) => entry.eventId)).toEqual(events.map((e) => e.id));
    await world.sink.deliver([]);
    expect(world.batches()).toHaveLength(3);
  });

  it('throws on a partially failed batch so the dispatcher retries', async () => {
    const emu = new AwsEmulator();
    const world = sinkCase.make(emu);
    world.refuse((id) => (id === 'evt_0003' || id === 'evt_0014' ? 'InternalFailure' : undefined));
    const events = Array.from({ length: 15 }, (_, n) => event(n));
    const error = (await world.sink.deliver(events).catch((e: unknown) => e)) as ComputeError;
    expect(error).toBeInstanceOf(ComputeError);
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details?.failed).toEqual(['evt_0003', 'evt_0014']);
    // Every chunk was attempted: the rest got through (at least once).
    expect(world.delivered()).toHaveLength(13);
    world.refuse(() => 'ThrottlingException');
    await expect(world.sink.deliver([event(99)])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('an oversized event fails alone with PAYLOAD_TOO_LARGE', async () => {
    const emu = new AwsEmulator();
    const world = sinkCase.make(emu);
    const big = event(7, { data: { blob: 'x'.repeat(256 * 1024) } });
    const error = (await world.sink.deliver([event(1), big, event(2)]).catch((e: unknown) => e)) as ComputeError;
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details?.eventId).toBe(big.id);
    expect(world.batches()).toEqual([]);
    // Near the limit (but under it) still goes, alone if need be.
    const near = (n: number) => event(n, { data: { blob: 'x'.repeat(200 * 1024) } });
    await world.sink.deliver([event(1), near(8), near(9), event(2)]);
    expect(world.batches()).toEqual([2, 2]);
  });

  it('entries carry the event id for consumer dedupe', async () => {
    const emu = new AwsEmulator();
    const world = sinkCase.make(emu);
    await world.sink.deliver([event(1)]);
    const [entry] = world.delivered();
    expect(entry!.eventId).toBe('evt_0001');
    if (sinkCase.name === 'EventBridge') expect(entry!.attributes).toEqual({ type: 'instance.running', source: 'better-compute', bus: 'bc-bus' });
    else expect(entry!.attributes).toEqual({ type: 'instance.running', tenantId: 'acme', eventId: 'evt_0001' });
  });

  it.skipIf(sinkCase.name === 'EventBridge')('FIFO targets get group and dedupe ids', async () => {
    const emu = new AwsEmulator();
    const world = sinkCase.make(emu, true);
    await world.sink.deliver([event(1), event(2)]);
    expect(world.delivered().map(({ groupId, dedupeId }) => ({ groupId, dedupeId }))).toEqual([
      { groupId: 'acme', dedupeId: 'evt_0001' },
      { groupId: 'globex', dedupeId: 'evt_0002' },
    ]);
    const standard = sinkCase.make(new AwsEmulator(), false);
    await standard.sink.deliver([event(1)]);
    expect(standard.delivered()[0]!.groupId).toBeUndefined();
  });
});

describe('sink configuration', () => {
  it('refuses malformed targets', () => {
    const emu = new AwsEmulator();
    expect(() => snsSink({ ...base(emu), topicArn: 'arn:aws:sqs:us-east-1:111111111111:x' })).toThrow(ComputeError);
    expect(() => sqsSink({ ...base(emu), queueUrl: 'https://sqs.us-east-1.amazonaws.com/x/../y' })).toThrow(ComputeError);
    expect(() => eventBridgeSink({ ...base(emu), source: 'bad source' })).toThrow(ComputeError);
  });
});

describe('dispatch', () => {
  afterEach(closeFixtures);

  // The outbox caps events at 64 KiB, so an event over EventBridge's 256 KiB cannot reach a sink
  // through it; the poison here is an entry EventBridge refuses every time.
  it('works under createSinkDispatch: a poisoned event is dead-lettered, the other 24 delivered', async () => {
    const emu = new AwsEmulator();
    const fake = eventBridgeFake(emu);
    fake.refuse = (entry) => (entry.DetailType === 'node.poison' ? 'MalformedDetail' : undefined);
    const sink = eventBridgeSink({ ...base(emu), id: 'eventbridge' });
    const fixture = await computeFixture();
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const compute = await sibling(fixture, { sinks: { events: [sink] }, log: quiet });
    await compute.context.sql.transaction(async (tx) => {
      for (let n = 0; n < 25; n++)
        await compute.context.events.publish(tx, {
          type: n === 12 ? 'node.poison' : 'node.ok',
          tenantId: fixture.tenants.acme.id,
          subject: `node/n${n}`,
          data: { n },
        });
    });
    for (let pass = 0; pass < 60; pass++) {
      await fixture.advance(301_000);
      // Keep the emulator's clock with the fixture's so signatures stay fresh.
      emu.clock.set(Math.max(emu.clock.now(), fixture.clock.now()));
      await compute.jobs['outbox-dispatch']!.tick();
    }
    const delivered = fake.entries.map((entry) => JSON.parse(String(entry.Detail)) as ComputeEvent);
    // At least once: entries of a failed batch that got through are delivered again; ids dedupe.
    const ok = new Set(delivered.filter((e) => e.type === 'node.ok').map((e) => e.id));
    expect(ok.size).toBe(24);
    expect(delivered.some((e) => e.type === 'node.poison')).toBe(false);
    const { rows: present } = await fixture.database.query<{ present: boolean }>(
      `SELECT to_regclass('outbox_dead_letters') IS NOT NULL AS present`,
    );
    if (present[0]!.present) {
      const { rows } = await fixture.database.query<{ sink: string; event: { type: string }; error: string }>(
        'SELECT sink, event, error FROM outbox_dead_letters',
      );
      expect(rows).toEqual([{ sink: 'eventbridge', event: expect.objectContaining({ type: 'node.poison' }), error: expect.stringMatching(/MalformedDetail/) }]);
    }
  });
});
