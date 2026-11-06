// The AWS live suite's guards (A12). The suite runs only with BETTER_COMPUTE_AWS_LIVE=1, a pinned
// sandbox account id and a month-to-date budget; `livePreflight` then refuses credentials of any
// other account and refuses to start over budget. Every resource carries a test-run tag whose
// value holds its start time, so `scripts/aws-live-sweep.mjs` can delete what a crashed run left.
// tests/aws-live-guards.test.ts pins all of it on the emulator.
import { randomBytes } from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import { envCredentialSource } from '@better-compute/aws';
import { parseXml, type XmlElement } from '@better-compute/aws-core';
import {
  assertRegion,
  createTransport,
  jsonClient,
  queryClient,
  type CredentialSource,
} from '../../../../packages/aws/src/internal/transport.js';

/** Every resource a live run creates carries this tag; its value is the run id. */
export const testRunTagKey = 'better-compute:test-run';
/** Instance types a live run may launch. */
export const liveInstanceTypes = ['t4g.nano', 't3.micro'] as const;
/** The sweeper deletes resources of runs older than this. */
export const sweepAfterMs = 2 * 60 * 60_000;

export interface LiveConfig {
  region: string;
  /** The sandbox account id; the credentials must belong to it. */
  account: string;
  /** Refuse to start once Cost Explorer's month-to-date unblended cost is over this. */
  budgetUsd: number;
  credentials: CredentialSource;
}

export type LiveGate = { enabled: true; config: LiveConfig } | { enabled: false; reason: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Off unless BETTER_COMPUTE_AWS_LIVE is exactly `1`. Once on, a missing or malformed setting is an
 * INVALID_CONFIG error rather than a skip, so a misconfigured run fails visibly before any call.
 */
export function liveGate(env: Env = process.env): LiveGate {
  if (env.BETTER_COMPUTE_AWS_LIVE !== '1') return { enabled: false, reason: 'BETTER_COMPUTE_AWS_LIVE is not 1' };
  const account = env.BETTER_COMPUTE_AWS_LIVE_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account))
    throw new ComputeError('INVALID_CONFIG', 'BETTER_COMPUTE_AWS_LIVE_ACCOUNT must be the 12-digit sandbox account id');
  const budgetText = env.BETTER_COMPUTE_AWS_LIVE_BUDGET_USD;
  const budgetUsd = budgetText === undefined || budgetText.trim() === '' ? Number.NaN : Number(budgetText);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw new ComputeError('INVALID_CONFIG', 'BETTER_COMPUTE_AWS_LIVE_BUDGET_USD must be a positive number of US dollars');
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
    throw new ComputeError(
      'INVALID_CONFIG',
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must hold the sandbox credentials (aws configure export-credentials --profile <sandbox> --format env)',
    );
  const region = env.BETTER_COMPUTE_AWS_LIVE_REGION || env.AWS_REGION || 'us-east-1';
  assertRegion(region);
  return { enabled: true, config: { region, account, budgetUsd, credentials: envCredentialSource(env) } };
}

/** Test hooks: an emulator's fetch and clock, and its endpoint. */
export interface LiveDeps {
  fetch?: typeof fetch;
  clock?: Clock;
  endpoint?: string;
  /** How cleanup waits between polls (default a timer); tests advance `clock` instead. */
  sleep?: (ms: number) => Promise<void>;
}

