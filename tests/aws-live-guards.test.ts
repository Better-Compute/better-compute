import { describe, expect, it } from 'vitest';
import {
  assertLiveInstanceType,
  liveEc2Fetch,
  liveGate,
  liveMaxLaunches,
  livePreflight,
  liveTags,
  newTestRunId,
  testRunStartedAt,
  testRunTagKey,
} from './live/aws/support/live.js';
import { AwsEmulator, testAccessKeyId, testSecret } from './support/aws-platform-emulator/index.js';
import { costExplorerFake, stsFake } from './support/aws-live-fakes.js';

// The AWS live suite's guards (A12), pinned on the emulator: the suite is off unless explicitly
// enabled; enabled, it needs a pinned sandbox account and a budget, refuses any other account,
// refuses to start over budget, tags every resource with a test-run id the sweeper can age, and
// launches only allow-listed instance types.

const SANDBOX = '210987654321';
const fullEnv = {
  BETTER_COMPUTE_AWS_LIVE: '1',
  BETTER_COMPUTE_AWS_LIVE_ACCOUNT: SANDBOX,
  BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '25',
  AWS_ACCESS_KEY_ID: testAccessKeyId,
  AWS_SECRET_ACCESS_KEY: testSecret,
};

function world(options: { account?: string; spend?: { amount: string; unit?: string }[]; now?: number } = {}) {
  const emu = new AwsEmulator(options.now);
  stsFake(emu, { account: options.account ?? SANDBOX });
  const ce = costExplorerFake(emu, { results: options.spend ?? [{ amount: '3.21' }] });
  const gate = liveGate(fullEnv);
  if (!gate.enabled) throw new Error('expected the gate to be open');
  const deps = { fetch: emu.fetch, clock: emu.clock, endpoint: 'http://emu.local' };
  return { emu, ce, config: gate.config, deps };
}

describe('liveGate', () => {
  it('is off unless BETTER_COMPUTE_AWS_LIVE is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(liveGate({ ...fullEnv, BETTER_COMPUTE_AWS_LIVE: value }).enabled, String(value)).toBe(false);
    expect(liveGate({}).enabled).toBe(false);
  });

  it('opens with a pinned account, a budget and credentials; region defaults to us-east-1', () => {
    const gate = liveGate(fullEnv);
    expect(gate.enabled).toBe(true);
    if (!gate.enabled) return;
    expect(gate.config).toMatchObject({ account: SANDBOX, budgetUsd: 25, region: 'us-east-1' });
    expect(liveGate({ ...fullEnv, AWS_REGION: 'eu-west-1' })).toMatchObject({ config: { region: 'eu-west-1' } });
    expect(liveGate({ ...fullEnv, AWS_REGION: 'eu-west-1', BETTER_COMPUTE_AWS_LIVE_REGION: 'us-west-2' })).toMatchObject({ config: { region: 'us-west-2' } });
  });

  it('fails loudly, without echoing secrets, when enabled but misconfigured', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ BETTER_COMPUTE_AWS_LIVE_ACCOUNT: undefined }, /BETTER_COMPUTE_AWS_LIVE_ACCOUNT/],
      [{ BETTER_COMPUTE_AWS_LIVE_ACCOUNT: '12345' }, /BETTER_COMPUTE_AWS_LIVE_ACCOUNT/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: undefined }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: '0' }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ BETTER_COMPUTE_AWS_LIVE_BUDGET_USD: 'lots' }, /BETTER_COMPUTE_AWS_LIVE_BUDGET_USD/],
      [{ AWS_SECRET_ACCESS_KEY: undefined }, /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/],
      [{ BETTER_COMPUTE_AWS_LIVE_REGION: 'moon-1' }, /region/],
    ];
    for (const [overrides, message] of cases) {
      let error: unknown;
      try {
        liveGate({ ...fullEnv, ...overrides });
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(overrides)).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(testSecret);
    }
  });
});

