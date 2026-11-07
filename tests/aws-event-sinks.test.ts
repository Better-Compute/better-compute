import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, type ComputeEvent, type EventSink } from '@better-compute/core';
import {
  chunkBy,
  eventBridgeSink,
  firehoseAuditSink,
  firehoseSink,
  kinesisSink,
  snsSink,
  sqsSink,
} from '@better-compute/aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';
import { eventBridgeFake, firehoseFake, kinesisFake, snsFake, sqsFake } from './support/aws-platform-emulator/messaging.js';
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

describe('malformed batch responses', () => {
  it('a response that accounts for fewer entries than were sent throws (never a silent drop)', async () => {
    for (const name of ['SNS', 'SQS', 'EventBridge']) {
      const emu = new AwsEmulator();
      const world = cases.find((c) => c.name === name)!.make(emu);
      // Replace the fake with one that answers success but lists nothing.
      const service = name === 'SNS' ? 'sns' : name === 'SQS' ? 'sqs' : 'events';
      emu.register(service, {
        protocol: name === 'SNS' ? 'query' : 'json',
        handle: () =>
          name === 'SNS'
            ? new Response('<PublishBatchResponse><PublishBatchResult><Successful></Successful><Failed></Failed></PublishBatchResult></PublishBatchResponse>', { status: 200 })
            : new Response(JSON.stringify(name === 'SQS' ? { Successful: [], Failed: [] } : { FailedEntryCount: 0, Entries: [] }), { status: 200 }),
      });
      await expect(world.sink.deliver([event(1), event(2)])).rejects.toBeInstanceOf(ComputeError);
    }
  });
});

describe('sink configuration', () => {
  it('refuses malformed targets', () => {
    const emu = new AwsEmulator();
    expect(() => snsSink({ ...base(emu), topicArn: 'arn:aws:sqs:us-east-1:111111111111:x' })).toThrow(ComputeError);
    expect(() => sqsSink({ ...base(emu), queueUrl: 'https://sqs.us-east-1.amazonaws.com/x/../y' })).toThrow(ComputeError);
    expect(() => eventBridgeSink({ ...base(emu), source: 'bad source' })).toThrow(ComputeError);
    // PutEvents refuses every entry whose Source starts with 'aws.' (review): a config error now.
    for (const source of ['aws.ec2', 'AWS.custom', 'aws.'])
      expect(() => eventBridgeSink({ ...base(emu), source })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => eventBridgeSink({ ...base(emu), source: 'awsome.app' })).not.toThrow();
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

describe('Kinesis and Firehose', () => {
  it('kinesis partitions by tenant', async () => {
    const emu = new AwsEmulator();
    const fake = kinesisFake(emu);
    const sink = kinesisSink({ ...base(emu), streamName: 'bc-events' });
    const events = Array.from({ length: 501 }, (_, n) => event(n));
    await sink.deliver(events);
    expect(fake.batches).toEqual([500, 1]);
    expect(fake.records[0]).toEqual({ data: `${JSON.stringify(events[0])}\n`, partitionKey: 'globex', stream: 'bc-events' });
    expect(fake.records[1]!.partitionKey).toBe('acme');
    const bySubject = kinesisSink({ ...base(emu), streamArn: 'arn:aws:kinesis:us-east-1:111111111111:stream/bc', partitionKey: 'subject' });
    await bySubject.deliver([event(3)]);
    expect(fake.records.at(-1)).toMatchObject({ partitionKey: 'instance/ins_3', stream: 'arn:aws:kinesis:us-east-1:111111111111:stream/bc' });
    expect(() => kinesisSink({ ...base(emu) })).toThrow(ComputeError);
  });

  it('firehose records are newline-terminated', async () => {
    const emu = new AwsEmulator();
    const fake = firehoseFake(emu);
    await firehoseSink({ ...base(emu), deliveryStreamName: 'bc-events' }).deliver([event(1), event(2)]);
    expect(fake.records.map((record) => record.data)).toEqual([`${JSON.stringify(event(1))}\n`, `${JSON.stringify(event(2))}\n`]);
  });

  it.each(['kinesis', 'firehose'] as const)('throws on a partially failed batch (%s)', async (which) => {
    const emu = new AwsEmulator();
    const fake = which === 'kinesis' ? kinesisFake(emu) : firehoseFake(emu);
    fake.refuse = (record) => (Buffer.from(String(record.Data), 'base64').toString().includes('evt_0002') ? 'InternalFailure' : undefined);
    const sink = which === 'kinesis' ? kinesisSink({ ...base(emu), streamName: 's' }) : firehoseSink({ ...base(emu), deliveryStreamName: 's' });
    const error = (await sink.deliver([event(1), event(2), event(3)]).catch((e: unknown) => e)) as ComputeError;
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details?.failed).toEqual(['evt_0002']);
    fake.refuse = () => 'ProvisionedThroughputExceededException';
    await expect(sink.deliver([event(4)])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    fake.refuse = () => undefined;
    const big = event(9, { data: { blob: 'x'.repeat(1024 * 1024) } });
    await expect(sink.deliver([big])).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { eventId: big.id } });
  });

  it.each(['kinesis', 'firehose'] as const)('a record over the per-record limit fails alone before any request (%s, review)', async (which) => {
    const emu = new AwsEmulator();
    const fake = which === 'kinesis' ? kinesisFake(emu) : firehoseFake(emu);
    const sink = which === 'kinesis' ? kinesisSink({ ...base(emu), streamName: 's' }) : firehoseSink({ ...base(emu), deliveryStreamName: 's' });
    // Firehose's limit is 1000 KiB per record; Kinesis's is 1 MiB including the partition key.
    const limit = which === 'kinesis' ? 1024 * 1024 : 1000 * 1024;
    const sized = (n: number, bytes: number) => {
      const empty = event(n, { tenantId: 'acme', data: { blob: '' } });
      const overhead = Buffer.byteLength(`${JSON.stringify(empty)}
`) + (which === 'kinesis' ? Buffer.byteLength('acme') : 0);
      return event(n, { tenantId: 'acme', data: { blob: 'x'.repeat(bytes - overhead) } });
    };
    const over = sized(9, limit + 1);
    const error = (await sink.deliver([event(1), over, event(2)]).catch((e: unknown) => e)) as ComputeError;
    expect(error).toBeInstanceOf(ComputeError);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details).toMatchObject({ eventId: over.id, limit });
    expect(emu.requests).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
    // Exactly at the limit goes through.
    await sink.deliver([sized(10, limit)]);
    expect(fake.records).toHaveLength(1);
  });

  it('audit records go through firehoseAuditSink', async () => {
    const emu = new AwsEmulator();
    const fake = firehoseFake(emu);
    const sink = firehoseAuditSink({ ...base(emu), deliveryStreamName: 'bc-audit' });
    expect(sink).toMatchObject({ extension: 'sink', kind: 'audit', id: 'aws-firehose-audit' });
    const record = { id: 'aud_1', tenantId: 'acme', time: 1, action: 'instances.delete', resource: { type: 'instance', id: 'ins_1' } };
    await sink.write([record]);
    expect(fake.records).toEqual([{ data: `${JSON.stringify(record)}\n`, stream: 'bc-audit' }]);
    expect(() => firehoseAuditSink({ ...base(emu), deliveryStreamName: 'bad name' })).toThrow(ComputeError);
  });
});