function transport(config: LiveConfig, deps: LiveDeps, region = config.region) {
  return createTransport({
    region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
}

/** The account and ARN of the credentials (STS GetCallerIdentity). */
export async function liveIdentity(config: LiveConfig, deps: LiveDeps = {}): Promise<{ account: string; arn: string }> {
  const sts = queryClient(transport(config, deps), { hostPrefix: 'sts', version: '2011-06-15' });
  const root = await sts.call('GetCallerIdentity', {});
  const result = root.child('GetCallerIdentityResult');
  const account = result?.textOf('Account');
  const arn = result?.textOf('Arn');
  if (!account || !arn) throw new ComputeError('PROVIDER_ERROR', 'GetCallerIdentity returned no account');
  return { account, arn };
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Cost Explorer month-to-date unblended cost in USD (this month through the first of the next). */
export async function monthToDateSpendUsd(config: LiveConfig, deps: LiveDeps = {}): Promise<number> {
  const now = (deps.clock ?? systemClock).now();
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  // Cost Explorer has one endpoint, in us-east-1, for the commercial partition.
  const ce = jsonClient(transport(config, deps, 'us-east-1'), { hostPrefix: 'ce', jsonVersion: '1.1', targetPrefix: 'AWSInsightsIndexService' });
  let total = 0;
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await ce.call<{
      ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string; Unit?: string } } }[];
      NextPageToken?: string;
    }>('GetCostAndUsage', {
      TimePeriod: { Start: day(start), End: day(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      ...(token ? { NextPageToken: token } : {}),
    });
    for (const result of response.ResultsByTime ?? []) {
      const cost = result.Total?.UnblendedCost;
      if (!cost) continue;
      if (cost.Unit !== 'USD') throw new ComputeError('PROVIDER_ERROR', `Cost Explorer answered in ${String(cost.Unit)}, not USD`);
      const amount = Number(cost.Amount);
      if (!Number.isFinite(amount)) throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer returned an unreadable amount');
      total += amount;
    }
    token = response.NextPageToken;
    if (!token) return Math.round(total * 100) / 100;
  }
  throw new ComputeError('PROVIDER_ERROR', 'Cost Explorer kept paginating');
}

/**
 * Runs before a live suite creates anything: the credentials must be the sandbox account's, and
 * the month-to-date spend must be within the budget (Cost Explorer lags by up to a day).
 */
export async function livePreflight(config: LiveConfig, deps: LiveDeps = {}): Promise<{ account: string; monthToDateUsd: number }> {
  const { account } = await liveIdentity(config, deps);
  if (account !== config.account)
    throw new ComputeError('ACCESS_DENIED', `the credentials are for account ${account}, not the sandbox account ${config.account}`);
  const monthToDateUsd = await monthToDateSpendUsd(config, deps);
  if (monthToDateUsd > config.budgetUsd)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `the sandbox account has spent ${monthToDateUsd.toFixed(2)} USD this month, over the live-suite budget of ${config.budgetUsd} USD`,
    );
  return { account, monthToDateUsd };
}

/** `r<unix seconds>-<8 hex>`: the run's start time is in its id. */
export function newTestRunId(now: number = Date.now(), suffix: string = randomBytes(4).toString('hex')): string {
  return `r${Math.floor(now / 1000)}-${suffix}`;
}

/** The start time (epoch ms) of a run id, or undefined for anything that is not one. */
export function testRunStartedAt(value: string): number | undefined {
  const match = /^r(\d{10})-[0-9a-f]{8}$/.exec(value);
  return match ? Number(match[1]) * 1000 : undefined;
}

/** The tags of every resource a live run creates. */
export function liveTags(runId: string): { Key: string; Value: string }[] {
  return [
    { Key: testRunTagKey, Value: runId },
    { Key: 'better-compute:managed', Value: 'true' },
  ];
}

export function assertLiveInstanceType(type: string): string {
  if (!(liveInstanceTypes as readonly string[]).includes(type))
    throw new ComputeError('INVALID_INPUT', `${type || '(empty)'} is not on the live-suite allow-list (${liveInstanceTypes.join(', ')})`);
  return type;
}

/** What an EC2 create made, as the resource type of its ARN (`arn:…:ec2:…:<kind>/<id>`). */
export interface LiveCreated {
  kind:
    | 'instance'
    | 'vpc'
    | 'subnet'
    | 'security-group'
    | 'internet-gateway'
    | 'route-table'
    | 'network-acl'
    | 'vpc-endpoint'
    | 'volume'
    | 'elastic-ip';
  id: string;
}

/**
 * The EC2 actions a live run may send: reads, and the mutations provider-aws makes on instances,
 * VPC networking, addresses, volumes and tags. Anything else (purchases, dedicated hosts,
 * reservations, NAT gateways, fleets, transit gateways, VPNs, Client VPN, …) is refused, so a new
 * costly action fails closed until it is added here on purpose.
 */