describe('livePreflight', () => {
  it('passes in the sandbox account under budget', async () => {
    const { config, deps } = world();
    await expect(livePreflight(config, deps)).resolves.toEqual({ account: SANDBOX, monthToDateUsd: 3.21 });
  });

  it('refuses credentials of any other account before spending anything', async () => {
    const { emu, config, deps } = world({ account: '111111111111' });
    await expect(livePreflight(config, deps)).rejects.toThrow(/not the sandbox account/);
    expect(emu.calls('GetCostAndUsage')).toHaveLength(0);
  });

  it('refuses to start when month-to-date spend is over the budget', async () => {
    const { config, deps } = world({ spend: [{ amount: '20.50' }, { amount: '4.60' }] });
    await expect(livePreflight(config, deps)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', message: expect.stringMatching(/25\.10.*25/) });
  });

  it('refuses a cost it cannot read as USD', async () => {
    const { config, deps } = world({ spend: [{ amount: '1', unit: 'EUR' }] });
    await expect(livePreflight(config, deps)).rejects.toThrow(/USD/);
    const garbled = world({ spend: [{ amount: 'n/a' }] });
    await expect(livePreflight(garbled.config, garbled.deps)).rejects.toThrow(/amount/);
  });

  it('asks Cost Explorer for this month, through the first of the next, by the injected clock', async () => {
    const { ce, config, deps } = world({ now: Date.UTC(2026, 11, 31, 23, 0, 0) });
    await livePreflight(config, deps);
    expect(ce.requests[0]).toMatchObject({
      TimePeriod: { Start: '2026-12-01', End: '2027-01-01' },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    });
  });
});

describe('test-run tagging and the instance allow-list', () => {
  it('a run id carries its start time, which the sweeper reads back', () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const id = newTestRunId(now, 'deadbeef');
    expect(id).toBe(`r${now / 1000}-deadbeef`);
    expect(testRunStartedAt(id)).toBe(now);
    expect(newTestRunId(now)).toMatch(/^r\d{10}-[0-9a-f]{8}$/);
    for (const bad of ['', 'r123-deadbeef', `r${now / 1000}-DEADBEEF`, `x${now / 1000}-deadbeef`, `r${now / 1000}-deadbeef-x`])
      expect(testRunStartedAt(bad), bad).toBeUndefined();
  });

  it('tags resources with the run and the managed marker', () => {
    expect(liveTags('r1-x')).toEqual([
      { Key: testRunTagKey, Value: 'r1-x' },
      { Key: 'better-compute:managed', Value: 'true' },
    ]);
  });

  it('launches only the allow-listed instance types', () => {
    expect(assertLiveInstanceType('t4g.nano')).toBe('t4g.nano');
    expect(assertLiveInstanceType('t3.micro')).toBe('t3.micro');
    for (const type of ['p5.48xlarge', 't3.small', 'T3.MICRO', ''])
      expect(() => assertLiveInstanceType(type), type).toThrow(/allow-list/);
  });
});

