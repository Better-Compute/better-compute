import { describe, expect, it } from 'vitest';
import { liveGate, testRunTagKey } from './live/aws/support/live.js';
import { deleteLiveResources, sweepTestRuns } from './live/aws/support/sweep.js';
import { AwsEmulator, testAccessKeyId, testSecret } from './support/aws-platform-emulator/index.js';
import { fisFake, recorderFake, s3SweepFake, stsFake, taggingFake, type FakeBucket, type RecordedCall } from './support/aws-live-fakes.js';

// The live-suite sweeper (A12): deletes what a crashed live run left behind, found by its
// test-run tag, only in the pinned sandbox account, only for runs older than two hours, in
// dependency order, and lists without deleting unless told to apply.

const SANDBOX = '210987654321';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const oldRun = `r${(NOW - 3 * 3600_000) / 1000}-0badc0de`;
const youngRun = `r${(NOW - 30 * 60_000) / 1000}-00c0ffee`;
const arn = (service: string, resource: string, account = SANDBOX) => `arn:aws:${service}:us-east-1:${account}:${resource}`;

function world(
  resources: { arn: string; tags: Record<string, string> }[],
  options: {
    account?: string;
    pageSize?: number;
    buckets?: Map<string, FakeBucket>;
    s3PageSize?: number;
    failKeys?: Set<string>;
    ec2Answers?: Record<string, () => string>;
  } = {},
) {
  const emu = new AwsEmulator(NOW);
  stsFake(emu, { account: options.account ?? SANDBOX });
  const tagging = taggingFake(emu, { resources, ...(options.pageSize ? { pageSize: options.pageSize } : {}) });
  const log: RecordedCall[] = [];
  recorderFake(emu, 'ec2', 'query', log, {
    DescribeInternetGateways: () =>
      `<DescribeInternetGatewaysResponse><internetGatewaySet><item><internetGatewayId>igw-1</internetGatewayId><attachmentSet><item><vpcId>vpc-1</vpcId><state>available</state></item></attachmentSet></item></internetGatewaySet></DescribeInternetGatewaysResponse>`,
    ...options.ec2Answers,
  });
  recorderFake(emu, 'events', 'json', log, { ListTargetsByRule: () => ({ Targets: [{ Id: 't1' }, { Id: 't2' }] }) });
  for (const [service, protocol] of [
    ['sqs', 'json'],
    ['sns', 'query'],
    ['secretsmanager', 'json'],
    ['logs', 'json'],
    ['cloudformation', 'query'],
    ['kms', 'json'],
  ] as const)
    recorderFake(emu, service, protocol, log);
  fisFake(emu, log);
  const s3 = s3SweepFake(emu, {
    buckets: options.buckets ?? new Map(),
    ...(options.s3PageSize ? { pageSize: options.s3PageSize } : {}),
    ...(options.failKeys ? { failKeys: options.failKeys } : {}),
  });
  const gate = liveGate({
    BETTER_COMPUTE_AWS_LIVE: '1',
    BETTER_COMPUTE_AWS_LIVE_ACCOUNT: SANDBOX,
    BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '25',
    AWS_ACCESS_KEY_ID: testAccessKeyId,
    AWS_SECRET_ACCESS_KEY: testSecret,
  });
  if (!gate.enabled) throw new Error('gate closed');
  const sweep = (apply: boolean) =>
    sweepTestRuns({ config: gate.config, deps: { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local' }, apply });
  const order = () => emu.requests.filter((request) => !['GetResources', 'GetCallerIdentity'].includes(request.operation)).map((request) => request.operation);
  const cleanUp = (arns: string[]) =>
    deleteLiveResources({ config: gate.config, deps: { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local' }, arns });
  return { emu, log, tagging, s3, sweep, cleanUp, order, gate };
}

const tagged = (resource: string, run = oldRun) => ({ arn: resource, tags: { [testRunTagKey]: run, 'better-compute:managed': 'true' } });

describe('sweepTestRuns', () => {
  it('refuses to sweep any account but the sandbox', async () => {
    const { emu, sweep } = world([tagged(arn('ec2', 'instance/i-1'))], { account: '111111111111' });
    await expect(sweep(true)).rejects.toThrow(/not the sandbox account/);
    expect(emu.calls('GetResources')).toHaveLength(0);
  });

  it('lists what it would delete and deletes nothing unless applied', async () => {
    const { sweep, order, tagging } = world([tagged(arn('ec2', 'instance/i-1')), tagged(arn('ec2', 'vpc/vpc-1'))]);
    const report = await sweep(false);
    expect(report.wouldDelete).toEqual([arn('ec2', 'instance/i-1'), arn('ec2', 'vpc/vpc-1')]);
    expect(report.deleted).toEqual([]);
    expect(order()).toEqual([]);
    expect(tagging.requests[0]).toMatchObject({ TagFilters: [{ Key: testRunTagKey }] });
  });

  it('leaves young runs, unreadable tags and other accounts alone', async () => {
    const { sweep, order } = world([
      tagged(arn('ec2', 'instance/i-young'), youngRun),
      tagged(arn('ec2', 'instance/i-odd'), 'manual'),
      tagged(arn('ec2', 'instance/i-foreign', '333333333333')),
    ]);
    const report = await sweep(true);
    expect(report.deleted).toEqual([]);
    expect(report.skipped).toEqual([
      { arn: arn('ec2', 'instance/i-young'), reason: expect.stringContaining('younger than') },
      { arn: arn('ec2', 'instance/i-odd'), reason: expect.stringContaining('not a test-run id') },
      { arn: arn('ec2', 'instance/i-foreign', '333333333333'), reason: expect.stringContaining('another account') },
    ]);
    expect(order()).toEqual([]);
  });

  it('deletes in dependency order: stacks and instances first, the VPC last', async () => {
    const { sweep, order } = world([
      tagged(arn('ec2', 'vpc/vpc-1')),
      tagged(arn('ec2', 'subnet/subnet-1')),
      tagged(arn('ec2', 'security-group/sg-1')),
      tagged(arn('ec2', 'internet-gateway/igw-1')),
      tagged(arn('ec2', 'vpc-endpoint/vpce-1')),
      tagged(arn('ec2', 'route-table/rtb-1')),
      tagged(arn('ec2', 'network-acl/acl-1')),
      tagged(arn('ec2', 'volume/vol-1')),
      tagged(arn('ec2', 'elastic-ip/eipalloc-1')),
      tagged(arn('ec2', 'instance/i-1')),
      tagged(arn('cloudformation', 'stack/bc-live/abc')),
    ]);
    const report = await sweep(true);
    expect(report.pending).toEqual([]);
    expect(report.deleted).toHaveLength(11);
    expect(order()).toEqual([
      'DeleteStack',
      'TerminateInstances',
      'DeleteVolume',
      'ReleaseAddress',
      'DeleteSecurityGroup',
      'DescribeInternetGateways',
      'DetachInternetGateway',
      'DeleteInternetGateway',
      // Gateway endpoints hold routes in the VPC's tables; they go before the tables and the VPC.
      'DeleteVpcEndpoints',
      // A subnet's route table and NACL associations go with it, so subnets come first.
      'DeleteSubnet',
      'DeleteRouteTable',
      'DeleteNetworkAcl',
      'DeleteVpc',
    ]);
  });

  it('calls each service with the resource from its ARN', async () => {
    const { sweep, log } = world([
      tagged(arn('ec2', 'instance/i-1')),
      tagged(arn('ec2', 'internet-gateway/igw-1')),
      tagged(arn('sqs', 'bc-live-queue')),
      tagged(arn('sns', 'bc-live-topic')),
      tagged(arn('events', 'rule/bc-live-bus/bc-live-rule')),
      tagged(arn('secretsmanager', 'secret:bc-live/x-AbCdEf')),
      tagged(arn('logs', 'log-group:/bc-live/x:*')),
      tagged(arn('kms', 'key/1234abcd-12ab-34cd-56ef-1234567890ab')),
    ]);
    await sweep(true);
    const call = (operation: string) => log.find((entry) => entry.operation === operation)?.params;
    expect(call('TerminateInstances')).toMatchObject({ 'InstanceId.1': 'i-1' });
    expect(call('DetachInternetGateway')).toMatchObject({ InternetGatewayId: 'igw-1', VpcId: 'vpc-1' });
    expect(call('DeleteQueue')).toEqual({ QueueUrl: `https://sqs.us-east-1.amazonaws.com/${SANDBOX}/bc-live-queue` });
    expect(call('DeleteTopic')).toMatchObject({ TopicArn: arn('sns', 'bc-live-topic') });
    expect(call('RemoveTargets')).toEqual({ Rule: 'bc-live-rule', EventBusName: 'bc-live-bus', Ids: ['t1', 't2'], Force: true });
    expect(call('DeleteRule')).toEqual({ Name: 'bc-live-rule', EventBusName: 'bc-live-bus', Force: true });
    expect(call('DeleteSecret')).toEqual({ SecretId: arn('secretsmanager', 'secret:bc-live/x-AbCdEf'), ForceDeleteWithoutRecovery: true });
    expect(call('DeleteLogGroup')).toEqual({ logGroupName: '/bc-live/x' });
    expect(call('ScheduleKeyDeletion')).toEqual({ KeyId: arn('kms', 'key/1234abcd-12ab-34cd-56ef-1234567890ab'), PendingWindowInDays: 7 });
  });

  it('reads DeleteVpcEndpoints failures from its unsuccessful set: gone is deleted, in use is pending', async () => {
    const unsuccessful = (code: string) =>
      `<DeleteVpcEndpointsResponse><unsuccessful><item><resourceId>vpce-x</resourceId><error><code>${code}</code><message>m</message></error></item></unsuccessful></DeleteVpcEndpointsResponse>`;
    for (const [code, outcome] of [
      ['InvalidVpcEndpointId.NotFound', 'deleted'],
      ['DependencyViolation', 'pending'],
    ] as const) {
      const { sweep } = world([tagged(arn('ec2', 'vpc-endpoint/vpce-x'))], { ec2Answers: { DeleteVpcEndpoints: () => unsuccessful(code) } });
      const report = await sweep(true);
      if (outcome === 'deleted') expect(report.deleted, code).toEqual([arn('ec2', 'vpc-endpoint/vpce-x')]);
      else expect(report.pending, code).toEqual([{ arn: arn('ec2', 'vpc-endpoint/vpce-x'), reason: expect.stringContaining(code) }]);
    }
  });

  it('keeps a resource still in use pending, and counts one already gone as deleted', async () => {
    const { emu, sweep } = world([tagged(arn('ec2', 'instance/i-gone')), tagged(arn('ec2', 'vpc/vpc-1'))]);
    emu.failNext('TerminateInstances', 'InvalidInstanceID.NotFound');
    emu.failNext('DeleteVpc', 'DependencyViolation');
    const report = await sweep(true);
    expect(report.deleted).toEqual([arn('ec2', 'instance/i-gone')]);
    expect(report.pending).toEqual([{ arn: arn('ec2', 'vpc/vpc-1'), reason: expect.stringContaining('DependencyViolation') }]);
  });

  it('counts a KMS key already pending deletion as swept', async () => {
    const key = arn('kms', 'key/1234abcd-12ab-34cd-56ef-1234567890ab');
    const { emu, sweep } = world([tagged(key)]);
    emu.failNext('ScheduleKeyDeletion', 'KMSInvalidStateException');
    expect((await sweep(true)).deleted).toEqual([key]);
  });

  it('skips resource types it has no deleter for, with a reason', async () => {
    const { sweep } = world([tagged(`arn:aws:iam::${SANDBOX}:role/bc-live`), tagged(arn('dynamodb', 'table/bc-live'))]);
    const report = await sweep(true);
    expect(report.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('no sweeper for iam:role'),
      expect.stringContaining('no sweeper for dynamodb'),
    ]);
  });

  it('empties an S3 bucket of every version and delete marker, then deletes it, as the sandbox owner', async () => {
    const versions = Array.from({ length: 5 }, (_, index) => ({ key: `blobs/k&${index}`, versionId: `v${index}`, marker: index === 4 }));
    const buckets = new Map<string, FakeBucket>([['bc-live-bucket', { owner: SANDBOX, versions }]]);
    const { sweep, s3 } = world([tagged('arn:aws:s3:::bc-live-bucket')], { buckets, s3PageSize: 2 });
    const report = await sweep(true);
    expect(report.pending).toEqual([]);
    expect(report.deleted).toEqual(['arn:aws:s3:::bc-live-bucket']);
    expect(buckets.has('bc-live-bucket')).toBe(false);
    expect(s3.requests.map((request) => request.operation)).toEqual([
      'ListObjectVersions',
      'DeleteObjects',
      'ListObjectVersions',
      'DeleteObjects',
      'ListObjectVersions',
      'DeleteObjects',
      'DeleteBucket',
    ]);
    // S3 ARNs name no account: S3 itself refuses a bucket some other account owns.
    for (const request of s3.requests) expect(request.headers['x-amz-expected-bucket-owner']).toBe(SANDBOX);
    expect(s3.requests[1]!.body).toContain('<Key>blobs/k&amp;0</Key><VersionId>v0</VersionId>');
  });

  it('dry-runs S3 buckets without touching them', async () => {
    const buckets = new Map<string, FakeBucket>([['bc-live-bucket', { owner: SANDBOX, versions: [{ key: 'a', versionId: 'v1' }] }]]);
    const { sweep, s3 } = world([tagged('arn:aws:s3:::bc-live-bucket')], { buckets });
    expect((await sweep(false)).wouldDelete).toEqual(['arn:aws:s3:::bc-live-bucket']);
    expect(s3.requests).toEqual([]);
  });

  it('keeps a bucket pending when S3 refuses to delete some of its objects', async () => {
    const buckets = new Map<string, FakeBucket>([
      ['bc-live-bucket', { owner: SANDBOX, versions: [{ key: 'a', versionId: 'v1' }, { key: 'locked', versionId: 'v2' }] }],
    ]);
    const { sweep, s3 } = world([tagged('arn:aws:s3:::bc-live-bucket')], { buckets, failKeys: new Set(['locked']) });
    const report = await sweep(true);
    expect(report.deleted).toEqual([]);
    expect(report.pending).toEqual([{ arn: 'arn:aws:s3:::bc-live-bucket', reason: expect.stringContaining('AccessDenied') }]);
    expect(s3.requests.map((request) => request.operation)).not.toContain('DeleteBucket');
  });

  it('keeps a bucket another account owns pending, untouched', async () => {
    const buckets = new Map<string, FakeBucket>([['bc-live-bucket', { owner: '333333333333', versions: [{ key: 'a', versionId: 'v1' }] }]]);
    const { sweep } = world([tagged('arn:aws:s3:::bc-live-bucket')], { buckets });
    const report = await sweep(true);
    expect(report.pending).toEqual([{ arn: 'arn:aws:s3:::bc-live-bucket', reason: expect.stringContaining('AccessDenied') }]);
    expect(buckets.get('bc-live-bucket')!.versions).toHaveLength(1);
  });

  it('deletes an event bus after its rules, and FIS experiment templates', async () => {
    const { sweep, order, log } = world([
      tagged(arn('events', 'event-bus/bc-live-bus')),
      tagged(arn('events', 'rule/bc-live-bus/bc-live-rule')),
      tagged(arn('fis', 'experiment-template/EXTabc123')),
    ]);
    const report = await sweep(true);
    expect(report.pending).toEqual([]);
    expect(order()).toEqual(['ListTargetsByRule', 'RemoveTargets', 'DeleteRule', 'DeleteExperimentTemplate', 'DeleteEventBus']);
    expect(log.find((entry) => entry.operation === 'DeleteEventBus')?.params).toEqual({ Name: 'bc-live-bus' });
    expect(log.find((entry) => entry.operation === 'DeleteExperimentTemplate')?.params).toEqual({ id: 'EXTabc123' });
  });

  it('reads every page of tagged resources', async () => {
    const resources = Array.from({ length: 5 }, (_, index) => tagged(arn('ec2', `volume/vol-${index}`)));
    const { sweep, tagging } = world(resources, { pageSize: 2 });
    const report = await sweep(false);
    expect(report.wouldDelete).toHaveLength(5);
    expect(tagging.requests).toHaveLength(3);
  });
});

describe('deleteLiveResources', () => {
  // A live file's afterAll: deletes what it created by ARN, at once (the Tagging API lags), with
  // the sweeper's deleters, order and account rules.
  it('deletes the given resources in dependency order, without a tag scan', async () => {
    const buckets = new Map<string, FakeBucket>([['bc-live-bucket', { owner: SANDBOX, versions: [{ key: 'a', versionId: 'v1' }] }]]);
    const { emu, cleanUp, order } = world([], { buckets });
    const report = await cleanUp([arn('events', 'event-bus/bc-live-bus'), 'arn:aws:s3:::bc-live-bucket', arn('events', 'rule/bc-live-bus/r1')]);
    expect(report.pending).toEqual([]);
    expect(report.deleted).toHaveLength(3);
    expect(emu.calls('GetResources')).toHaveLength(0);
    // Same rank keeps the given order; the bus (rank 3) waits for its rule.
    expect(order()).toEqual(['ListObjectVersions', 'DeleteObjects', 'DeleteBucket', 'ListTargetsByRule', 'RemoveTargets', 'DeleteRule', 'DeleteEventBus']);
  });

  // TerminateInstances returns while the instances are still shutting-down, holding their network
  // interfaces: a security group, Elastic IP, subnet or VPC beside them answers DependencyViolation
  // until they are terminated.
  const describeInstances = (states: string[]) => {
    let call = 0;
    return () => {
      const state = states[Math.min(call++, states.length - 1)]!;
      return `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-1</instanceId><instanceState><code>0</code><name>${state}</name></instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
    };
  };
  const network = [arn('ec2', 'instance/i-1'), arn('ec2', 'security-group/sg-1'), arn('ec2', 'subnet/subnet-1'), arn('ec2', 'vpc/vpc-1')];

  it('waits for terminated instances before deleting what their network interfaces hold', async () => {
    const { emu, log, order, gate } = world([], { ec2Answers: { DescribeInstances: describeInstances(['shutting-down', 'shutting-down', 'terminated']) } });
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      emu.clock.advance(ms);
    };
    const report = await deleteLiveResources({
      config: gate.config,
      deps: { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local', sleep },
      arns: network,
    });
    expect(report.pending).toEqual([]);
    expect(report.deleted).toEqual(network);
    expect(order()).toEqual(['TerminateInstances', 'DescribeInstances', 'DescribeInstances', 'DescribeInstances', 'DeleteSecurityGroup', 'DeleteSubnet', 'DeleteVpc']);
    expect(log.find((entry) => entry.operation === 'DescribeInstances')?.params).toMatchObject({ 'InstanceId.1': 'i-1' });
    expect(slept).toEqual([10_000, 10_000]);
  });

  it('retries a delete that is still in use until it goes through', async () => {
    const { emu, order, gate } = world([], { ec2Answers: { DescribeInstances: describeInstances(['terminated']) } });
    // The instance is terminated, but its interface lingers for a moment.
    emu.failNext('DeleteSecurityGroup', 'DependencyViolation', 400, 2);
    const sleep = async (ms: number) => void emu.clock.advance(ms);
    const report = await deleteLiveResources({
      config: gate.config,
      deps: { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local', sleep },
      arns: network,
    });
    expect(report.pending).toEqual([]);
    expect([...report.deleted].sort()).toEqual([...network].sort());
    expect(order().filter((operation) => operation === 'DeleteSecurityGroup')).toHaveLength(3);
  });

  it('stops waiting at its deadline and leaves what is still in use pending for the sweeper', async () => {
    const { emu, gate } = world([], { ec2Answers: { DescribeInstances: describeInstances(['shutting-down']) } });
    emu.failNext('DeleteSecurityGroup', 'DependencyViolation', 400, 1000);
    const sleep = async (ms: number) => void emu.clock.advance(ms);
    const started = emu.clock.now();
    const report = await deleteLiveResources({
      config: gate.config,
      deps: { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local', sleep },
      arns: network,
      settleMs: 60_000,
      pollMs: 5_000,
    });
    expect(report.pending).toEqual([{ arn: arn('ec2', 'security-group/sg-1'), reason: expect.stringContaining('DependencyViolation') }]);
    expect(emu.clock.now() - started).toBeLessThanOrEqual(60_000);
    expect(emu.calls('DescribeInstances').length).toBeLessThanOrEqual(13);
    // Something that is not merely in use fails at once, without retries.
    const other = world([], { ec2Answers: { DescribeInstances: describeInstances(['terminated']) } });
    other.emu.failNext('DeleteVpc', 'UnauthorizedOperation', 403);
    const refused = await deleteLiveResources({
      config: other.gate.config,
      deps: { fetch: other.emu.fetch, clock: other.emu.clock, endpoint: 'http://emu.local', sleep: async (ms) => void other.emu.clock.advance(ms) },
      arns: [arn('ec2', 'vpc/vpc-1')],
    });
    expect(refused.pending).toEqual([{ arn: arn('ec2', 'vpc/vpc-1'), reason: expect.stringContaining('UnauthorizedOperation') }]);
    expect(other.emu.calls('DeleteVpc')).toHaveLength(1);
  });

  it('refuses the wrong account and skips what it cannot delete', async () => {
    const wrong = world([], { account: '111111111111' });
    await expect(wrong.cleanUp([arn('sqs', 'q')])).rejects.toThrow(/not the sandbox account/);
    const { cleanUp, order } = world([]);
    const report = await cleanUp([arn('sqs', 'q', '333333333333'), arn('dynamodb', 'table/t'), 'not-an-arn']);
    expect(report.deleted).toEqual([]);
    expect(report.skipped.map((entry) => entry.arn)).toEqual([arn('sqs', 'q', '333333333333'), arn('dynamodb', 'table/t'), 'not-an-arn']);
    expect(order()).toEqual([]);
  });
});