const allowedEc2Actions = new Set([
  'RunInstances',
  'TerminateInstances',
  'StartInstances',
  'StopInstances',
  'RebootInstances',
  'ModifyInstanceAttribute',
  'ModifyInstanceMetadataOptions',
  'CreateReplaceRootVolumeTask',
  'CreateTags',
  'DeleteTags',
  'CreateKeyPair',
  'ImportKeyPair',
  'DeleteKeyPair',
  'CreateVpc',
  'DeleteVpc',
  'ModifyVpcAttribute',
  'AssociateVpcCidrBlock',
  'DisassociateVpcCidrBlock',
  'CreateSubnet',
  'DeleteSubnet',
  'ModifySubnetAttribute',
  'CreateSecurityGroup',
  'DeleteSecurityGroup',
  'AuthorizeSecurityGroupIngress',
  'AuthorizeSecurityGroupEgress',
  'RevokeSecurityGroupIngress',
  'RevokeSecurityGroupEgress',
  'ModifySecurityGroupRules',
  'CreateInternetGateway',
  'DeleteInternetGateway',
  'AttachInternetGateway',
  'DetachInternetGateway',
  'CreateRouteTable',
  'DeleteRouteTable',
  'AssociateRouteTable',
  'DisassociateRouteTable',
  'ReplaceRouteTableAssociation',
  'CreateRoute',
  'DeleteRoute',
  'ReplaceRoute',
  'CreateNetworkAcl',
  'DeleteNetworkAcl',
  'CreateNetworkAclEntry',
  'DeleteNetworkAclEntry',
  'ReplaceNetworkAclEntry',
  'ReplaceNetworkAclAssociation',
  'CreateVpcEndpoint',
  'DeleteVpcEndpoints',
  'ModifyVpcEndpoint',
  'ModifyNetworkInterfaceAttribute',
  'DeleteNetworkInterface',
  'AllocateAddress',
  'ReleaseAddress',
  'AssociateAddress',
  'DisassociateAddress',
  'CreateVolume',
  'DeleteVolume',
  'AttachVolume',
  'DetachVolume',
  'ModifyVolume',
  'CreateSnapshot',
  'DeleteSnapshot',
]);
const readEc2Action = /^(Describe|Get)[A-Z]\w*$/;
// Purchases and the like are refused even when they look like reads (none do today; this keeps it so).
const refusedEc2Action = /^(Purchase|AllocateHosts|CreateCapacityReservation|CreateNatGateway|CreateFleet|RequestSpot)/;

/** Launches one live run may send (every RunInstances attempt counts). */
export const liveMaxLaunches = 20;

/** EBS limits a live run stays within: gp3 baseline performance, small volumes. */
export const liveVolumeLimits = { maxGiB: 16, maxIops: 3000, maxThroughput: 125, types: ['gp3', 'gp2'] } as const;

/** How each EC2 create names the resource it made (never the ones it merely refers to). */
const createdBy: Record<string, (root: XmlElement) => LiveCreated[]> = {
  RunInstances: (root) =>
    root.items('instancesSet').flatMap((item) => {
      const id = item.textOf('instanceId');
      return id ? [{ kind: 'instance' as const, id }] : [];
    }),
  CreateVpc: (root) => one('vpc', root.child('vpc')?.textOf('vpcId')),
  CreateSubnet: (root) => one('subnet', root.child('subnet')?.textOf('subnetId')),
  CreateSecurityGroup: (root) => one('security-group', root.textOf('groupId')),
  CreateInternetGateway: (root) => one('internet-gateway', root.child('internetGateway')?.textOf('internetGatewayId')),
  CreateRouteTable: (root) => one('route-table', root.child('routeTable')?.textOf('routeTableId')),
  CreateNetworkAcl: (root) => one('network-acl', root.child('networkAcl')?.textOf('networkAclId')),
  // provider-aws (A2) adds S3 and DynamoDB gateway endpoints for a subnet's private service access.
  CreateVpcEndpoint: (root) => one('vpc-endpoint', root.child('vpcEndpoint')?.textOf('vpcEndpointId')),
  CreateVolume: (root) => one('volume', root.textOf('volumeId')),
  AllocateAddress: (root) => one('elastic-ip', root.textOf('allocationId')),
};

function one(kind: LiveCreated['kind'], id: string | undefined): LiveCreated[] {
  return id ? [{ kind, id }] : [];
}

/** The guard's answer to a call it refuses: EC2's own error shape, 403 UnauthorizedOperation. */
function refusal(message: string): Response {
  const escaped = message.replace(/[<>&]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp' }[c]};`);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>live suite guard: ${escaped}</Message></Error></Errors><RequestID>live-guard</RequestID></Response>`,
    { status: 403, headers: { 'content-type': 'text/xml;charset=UTF-8' } },
  );
}

/** The text of a request body, or undefined for one it cannot read without consuming it (a stream, a Blob, FormData). */
function bodyText(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return undefined;
}

function formOf(text: string | undefined): URLSearchParams | undefined {
  if (text === undefined || !text.startsWith('Action=')) return undefined;
  return new URLSearchParams(text);
}

/** An EC2 endpoint: `ec2.<region>.amazonaws.com`, `ec2-fips.…`, dual-stack `ec2.<region>.api.aws`, or a VPC endpoint of it. */
function isEc2Host(input: RequestInfo | URL): boolean {
  let host: string;
  try {
    host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname;
  } catch {
    return false;
  }
  return /(^|\.)ec2(-fips)?\.[a-z0-9-]+\.(amazonaws\.com(\.cn)?|api\.aws)$/.test(host);
}

