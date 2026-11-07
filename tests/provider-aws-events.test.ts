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

  it('one Health message naming 150 instances is one received message and 150 events', async () => {
    const { sqs, queue, poll } = await world();
    const ids = Array.from({ length: 150 }, (_, index) => `i-0abc1234567${index.toString(16).padStart(6, '0')}`);
    sqs.send(
      queue,
      envelope(
        'AWS Health Event',
        {
          service: 'EC2',
          eventTypeCode: 'AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED',
          statusCode: 'upcoming',
          startTime: 'Sat, 03 Oct 2026 06:00:00 GMT',
          affectedEntities: ids.map((entityValue) => ({ entityValue })),
        },
        { id: 'e-many', source: 'aws.health' },
      ),
    );
    sqs.send(queue, { not: 'an envelope' } as never);
    const batch = await poll();
    expect(batch.received).toBe(2);
    expect(batch.events).toHaveLength(150);
    expect(batch.events.map((event) => event.machineId)).toEqual(ids);
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

  it('only scheduled-change Health events are maintenance; issues are health per instance', () => {
    const filter = { account: platformAccount, region: 'us-east-1', sources: new Set(['aws.health']) };
    const arn =
      'arn:aws:health:us-east-1::event/EC2/AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED/AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED_726c1732-d6f6-4037-b9b8-bec3c2d3ba65';
    const health = (detail: Record<string, unknown>) =>
      mapEventBridgeEnvelope(envelope('AWS Health Event', detail, { id: 'h-1', source: 'aws.health' }), filter);
    expect(
      health({
        service: 'EC2',
        eventArn: arn,
        eventTypeCode: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED',
        eventTypeCategory: 'scheduledChange',
        statusCode: 'open',
        affectedEntities: [{ entityValue: 'i-0abc12345678def01' }],
      }),
    ).toEqual({
      events: [
        {
          id: 'h-1/i-0abc12345678def01',
          kind: 'maintenance-scheduled',
          machineId: 'i-0abc12345678def01',
          at: T,
          details: {
            code: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED',
            status: 'open',
            // The ARN's unique tail (the whole ARN is longer than a fact may be).
            healthEvent: 'AWS_EC2_INSTANCE_REBOOT_MAINTENANCE_SCHEDULED_726c1732-d6f6-4037-b9b8-bec3c2d3ba65',
          },
        },
      ],
    });
    expect(
      health({
        service: 'EC2',
        eventTypeCode: 'AWS_EC2_INSTANCE_STORE_DRIVE_PERFORMANCE_DEGRADED',
        eventTypeCategory: 'issue',
        statusCode: 'open',
        affectedEntities: [{ entityValue: 'i-0abc12345678def01' }, { entityValue: 'i-0abc12345678def02' }],
      }),
    ).toEqual({
      events: ['i-0abc12345678def01', 'i-0abc12345678def02'].map((machineId) => ({
        id: `h-1/${machineId}`,
        kind: 'health',
        machineId,
        at: T,
        details: { service: 'EC2', code: 'AWS_EC2_INSTANCE_STORE_DRIVE_PERFORMANCE_DEGRADED', status: 'open', category: 'issue' },
      })),
    });
  });

  it('Capacity Reservation and Capacity Block notices are reservation changes', () => {
    // Detail types as the EC2 user guide documents them (capacity-blocks-monitor, cr-eventbridge).
    const filter = { account: platformAccount, region: 'us-east-1', sources: new Set(['aws.ec2', 'aws.health']) };
    const resources = [`arn:aws:ec2:us-east-1:${platformAccount}:capacity-reservation/cr-0123456789abcdef0`];
    for (const type of ['Capacity Block Delivered', 'Capacity Block Expiration Warning'])
      expect(
        mapEventBridgeEnvelope(
          envelope(type, { 'capacity-reservation-id': 'cr-0123456789abcdef0', 'end-date': '2026-10-02T11:30:00Z' }, { id: 'cb', resources }),
          filter,
        ),
        type,
      ).toEqual({ events: [{ id: 'cb', kind: 'reservation-changed', reservationId: 'cr-0123456789abcdef0', at: T }] });
    // A Capacity Block instance about to be terminated is an interruption.
    expect(
      mapEventBridgeEnvelope(
        envelope(
          'EC2 Capacity Reservation Instance Interruption Warning',
          {
            'instance-id': 'i-0abc12345678def01',
            'instance-action': 'terminate',
            'instance-termination-time': iso(T + 600_000),
            'instance-lifecycle': 'capacity-block',
          },
          { id: 'cbi' },
        ),
        filter,
      ),
    ).toEqual({
      events: [
        {
          id: 'cbi',
          kind: 'interruption-warning',
          machineId: 'i-0abc12345678def01',
          at: T,
          deadline: T + 600_000,
          details: { action: 'terminate', lifecycle: 'capacity-block' },
        },
      ],
    });
    // ODCR underutilization comes from AWS Health, naming the reservations (the summary with extra columns).
    expect(
      mapEventBridgeEnvelope(
        envelope(
          'AWS Health Event',
          {
            service: 'EC2',
            eventTypeCode: 'AWS_EC2_ODCR_UNDERUTILIZATION_NOTIFICATION_SUMMARY',
            eventTypeCategory: 'accountNotification',
            affectedEntities: [
              { entityValue: 'cr-01234567890abcdef | us-east-1b | t3.medium | Linux/UNIX | 0.0%' },
              { entityValue: 'cr-09876543210fedcba | us-east-1a | t3.medium | Linux/UNIX | 0.0%' },
            ],
          },
          { id: 'odcr', source: 'aws.health' },
        ),
        filter,
      ),
    ).toEqual({
      events: ['cr-01234567890abcdef', 'cr-09876543210fedcba'].map((reservationId) => ({
        id: `odcr/${reservationId}`,
        kind: 'reservation-changed',
        reservationId,
        at: T,
      })),
    });
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
    // No queue to drain: vps does not poll again for more.
    expect(first.received).toBe(0);
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

  it('a stopped instance still reports its completed instance-stop event', async () => {
    // instance-stop and instance-retirement stop the instance: without IncludeAllInstances EC2
    // lists running instances only, and the completion would never be seen.
    const { emu, ec2, poll } = await world({});
    const vm = ec2.addInstance({ id: 'i-0abc12345678def01' });
    const notBefore = emu.now() + 86_400_000;
    ec2.scheduledEvents.set(vm.id, [
      { id: 'instance-event-0123456789abcdef1', code: 'instance-stop', description: 'The instance is running on degraded hardware', notBefore },
    ]);
    expect((await poll()).events).toMatchObject([{ details: { code: 'instance-stop', status: 'scheduled' } }]);
    vm.state = 'stopped';
    ec2.scheduledEvents.set(vm.id, [
      { id: 'instance-event-0123456789abcdef1', code: 'instance-stop', description: '[Completed] The instance is running on degraded hardware', notBefore },
    ]);
    emu.clock.advance(5 * 60_000);
    expect((await poll()).events).toEqual([
      expect.objectContaining({
        id: 'status/i-0abc12345678def01/instance-event-0123456789abcdef1/completed',
        machineId: vm.id,
        details: { code: 'instance-stop', status: 'completed' },
      }),
    ]);
    expect(emu.calls('DescribeInstanceStatus').at(-1)!.params.get('IncludeAllInstances')).toBe('true');
  });

  it('a scheduled event that a complete scan no longer lists is completed', async () => {
    // EC2 rescheduled it under a new id, or it aged out: the old one is over either way.
    const { emu, ec2, poll } = await world({});
    const vm = ec2.addInstance({ id: 'i-0abc12345678def01' });
    const other = ec2.addInstance({ id: 'i-0abc12345678def02' });
    const notBefore = emu.now() + 86_400_000;
    ec2.scheduledEvents.set(vm.id, [
      { id: 'instance-event-0123456789abcdef2', code: 'system-reboot', description: 'reboot', notBefore },
    ]);
    ec2.scheduledEvents.set(other.id, [
      { id: 'instance-event-0123456789abcdef3', code: 'system-maintenance', description: 'maintenance', notBefore },
    ]);
    expect((await poll()).events).toHaveLength(2);
    ec2.scheduledEvents.set(vm.id, [
      { id: 'instance-event-0123456789abcdef4', code: 'system-reboot', description: 'reboot', notBefore: notBefore + 3_600_000 },
    ]);
    emu.clock.advance(5 * 60_000);
    const next = (await poll()).events;
    expect(next.map((event) => event.id).sort()).toEqual([
      'status/i-0abc12345678def01/instance-event-0123456789abcdef2/completed',
      'status/i-0abc12345678def01/instance-event-0123456789abcdef4/scheduled',
      'status/i-0abc12345678def02/instance-event-0123456789abcdef3/scheduled',
    ]);
    expect(next.find((event) => event.id.endsWith('def2/completed'))).toMatchObject({
      kind: 'maintenance-scheduled',
      machineId: vm.id,
      details: { code: 'system-reboot', status: 'completed' },
    });
    // Reported once: the next scan does not complete it again.
    emu.clock.advance(5 * 60_000);
    expect((await poll()).events.filter((event) => event.id.endsWith('/completed'))).toEqual([]);
  });

  it('a failed DescribeInstanceStatus scan is retried after the scan interval', async () => {
    // vps polls every 15 s: a failing scan must not spend the account's EC2 budget each time.
    const { emu, ec2, poll } = await world({});
    ec2.addInstance({ id: 'i-0abc12345678def01' });
    emu.failNext('DescribeInstanceStatus', 'RequestLimitExceeded', 503);
    await expect(poll()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    emu.clock.advance(15_000);
    await expect(poll()).resolves.toMatchObject({ events: [] });
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(1);
    emu.clock.advance(5 * 60_000);
    await expect(poll()).resolves.toMatchObject({ events: [] });
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(2);
  });

  it('a scan the IAM policy does not allow backs off an hour and says how to fix it', async () => {
    // An account whose policy predates A4 has no ec2:DescribeInstanceStatus.
    const { emu, ec2, poll, records } = await world({});
    ec2.addInstance({ id: 'i-0abc12345678def01' });
    emu.failNext('DescribeInstanceStatus', 'UnauthorizedOperation', 403, 3);
    await expect(poll()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const hints = () => records.filter((line) => line.includes('aws iam-policy'));
    expect(hints()).toHaveLength(1);
    for (let minute = 5; minute < 60; minute += 5) {
      emu.clock.advance(5 * 60_000);
      await expect(poll()).resolves.toMatchObject({ events: [] });
    }
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(1);
    expect(hints()).toHaveLength(1);
    emu.clock.advance(5 * 60_000);
    await expect(poll()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(emu.calls('DescribeInstanceStatus')).toHaveLength(2);
    expect(hints()).toHaveLength(2);
  });
});
