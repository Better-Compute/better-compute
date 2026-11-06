import { describe, expect, it } from 'vitest';
import { liveGate, liveTags, newTestRunId, testRunTagKey } from './live/aws/support/live.js';
import { liveAws } from './live/aws/support/resources.js';
import { AwsEmulator, testAccessKeyId, testSecret } from './support/aws-platform-emulator/index.js';
import { recorderFake, s3SweepFake, stsFake, type FakeBucket, type RecordedCall } from './support/aws-live-fakes.js';

// The live files' own fixtures (A12): every resource is tagged with the run's liveTags, its ARN is
// recorded as soon as it exists, and cleanUp deletes all of it through the sweeper's deleters.

const SANDBOX = '210987654321';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const run = newTestRunId(NOW, '0badc0de');
const tagMap = Object.fromEntries(liveTags(run).map((tag) => [tag.Key, tag.Value]));

function world(region = 'us-east-1') {
  const emu = new AwsEmulator(NOW);
  stsFake(emu, { account: SANDBOX });
  const buckets = new Map<string, FakeBucket>();
  const s3 = s3SweepFake(emu, { buckets, account: SANDBOX });
  const log: RecordedCall[] = [];
  let received = 0;
  recorderFake(emu, 'sqs', 'json', log, {
    CreateQueue: (params) => ({ QueueUrl: `https://sqs.${region}.amazonaws.com/${SANDBOX}/${String(params.QueueName)}` }),
    GetQueueAttributes: (params) => ({
      Attributes: { QueueArn: `arn:aws:sqs:${region}:${SANDBOX}:${String(params.QueueUrl).split('/').at(-1)}` },
    }),
    ReceiveMessage: () => {
      received += 1;
      return received === 1
        ? { Messages: [{ Body: '{"id":"other"}', ReceiptHandle: 'rh-1' }] }
        : {
            Messages: [
              { Body: '{"id":"wanted"}', ReceiptHandle: 'rh-2', MessageAttributes: { type: { DataType: 'String', StringValue: 'instance.created' } } },
            ],
          };
    },
  });
  recorderFake(emu, 'events', 'json', log, {
    CreateEventBus: (params) => ({ EventBusArn: `arn:aws:events:${region}:${SANDBOX}:event-bus/${String(params.Name)}` }),
    PutRule: (params) => ({ RuleArn: `arn:aws:events:${region}:${SANDBOX}:rule/${String(params.EventBusName)}/${String(params.Name)}` }),
    PutTargets: () => ({ FailedEntryCount: 0, FailedEntries: [] }),
    ListTargetsByRule: () => ({ Targets: [{ Id: 'live-target' }] }),
  });
  recorderFake(emu, 'secretsmanager', 'json', log, {
    DescribeSecret: (params) => ({ ARN: `arn:aws:secretsmanager:${region}:${SANDBOX}:secret:${String(params.SecretId)}-AbCdEf` }),
  });
  const gate = liveGate({
    BETTER_COMPUTE_AWS_LIVE: '1',
    BETTER_COMPUTE_AWS_LIVE_ACCOUNT: SANDBOX,
    BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '25',
    BETTER_COMPUTE_AWS_LIVE_REGION: region,
    AWS_ACCESS_KEY_ID: testAccessKeyId,
    AWS_SECRET_ACCESS_KEY: testSecret,
  });
  if (!gate.enabled) throw new Error('gate closed');
  const aws = liveAws(gate.config, run, { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local' });
  const call = (operation: string) => log.find((entry) => entry.operation === operation)?.params;
  return { emu, aws, buckets, s3, log, call };
}

describe('liveAws fixtures', () => {
  it('creates a bucket with the run tags and records it before tagging', async () => {
    const { aws, buckets, s3, emu } = world();
    emu.failNext('PutBucketTagging', 'InternalError', 500);
    await expect(aws.createBucket('bc-live-bucket')).rejects.toThrow();
    // Created but untagged: it is still recorded, so cleanUp deletes it.
    expect(aws.created).toEqual(['arn:aws:s3:::bc-live-bucket']);
    expect(s3.requests[0]).toMatchObject({ operation: 'CreateBucket', body: '' });
    await aws.createBucket('bc-live-other');
    expect(buckets.get('bc-live-other')!.tags).toEqual(tagMap);
    expect(buckets.get('bc-live-other')!.tags![testRunTagKey]).toBe(run);
  });

  it('names the region outside us-east-1', async () => {
    const { aws, s3 } = world('eu-west-1');
    expect(await aws.createBucket('bc-live-bucket')).toBe('arn:aws:s3:::bc-live-bucket');
    expect(s3.requests[0]!.body).toContain('<LocationConstraint>eu-west-1</LocationConstraint>');
  });

  it('tags queues, buses and rules at creation and scopes the queue policy to the rule', async () => {
    const { aws, call } = world();
    const queue = await aws.createQueue('bc-live-q');
    expect(call('CreateQueue')).toEqual({ QueueName: 'bc-live-q', tags: tagMap });
    const bus = await aws.createBus('bc-live-bus');
    expect(call('CreateEventBus')).toEqual({ Name: 'bc-live-bus', Tags: liveTags(run) });
    const rule = await aws.createRule('bc-live-bus', 'bc-live-rule', { source: ['better-compute.live'] }, queue.arn);
    expect(call('PutRule')).toMatchObject({
      EventBusName: 'bc-live-bus',
      EventPattern: '{"source":["better-compute.live"]}',
      Tags: liveTags(run),
    });
    expect(call('PutTargets')).toEqual({ Rule: 'bc-live-rule', EventBusName: 'bc-live-bus', Targets: [{ Id: 'live-target', Arn: queue.arn }] });
    await aws.allowEventBridge(queue, rule);
    const attributes = call('SetQueueAttributes') as { Attributes: { Policy: string } };
    const policy = JSON.parse(attributes.Attributes.Policy) as { Statement: Record<string, unknown>[] };
    expect(policy.Statement[0]).toMatchObject({ Resource: queue.arn, Condition: { ArnEquals: { 'aws:SourceArn': rule } } });
    expect(aws.created).toEqual([queue.arn, bus, rule]);
  });

  it('tags a secret an adapter made and records its ARN', async () => {
    const { aws, call } = world();
    const arn = await aws.tagSecret('bc-live/t_live/abc');
    expect(call('TagResource')).toEqual({ SecretId: arn, Tags: liveTags(run) });
    expect(aws.created).toEqual([arn]);
  });

  it('receives until a message matches, deleting each one it reads', async () => {
    const { aws, log } = world();
    const queue = await aws.createQueue('bc-live-q');
    const message = await aws.receive(queue, (m) => (JSON.parse(m.body) as { id: string }).id === 'wanted', 60_000);
    expect(message.attributes).toEqual({ type: 'instance.created' });
    expect(log.filter((entry) => entry.operation === 'DeleteMessage').map((entry) => entry.params.ReceiptHandle)).toEqual(['rh-1', 'rh-2']);
  });

  it('gives up on a queue after the timeout', async () => {
    const { aws, emu } = world();
    const queue = await aws.createQueue('bc-live-q');
    emu.clock.advance(1);
    await expect(aws.receive(queue, () => false, 0)).rejects.toThrow(/no matching message/);
  });

  it('cleans up everything it recorded, the bucket emptied first', async () => {
    const { aws, buckets, log } = world();
    await aws.createBucket('bc-live-bucket');
    buckets.get('bc-live-bucket')!.versions.push({ key: 'live/a', versionId: 'v1' });
    const queue = await aws.createQueue('bc-live-q');
    await aws.createBus('bc-live-bus');
    await aws.createRule('bc-live-bus', 'bc-live-rule', { source: ['x'] }, queue.arn);
    const report = await aws.cleanUp();
    expect(report.pending).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.deleted).toHaveLength(4);
    expect(buckets.size).toBe(0);
    const order = log.map((entry) => entry.operation).filter((op) => op.startsWith('Delete'));
    expect(order.indexOf('DeleteRule')).toBeLessThan(order.indexOf('DeleteEventBus'));
  });
});