function checkVolumes(action: string, params: URLSearchParams): void {
  const limits = liveVolumeLimits;
  const number = (key: string, value: string) => {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new ComputeError('INVALID_INPUT', `${key} is not a whole number`);
    return parsed;
  };
  for (const [key, value] of params) {
    if (/(^|\.)(Size|VolumeSize)$/.test(key) && number(key, value) > limits.maxGiB)
      throw new ComputeError('INVALID_INPUT', `${key}=${value}: a live run's volumes are at most ${limits.maxGiB} GiB`);
    if (/(^|\.)Iops$/.test(key) && number(key, value) > limits.maxIops)
      throw new ComputeError('INVALID_INPUT', `${key}=${value}: a live run stays within ${limits.maxIops} IOPS`);
    if (/(^|\.)Throughput$/.test(key) && number(key, value) > limits.maxThroughput)
      throw new ComputeError('INVALID_INPUT', `${key}=${value}: a live run stays within ${limits.maxThroughput} MiB/s throughput`);
    if (/(^|\.)VolumeType$/.test(key) && !(limits.types as readonly string[]).includes(value))
      throw new ComputeError('INVALID_INPUT', `${key}=${value}: a live run uses only the ${limits.types.join(' or ')} volume type`);
  }
  // A volume from a snapshot alone takes the snapshot's size, whatever it is.
  if (action === 'CreateVolume' && !params.has('Size')) throw new ComputeError('INVALID_INPUT', 'a live run names the Size of every volume it creates');
}

/**
 * The fetch a provider under test gets in a live run. It fails closed: a request to an EC2 host
 * whose body is not a readable 2016-11-15 query form is refused, and so is any action off the
 * allow-list (reads, and the instance, network, address, volume and tag mutations provider-aws
 * makes). Instance types must be on the instance allow-list (every `…InstanceType` parameter),
 * RunInstances launches exactly one instance and at most `budget.launches` per run (shared by every
 * fetch that is given the same budget), and volumes stay within `liveVolumeLimits`. After a
 * successful create, `onCreated` hears what it made, so the run can tag it and delete it. Request
 * bodies are signed, so they are read, never changed.
 */
export function liveEc2Fetch(
  base: typeof fetch,
  onCreated: (created: LiveCreated[]) => Promise<void>,
  budget: { launches: number } = { launches: liveMaxLaunches },
): typeof fetch {
  return async (input, init) => {
    const ec2Host = isEc2Host(input);
    let text = bodyText(init?.body);
    // A Request carries its own body; reading a clone leaves it to send.
    if (init?.body === undefined && typeof input === 'object' && input instanceof Request) text = await input.clone().text();
    const params = formOf(text);
    const action = params?.get('Action') ?? '';
    const isEc2Form = params?.get('Version') === '2016-11-15';
    if (!ec2Host && !isEc2Form) return base(input, init);
    try {
      if (!params || !isEc2Form)
        throw new ComputeError('ACCESS_DENIED', 'the live suite guard cannot read this EC2 request as a 2016-11-15 query form');
      if (refusedEc2Action.test(action) || !(allowedEc2Actions.has(action) || readEc2Action.test(action)))
        throw new ComputeError('ACCESS_DENIED', `the live suite never calls EC2 ${action}`);
      for (const [key, value] of params) if (/(^|\.)InstanceType(\.Value)?$/.test(key)) assertLiveInstanceType(value);
      checkVolumes(action, params);
      if (action === 'RunInstances') {
        assertLiveInstanceType(params.get('InstanceType') ?? '');
        if (params.get('MinCount') !== '1' || params.get('MaxCount') !== '1')
          throw new ComputeError('INVALID_INPUT', 'a live run launches one instance at a time');
        if (budget.launches <= 0) throw new ComputeError('QUOTA_EXCEEDED', 'the live run has used all its launches');
        budget.launches -= 1;
      }
    } catch (error) {
      if (!(error instanceof ComputeError)) throw error;
      // Answered as EC2 would refuse it, so the provider sees a final ACCESS_DENIED rather than a
      // network error it would retry. Nothing was sent.
      return refusal(error.message);
    }
    const response = await base(input, init);
    const read = createdBy[action];
    if (read && response.ok) {
      const created = read(parseXml(await response.clone().text()));
      if (created.length > 0) await onCreated(created);
    }
    return response;
  };
}