describe('liveEc2Fetch', () => {
  // Wraps the fetch a provider under test gets: it refuses EC2 calls that could cost more than the
  // allow-list before they are sent, and reports what each create made so the run can tag it.
  const form = (action: string, params: Record<string, string> = {}) =>
    new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString();
  const ec2Url = 'https://ec2.us-east-1.amazonaws.com/';

  function guarded(answer = '<Response/>', status = 200) {
    const sent: string[] = [];
    const created: { kind: string; id: string }[][] = [];
    const base: typeof fetch = async (_input, init) => {
      sent.push(String(init?.body));
      return new Response(answer, { status, headers: { 'content-type': 'text/xml' } });
    };
    const guardedFetch = liveEc2Fetch(base, async (items) => {
      created.push(items);
    });
    const post = (body: string | Uint8Array, url = ec2Url) => guardedFetch(url, { method: 'POST', body: body as BodyInit });
    // A refusal is EC2's own 403 UnauthorizedOperation, so a provider sees a final ACCESS_DENIED.
    const refused = async (body: string | Uint8Array): Promise<string> => {
      const response = await post(body);
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain('<Code>UnauthorizedOperation</Code>');
      return text;
    };
    return { sent, created, post, refused };
  }

  it('refuses instance types off the allow-list, and more than one instance, before sending', async () => {
    const { sent, refused } = guarded();
    await expect(refused(form('RunInstances', { InstanceType: 'p5.48xlarge', MinCount: '1', MaxCount: '1' }))).resolves.toMatch(/allow-list/);
    await expect(refused(form('RunInstances', { MinCount: '1', MaxCount: '1' }))).resolves.toMatch(/allow-list/);
    await expect(refused(form('RunInstances', { InstanceType: 't3.micro', MinCount: '1', MaxCount: '3' }))).resolves.toMatch(/one instance/);
    await expect(refused(form('ModifyInstanceAttribute', { 'InstanceType.Value': 'm7i.large' }))).resolves.toMatch(/allow-list/);
    await expect(refused(new TextEncoder().encode(form('RunInstances', { InstanceType: 'c7g.large', MinCount: '1', MaxCount: '1' })))).resolves.toMatch(/allow-list/);
    expect(sent).toEqual([]);
  });

  it('refuses purchases, hosts, reservations, NAT gateways and fleets outright', async () => {
    const { sent, refused } = guarded();
    for (const action of [
      'PurchaseReservedInstancesOffering',
      'PurchaseCapacityBlock',
      'AllocateHosts',
      'CreateCapacityReservation',
      'CreateNatGateway',
      'CreateFleet',
      'RequestSpotFleet',
      'RequestSpotInstances',
    ])
      await expect(refused(form(action)), action).resolves.toMatch(/live suite never calls EC2/);
    expect(sent).toEqual([]);
  });

  it('passes allowed calls and other services through untouched', async () => {
    const { sent, post } = guarded();
    await post(form('RunInstances', { InstanceType: 't4g.nano', MinCount: '1', MaxCount: '1' }));
    await post(form('DescribeInstances'));
    await post(new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15' }).toString(), 'https://sts.us-east-1.amazonaws.com/');
    await post('{"QueueUrl":"x"}', 'https://sqs.us-east-1.amazonaws.com/');
    expect(sent).toHaveLength(4);
  });

  it('refuses an EC2 request whose body it cannot read as a 2016-11-15 query form', async () => {
    const { sent, refused, post } = guarded();
    const p5 = form('RunInstances', { InstanceType: 'p5.48xlarge', MinCount: '1', MaxCount: '1' });
    // Every body shape it can read is checked like a string.
    await expect(refused(new TextEncoder().encode(p5).buffer as unknown as Uint8Array)).resolves.toMatch(/allow-list/);
    await expect(refused(new URLSearchParams(p5) as unknown as string)).resolves.toMatch(/allow-list/);
    const request = new Request(ec2Url, { method: 'POST', body: p5 });
    const viaRequest = await liveEc2Fetch(async () => new Response('<Response/>'), async () => {})(request);
    expect(viaRequest.status).toBe(403);
    // What it cannot read, it refuses when it goes to EC2.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(p5));
        controller.close();
      },
    });
    await expect(refused(stream as unknown as string)).resolves.toMatch(/cannot read/);
    await expect(refused('{"Action":"RunInstances"}')).resolves.toMatch(/cannot read/);
    await expect(refused(new URLSearchParams({ Action: 'RunInstances', Version: '2014-10-01' }).toString())).resolves.toMatch(/cannot read/);
    const dualStack = await post(p5, 'https://ec2.us-east-1.api.aws/');
    expect(dualStack.status).toBe(403);
    expect(sent).toEqual([]);
    // Other services are not EC2's business.
    await post(new Blob(['x']) as unknown as string, 'https://my-bucket.s3.us-east-1.amazonaws.com/key');
    expect(sent).toHaveLength(1);
  });

  it('allows only the EC2 actions the provider needs', async () => {
    const { sent, refused, post } = guarded();
    for (const action of ['CreateTransitGateway', 'CreateVpnGateway', 'CreateVpnConnection', 'CreateClientVpnEndpoint', 'CreateTrafficMirrorSession', 'ModifyHosts', 'CreateNatGateway'])
      await expect(refused(form(action)), action).resolves.toMatch(/live suite never calls EC2/);
    expect(sent).toEqual([]);
    for (const action of ['DescribeInstances', 'DescribeSpotPriceHistory', 'GetConsoleOutput', 'CreateVpc', 'DeleteVpc', 'CreateTags', 'AuthorizeSecurityGroupIngress', 'TerminateInstances', 'AllocateAddress'])
      expect((await post(form(action))).status, action).toBe(200);
    expect(sent).toHaveLength(9);
  });

  it('caps volume sizes, IOPS, throughput and types', async () => {
    const { sent, refused, post } = guarded();
    await expect(refused(form('CreateVolume', { Size: '17', AvailabilityZone: 'us-east-1a' }))).resolves.toMatch(/GiB/);
    await expect(refused(form('CreateVolume', { SnapshotId: 'snap-1', AvailabilityZone: 'us-east-1a' }))).resolves.toMatch(/Size/);
    await expect(refused(form('CreateVolume', { Size: '8', VolumeType: 'io2', Iops: '3000' }))).resolves.toMatch(/volume type/);
    await expect(refused(form('CreateVolume', { Size: '8', VolumeType: 'gp3', Iops: '16000' }))).resolves.toMatch(/IOPS/);
    await expect(refused(form('CreateVolume', { Size: '8', VolumeType: 'gp3', Throughput: '1000' }))).resolves.toMatch(/throughput/);
    await expect(refused(form('ModifyVolume', { VolumeId: 'vol-1', Size: '100' }))).resolves.toMatch(/GiB/);
    await expect(
      refused(form('RunInstances', { InstanceType: 't4g.nano', MinCount: '1', MaxCount: '1', 'BlockDeviceMapping.1.Ebs.VolumeSize': '500' })),
    ).resolves.toMatch(/GiB/);
    await expect(
      refused(form('RunInstances', { InstanceType: 't4g.nano', MinCount: '1', MaxCount: '1', 'BlockDeviceMapping.1.Ebs.VolumeType': 'io2' })),
    ).resolves.toMatch(/volume type/);
    expect(sent).toEqual([]);
    expect((await post(form('CreateVolume', { Size: '8', VolumeType: 'gp3', Iops: '3000', Throughput: '125' }))).status).toBe(200);
    expect((await post(form('RunInstances', { InstanceType: 't3.micro', MinCount: '1', MaxCount: '1', 'BlockDeviceMapping.1.Ebs.VolumeSize': '8' }))).status).toBe(200);
  });

  it('refuses dedicated tenancy, dedicated hosts and launch templates it cannot see into', async () => {
    // A t3.micro on dedicated tenancy passes the instance allow-list but incurs the per-region dedicated fee.
    const { sent, refused, post } = guarded();
    const launch = { InstanceType: 't3.micro', MinCount: '1', MaxCount: '1' };
    await expect(refused(form('RunInstances', { ...launch, 'Placement.Tenancy': 'dedicated' }))).resolves.toMatch(/tenancy/);
    await expect(refused(form('RunInstances', { ...launch, 'Placement.Tenancy': 'host' }))).resolves.toMatch(/tenancy/);
    await expect(refused(form('RunInstances', { ...launch, 'Placement.HostId': 'h-0123456789abcdef0' }))).resolves.toMatch(/host/);
    await expect(refused(form('RunInstances', { ...launch, 'Placement.HostResourceGroupArn': 'arn:aws:resource-groups:us-east-1:1:group/x' }))).resolves.toMatch(/host/);
    await expect(refused(form('RunInstances', { ...launch, 'Placement.Affinity': 'host' }))).resolves.toMatch(/host/);
    // A VPC with dedicated instance tenancy makes every instance in it dedicated.
    await expect(refused(form('CreateVpc', { CidrBlock: '10.0.0.0/16', InstanceTenancy: 'dedicated' }))).resolves.toMatch(/tenancy/);
    // A launch template's tenancy is not in the request, so a launch from one is refused.
    await expect(refused(form('RunInstances', { ...launch, 'LaunchTemplate.LaunchTemplateId': 'lt-0123456789abcdef0' }))).resolves.toMatch(/launch template/);
    expect(sent).toEqual([]);
    expect((await post(form('RunInstances', { ...launch, 'Placement.Tenancy': 'default', 'Placement.AvailabilityZone': 'us-east-1a' }))).status).toBe(200);
    expect((await post(form('CreateVpc', { CidrBlock: '10.0.0.0/16', InstanceTenancy: 'default' }))).status).toBe(200);
  });

  it('caps the launches of a run, across every fetch that shares its budget', async () => {
    const sent: string[] = [];
    const base: typeof fetch = async (_input, init) => {
      sent.push(String(init?.body));
      return new Response('<Response/>');
    };
    const budget = { launches: 2 };
    const one = liveEc2Fetch(base, async () => {}, budget);
    const two = liveEc2Fetch(base, async () => {}, budget);
    const launch = form('RunInstances', { InstanceType: 't4g.nano', MinCount: '1', MaxCount: '1' });
    expect((await one(ec2Url, { method: 'POST', body: launch })).status).toBe(200);
    expect((await two(ec2Url, { method: 'POST', body: launch })).status).toBe(200);
    const third = await one(ec2Url, { method: 'POST', body: launch });
    expect(third.status).toBe(403);
    expect(await third.text()).toMatch(/launches/);
    expect(sent).toHaveLength(2);
    expect(liveMaxLaunches).toBeGreaterThan(0);
  });

  it('reports the instances RunInstances made, not the VPC, subnet or groups it names', async () => {
    const { created, post } = guarded(
      '<RunInstancesResponse><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><subnetId>subnet-0aaaaaaaaaaaaaaaa</subnetId><vpcId>vpc-0bbbbbbbbbbbbbbbb</vpcId><groupSet><item><groupId>sg-0cccccccccccccccc</groupId></item></groupSet></item></instancesSet></RunInstancesResponse>',
    );
    await post(form('RunInstances', { InstanceType: 't3.micro', MinCount: '1', MaxCount: '1' }));
    expect(created).toEqual([[{ kind: 'instance', id: 'i-0123456789abcdef0' }]]);
  });

  it('reports networking and volume creates', async () => {
    const cases: [string, string, { kind: string; id: string }][] = [
      ['CreateVpc', '<CreateVpcResponse><vpc><vpcId>vpc-01</vpcId><dhcpOptionsId>dopt-1</dhcpOptionsId></vpc></CreateVpcResponse>', { kind: 'vpc', id: 'vpc-01' }],
      ['CreateSubnet', '<CreateSubnetResponse><subnet><subnetId>subnet-01</subnetId><vpcId>vpc-01</vpcId></subnet></CreateSubnetResponse>', { kind: 'subnet', id: 'subnet-01' }],
      ['CreateSecurityGroup', '<CreateSecurityGroupResponse><return>true</return><groupId>sg-01</groupId></CreateSecurityGroupResponse>', { kind: 'security-group', id: 'sg-01' }],
      ['CreateInternetGateway', '<CreateInternetGatewayResponse><internetGateway><internetGatewayId>igw-01</internetGatewayId></internetGateway></CreateInternetGatewayResponse>', { kind: 'internet-gateway', id: 'igw-01' }],
      ['CreateRouteTable', '<CreateRouteTableResponse><routeTable><routeTableId>rtb-01</routeTableId><vpcId>vpc-01</vpcId></routeTable></CreateRouteTableResponse>', { kind: 'route-table', id: 'rtb-01' }],
      ['CreateNetworkAcl', '<CreateNetworkAclResponse><networkAcl><networkAclId>acl-01</networkAclId><vpcId>vpc-01</vpcId></networkAcl></CreateNetworkAclResponse>', { kind: 'network-acl', id: 'acl-01' }],
      ['CreateVolume', '<CreateVolumeResponse><volumeId>vol-01</volumeId></CreateVolumeResponse>', { kind: 'volume', id: 'vol-01' }],
      ['CreateVpcEndpoint', '<CreateVpcEndpointResponse><vpcEndpoint><vpcEndpointId>vpce-01</vpcEndpointId><vpcId>vpc-01</vpcId></vpcEndpoint></CreateVpcEndpointResponse>', { kind: 'vpc-endpoint', id: 'vpce-01' }],
      ['AllocateAddress', '<AllocateAddressResponse><publicIp>192.0.2.1</publicIp><allocationId>eipalloc-01</allocationId></AllocateAddressResponse>', { kind: 'elastic-ip', id: 'eipalloc-01' }],
      // Snapshots and key pairs a run makes are tagged and cleaned up like everything else.
      ['CreateSnapshot', '<CreateSnapshotResponse><snapshotId>snap-01</snapshotId><volumeId>vol-01</volumeId><status>pending</status></CreateSnapshotResponse>', { kind: 'snapshot', id: 'snap-01' }],
      ['CreateKeyPair', '<CreateKeyPairResponse><keyName>live</keyName><keyFingerprint>aa:bb</keyFingerprint><keyMaterial>not-a-real-key</keyMaterial><keyPairId>key-01</keyPairId></CreateKeyPairResponse>', { kind: 'key-pair', id: 'key-01' }],
      ['ImportKeyPair', '<ImportKeyPairResponse><keyName>live</keyName><keyFingerprint>aa:bb</keyFingerprint><keyPairId>key-02</keyPairId></ImportKeyPairResponse>', { kind: 'key-pair', id: 'key-02' }],
    ];
    for (const [action, answer, expected] of cases) {
      const { created, post } = guarded(answer);
      await post(form(action, action === 'CreateVolume' ? { Size: '8' } : {}));
      expect(created, action).toEqual([[expected]]);
    }
  });

  it('reports nothing for a failed create', async () => {
    const { created, post } = guarded('<Response><Errors><Error><Code>VpcLimitExceeded</Code></Error></Errors></Response>', 400);
    const response = await post(form('CreateVpc'));
    expect(response.status).toBe(400);
    expect(created).toEqual([]);
  });
});
