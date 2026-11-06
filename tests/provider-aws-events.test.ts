import { describe, expect, it } from 'vitest';
import type { CallContext, Logger } from '@better-compute/core';
import {
  awsConfig,
  awsProvider,
  mapEventBridgeEnvelope,
  validateAwsConfig,
  type AwsCompute,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { SqsEmulator } from './support/aws-emulator/event-queue.js';

// AWS A4 event intake (AD12): EventBridge → SQS → `pollEvents`. Every envelope is authenticated by
// AWS account id, region and a source allow-list; the rest is dropped (and still deleted on ack, so
// a forged message never loops). Messages are deleted only when vps calls `ack()`.

const queueName = 'bc-events';
const queueUrl = `https://sqs.us-east-1.amazonaws.com/${platformAccount}/${queueName}`;
const T = Date.UTC(2026, 9, 1, 12);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function envelope(
  detailType: string,
  detail: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: '0',
    id: `evt-${Math.random().toString(16).slice(2, 10)}`,
    'detail-type': detailType,
    source: 'aws.ec2',
    account: platformAccount,
    time: iso(T),
    region: 'us-east-1',
    resources: [],
    detail,
    ...extra,
  };
}

async function world(overrides: Record<string, unknown> = { eventQueueUrl: queueUrl }) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const sqs = new SqsEmulator(emu);
  const queue = sqs.createQueue(platformAccount, queueName);
  const records: string[] = [];
  const log: Logger = {
    debug: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
  };
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const config = awsConfig.parse({
    region: 'us-east-1',
    zones: ['us-east-1a'],
    ...overrides,
  }) as AwsConfig;
  const impl = (await provider.create(config, {
    clock: emu.clock,
    log,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  })) as AwsCompute;
  const call = (): CallContext => ({
    idempotencyKey: 'events:pa_platform',
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log,
  });
  const poll = (options = { waitMs: 10_000, max: 10 }) => impl.pollEvents!(call(), options);
  return { emu, ec2, sqs, queue, impl, poll, records, config };
}

