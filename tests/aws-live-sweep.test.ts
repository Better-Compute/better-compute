import { describe, expect, it } from 'vitest';
import { liveGate, testRunTagKey } from './live/aws/support/live.js';
import { sweepTestRuns } from './live/aws/support/sweep.js';
import { AwsEmulator, testAccessKeyId, testSecret } from './support/aws-platform-emulator/index.js';
import { recorderFake, stsFake, taggingFake, type RecordedCall } from './support/aws-live-fakes.js';

// The live-suite sweeper (A12): deletes what a crashed live run left behind, found by its
// test-run tag, only in the pinned sandbox account, only for runs older than two hours, in
// dependency order, and lists without deleting unless told to apply.

const SANDBOX = '210987654321';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const oldRun = `r${(NOW - 3 * 3600_000) / 1000}-0badc0de`;
const youngRun = `r${(NOW - 30 * 60_000) / 1000}-00c0ffee`;
const arn = (service: string, resource: string, account = SANDBOX) => `arn:aws:${service}:us-east-1:${account}:${resource}`;

function world(resources: { arn: string; tags: Record<string, string> }[], options: { account?: string; pageSize?: number } = {}) {
  const emu = new AwsEmulator(NOW);
  stsFake(emu, { account: options.account ?? SANDBOX });
  const tagging = taggingFake(emu, { resources, ...(options.pageSize ? { pageSize: options.pageSize } : {}) });
  const log: RecordedCall[] = [];
  recorderFake(emu, 'ec2', 'query', log, {
    DescribeInternetGateways: () =>
      `<DescribeInternetGatewaysResponse><internetGatewaySet><item><internetGatewayId>igw-1</internetGatewayId><attachmentSet><item><vpcId>vpc-1</vpcId><state>available</state></item></attachmentSet></item></internetGatewaySet></DescribeInternetGatewaysResponse>`,
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
  return { emu, log, tagging, sweep, order };
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
      tagged(arn('ec2', 'route-table/rtb-1')),
      tagged(arn('ec2', 'network-acl/acl-1')),
      tagged(arn('ec2', 'volume/vol-1')),
      tagged(arn('ec2', 'elastic-ip/eipalloc-1')),
      tagged(arn('ec2', 'instance/i-1')),
      tagged(arn('cloudformation', 'stack/bc-live/abc')),
    ]);
    const report = await sweep(true);
    expect(report.pending).toEqual([]);
    expect(report.deleted).toHaveLength(10);
    expect(order()).toEqual([
      'DeleteStack',
      'TerminateInstances',
      'DeleteVolume',
      'ReleaseAddress',
      'DeleteSecurityGroup',
      'DescribeInternetGateways',
      'DetachInternetGateway',
      'DeleteInternetGateway',
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
    const { sweep } = world([tagged('arn:aws:s3:::bc-live-bucket'), tagged(arn('dynamodb', 'table/bc-live'))]);
    const report = await sweep(true);
    expect(report.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('no sweeper for s3'),
      expect.stringContaining('no sweeper for dynamodb'),
    ]);
  });

  it('reads every page of tagged resources', async () => {
    const resources = Array.from({ length: 5 }, (_, index) => tagged(arn('ec2', `volume/vol-${index}`)));
    const { sweep, tagging } = world(resources, { pageSize: 2 });
    const report = await sweep(false);
    expect(report.wouldDelete).toHaveLength(5);
    expect(tagging.requests).toHaveLength(3);
  });
});