describe('provider-aws event intake', () => {
  it('maps EventBridge detail types', async () => {
    const { sqs, queue, poll } = await world();
    sqs.send(queue, envelope('EC2 Instance State-change Notification', { 'instance-id': 'i-0abc12345678def01', state: 'stopping' }, { id: 'e-state' }));
    sqs.send(queue, envelope('EC2 Spot Instance Interruption Warning', { 'instance-id': 'i-0abc12345678def02', 'instance-action': 'terminate' }, { id: 'e-spot' }));
    sqs.send(queue, envelope('EC2 Instance Rebalance Recommendation', { 'instance-id': 'i-0abc12345678def03' }, { id: 'e-rebal' }));
    sqs.send(
      queue,
      envelope(
        'AWS Health Event',
        {
          service: 'EC2',
          eventTypeCode: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED',
          eventTypeCategory: 'scheduledChange',
          statusCode: 'upcoming',
          startTime: 'Sat, 03 Oct 2026 06:00:00 GMT',
          affectedEntities: [{ entityValue: 'i-0abc12345678def04' }, { entityValue: 'i-0abc12345678def05' }],
        },
        { id: 'e-health', source: 'aws.health' },
      ),
    );
    sqs.send(
      queue,
      envelope('EC2 Capacity Reservation Instance Usage Alert', { 'capacity-reservation-id': 'cr-0123456789abcdef0' }, { id: 'e-cr' }),
    );
    sqs.send(
      queue,
      envelope(
        'AWS API Call via CloudTrail',
        {
          eventSource: 'ec2.amazonaws.com',
          eventName: 'TerminateInstances',
          requestParameters: { instancesSet: { items: [{ instanceId: 'i-0abc12345678def06' }] } },
        },
        { id: 'e-trail' },
      ),
    );
    const first = await poll();
    const second = await poll();
    const events = [...first.events, ...second.events];
    expect(events).toEqual([
      { id: 'e-state', kind: 'machine-changed', machineId: 'i-0abc12345678def01', at: T, details: { state: 'stopping' } },
      {
        id: 'e-spot',
        kind: 'interruption-warning',
        machineId: 'i-0abc12345678def02',
        at: T,
        deadline: T + 120_000,
        details: { action: 'terminate' },
      },
      { id: 'e-rebal', kind: 'rebalance-recommended', machineId: 'i-0abc12345678def03', at: T },
      {
        id: 'e-health/i-0abc12345678def04',
        kind: 'maintenance-scheduled',
        machineId: 'i-0abc12345678def04',
        at: T,
        deadline: Date.UTC(2026, 9, 3, 6),
        details: { code: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED', status: 'upcoming' },
      },
      {
        id: 'e-health/i-0abc12345678def05',
        kind: 'maintenance-scheduled',
        machineId: 'i-0abc12345678def05',
        at: T,
        deadline: Date.UTC(2026, 9, 3, 6),
        details: { code: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED', status: 'upcoming' },
      },
      { id: 'e-cr', kind: 'reservation-changed', reservationId: 'cr-0123456789abcdef0', at: T },
      {
        id: 'e-trail/i-0abc12345678def06',
        kind: 'api-call',
        machineId: 'i-0abc12345678def06',
        at: T,
        details: { eventName: 'TerminateInstances' },
      },
    ]);
  });

  it('drops an event from a foreign account', async () => {
    const { sqs, queue, poll, records } = await world();
    sqs.send(
      queue,
      envelope(
        'EC2 Spot Instance Interruption Warning',
        { 'instance-id': 'i-0abc12345678def02', 'instance-action': 'terminate', secret: 'leak-me' },
        { account: '999999999999' },
      ),
    );
    sqs.send(queue, envelope('EC2 Instance State-change Notification', { 'instance-id': 'i-0abc12345678def01', state: 'running' }, { region: 'eu-west-1' }));
    const batch = await poll();
    expect(batch.events).toEqual([]);
    // Dropped messages are deleted with the batch, so a forged one never comes back.
    await batch.ack();
    expect(queue.messages).toEqual([]);
    expect(records.join('\n')).not.toContain('leak-me');
    expect(records.join('\n')).toContain('"foreignAccount":1');
  });

  it('drops an unknown source', async () => {
    const { sqs, queue, poll } = await world();
    sqs.send(queue, envelope('Object Created', { bucket: { name: 'b' } }, { source: 'aws.s3' }));
    sqs.send(queue, envelope('EC2 Instance State-change Notification', { 'instance-id': 'i-0abc12345678def01', state: 'running' }, { source: 'custom.forged' }));
    sqs.send(queue, envelope('GuardDuty Finding', { type: 'x', severity: 8, resource: { instanceDetails: { instanceId: 'i-0abc12345678def01' } } }, { source: 'aws.guardduty' }));
    sqs.send(queue, 'not json at all');
    sqs.send(queue, envelope('EC2 Something New', { 'instance-id': 'i-0abc12345678def01' }));
    const batch = await poll();
    expect(batch.events).toEqual([]);
    await batch.ack();
    expect(queue.messages).toEqual([]);
  });

  it('maps GuardDuty findings to health events when that source is allowed', async () => {
    const { sqs, queue, poll } = await world({ eventQueueUrl: queueUrl, eventSources: ['aws.ec2', 'aws.guardduty'] });
    sqs.send(
      queue,
      envelope(
        'GuardDuty Finding',
        { type: 'CryptoCurrency:EC2/BitcoinTool.B', severity: 8, resource: { instanceDetails: { instanceId: 'i-0abc12345678def01' } } },
        { id: 'e-gd', source: 'aws.guardduty' },
      ),
    );
    expect((await poll()).events).toEqual([
      {
        id: 'e-gd',
        kind: 'health',
        machineId: 'i-0abc12345678def01',
        at: T,
        details: { source: 'aws.guardduty', type: 'CryptoCurrency:EC2/BitcoinTool.B', severity: '8' },
      },
    ]);
  });

  it('acks only after ack()', async () => {
    const { emu, sqs, queue, poll } = await world();
    sqs.send(queue, envelope('EC2 Instance State-change Notification', { 'instance-id': 'i-0abc12345678def01', state: 'running' }, { id: 'e-1' }));
    const batch = await poll({ waitMs: 4_000, max: 50 });
    expect(batch.events.map((event) => event.id)).toEqual(['e-1']);
    const receive = JSON.parse(emu.calls('ReceiveMessage').at(-1)!.body);
    expect(receive).toMatchObject({ QueueUrl: queueUrl, WaitTimeSeconds: 4, MaxNumberOfMessages: 10 });
    expect(emu.calls('DeleteMessageBatch')).toHaveLength(0);
    expect(queue.messages).toHaveLength(1);
    // Not acked: after the visibility timeout the same event comes again.
    emu.clock.advance(31_000);
    const again = await poll();
    expect(again.events.map((event) => event.id)).toEqual(['e-1']);
    await again.ack();
    expect(emu.calls('DeleteMessageBatch')).toHaveLength(1);
    expect(queue.messages).toEqual([]);
    // The first batch's receipt is stale now: acking it again fails softly.
    await expect(batch.ack()).resolves.toBeUndefined();
  });

  it('caps the long poll at 10 s and refuses a queue in another account', async () => {
    const { emu, poll } = await world();
    await poll({ waitMs: 60_000, max: 3 });
    expect(JSON.parse(emu.calls('ReceiveMessage').at(-1)!.body)).toMatchObject({
      WaitTimeSeconds: 10,
      MaxNumberOfMessages: 3,
    });
    const foreign = await world({
      eventQueueUrl: `https://sqs.us-east-1.amazonaws.com/222222222222/${queueName}`,
    });
    await expect(foreign.poll()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(foreign.emu.calls('ReceiveMessage')).toHaveLength(0);
  });

  it('validates eventQueueUrl', () => {
    const base = awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig;
    for (const eventQueueUrl of [
      'https://sqs.eu-west-1.amazonaws.com/111111111111/q',
      'https://evil.example/111111111111/q',
      'http://sqs.us-east-1.amazonaws.com/111111111111/q',
      'https://sqs.us-east-1.amazonaws.com/1111/q',
      'https://sqs.us-east-1.amazonaws.com/111111111111/q/extra',
      'https://sqs.us-east-1.amazonaws.com@evil.example/111111111111/q',
    ])
      expect(() => validateAwsConfig({ ...base, eventQueueUrl }), eventQueueUrl).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() =>
      validateAwsConfig({ ...base, eventQueueUrl: 'https://sqs.us-east-1.amazonaws.com/111111111111/bc-events.fifo' }),
    ).not.toThrow();
  });

  it('mapEventBridgeEnvelope is pure and refuses malformed instance ids', () => {
    const filter = { account: platformAccount, region: 'us-east-1', sources: new Set(['aws.ec2']) };
    expect(
      mapEventBridgeEnvelope(
        envelope('EC2 Instance State-change Notification', { 'instance-id': 'i-../../x', state: 'running' }),
        filter,
      ),
    ).toEqual({ dropped: 'malformed' });
    expect(mapEventBridgeEnvelope({ id: 1 }, filter)).toEqual({ dropped: 'malformed' });
  });

  it('without a queue, reads scheduled events with DescribeInstanceStatus every 5 minutes', async () => {
    const { emu, ec2, poll } = await world({});
    const vm = ec2.addInstance({ id: 'i-0abc12345678def01' });
    ec2.addInstance({ id: 'i-0abc12345678def02' });
    const notBefore = emu.now() + 3 * 86_400_000;
    ec2.scheduledEvents.set(vm.id, [
      { id: 'instance-event-0123456789abcdef0', code: 'system-reboot', description: 'scheduled reboot', notBefore },
    ]);
    const first = await poll();
    expect(first.events).toEqual([
      {
        id: 'status/i-0abc12345678def01/instance-event-0123456789abcdef0/scheduled',
        kind: 'maintenance-scheduled',
        machineId: vm.id,
        at: emu.now(),
        deadline: notBefore,
        details: { code: 'system-reboot', status: 'scheduled' },
      },
    ]);
    const scan = emu.calls('DescribeInstanceStatus').at(-1)!.params;
    expect(scan.get('Filter.1.Name')).toBe('event.code');
    expect(emu.calls('ReceiveMessage')).toHaveLength(0);
    await first.ack();
    // Within 5 minutes nothing is read again.
    emu.clock.advance(60_000);
    expect((await poll()).events).toEqual([]);
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(1);
    // A completed event is a new id (its status changed), so vps sees it.
    ec2.scheduledEvents.set(vm.id, [
      {
        id: 'instance-event-0123456789abcdef0',
        code: 'system-reboot',
        description: '[Completed] scheduled reboot',
        notBefore,
      },
    ]);
    emu.clock.advance(5 * 60_000);
    expect((await poll()).events).toMatchObject([
      {
        id: 'status/i-0abc12345678def01/instance-event-0123456789abcdef0/completed',
        details: { status: 'completed' },
      },
    ]);
  });

  it('a failed DescribeInstanceStatus scan is retried on the next poll', async () => {
    const { emu, ec2, poll } = await world({});
    ec2.addInstance({ id: 'i-0abc12345678def01' });
    emu.failNext('DescribeInstanceStatus', 'RequestLimitExceeded', 503);
    await expect(poll()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(poll()).resolves.toMatchObject({ events: [] });
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(2);
  });
});
