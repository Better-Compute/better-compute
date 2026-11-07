// The live-suite sweeper (A12): finds every resource tagged `better-compute:test-run` through the
// Resource Groups Tagging API and deletes those of runs older than two hours, in dependency order.
// It refuses any account but the pinned sandbox, lists without deleting unless `apply` is set, and
// leaves anything it cannot place (young runs, unreadable tags, other accounts, unknown types)
// alone with a reason. A delete that fails because something still depends on the resource is
// `pending`: the next pass (the sweeper runs on a schedule) retries it.
//
// S3 ARNs name no account, so every S3 request carries x-amz-expected-bucket-owner set to the
// sandbox account: S3 itself then refuses (403) to touch a bucket any other account owns.
import { createHash } from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import { parseXml, serializeEc2Query, type QueryParams, type XmlElement } from '@better-compute/aws-core';
import { createTransport, jsonClient, queryClient, serviceEndpoint, type Transport } from '../../../../packages/aws/src/internal/transport.js';
import { liveIdentity, sweepAfterMs, testRunStartedAt, testRunTagKey, type LiveConfig, type LiveDeps } from './live.js';

export interface SweepOptions {
  config: LiveConfig;
  deps?: LiveDeps;
  /** Delete; without it the sweep only reports `wouldDelete`. */
  apply?: boolean;
  /** Default two hours. */
  olderThanMs?: number;
}

export interface SweepReport {
  /** Tagged resources found. */
  found: number;
  deleted: string[];
  /** Dry run: what an applied sweep would try, in order. */
  wouldDelete: string[];
  /** Deletes that failed, to retry on the next pass. */
  pending: { arn: string; reason: string }[];
  /** Left alone. */
  skipped: { arn: string; reason: string }[];
}

interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

function parseArn(text: string): Arn | undefined {
  const parts = text.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return undefined;
  const [, partition, service, region, account] = parts as [string, string, string, string, string];
  return { partition, service, region, account, resource: parts.slice(5).join(':') };
}

interface Clients {
  ec2(action: string, params: QueryParams): Promise<XmlElement>;
  json(service: 'sqs' | 'events' | 'secretsmanager' | 'logs' | 'kms', operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  query(service: 'sns' | 'cloudformation', action: string, params: QueryParams): Promise<XmlElement>;
  /** A bucket-level S3 request as the sandbox account (x-amz-expected-bucket-owner). */
  s3(input: {
    method: 'GET' | 'POST' | 'DELETE';
    bucket: string;
    operation: string;
    query: Record<string, string>;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<XmlElement | undefined>;
  /** FIS (rest-json). */
  fis(method: 'DELETE', path: string, operation: string): Promise<void>;
}

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`);

/** One DeleteObjects call takes at most this many keys. */
const deleteObjectsMax = 1000;

/** Deletes every object version and delete marker of a bucket, a page at a time, then the bucket. */
async function emptyAndDeleteBucket(c: Clients, bucket: string): Promise<void> {
  let marker: { key: string; versionId: string } | undefined;
  for (let page = 0; page < 10_000; page++) {
    const listed = await c.s3({
      method: 'GET',
      bucket,
      operation: 'ListObjectVersions',
      query: {
        versions: '',
        'max-keys': String(deleteObjectsMax),
        ...(marker ? { 'key-marker': marker.key, 'version-id-marker': marker.versionId } : {}),
      },
    });
    const objects = [...(listed?.all('Version') ?? []), ...(listed?.all('DeleteMarker') ?? [])].map((entry) => ({
      key: entry.textOf('Key') ?? '',
      versionId: entry.textOf('VersionId') ?? '',
    }));
    if (objects.length > 0) {
      const body = `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objects
        .map((object) => `<Object><Key>${escapeXml(object.key)}</Key><VersionId>${escapeXml(object.versionId)}</VersionId></Object>`)
        .join('')}</Delete>`;
      const result = await c.s3({
        method: 'POST',
        bucket,
        operation: 'DeleteObjects',
        query: { delete: '' },
        body,
        // DeleteObjects requires an integrity header.
        headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body, 'utf8').digest('base64') },
      });
      const failed = result?.all('Error') ?? [];
      if (failed.length > 0)
        throw new ComputeError('PROVIDER_ERROR', `S3 kept ${failed.length} object version(s) of the bucket`, undefined, {
          code: failed[0]!.textOf('Code') ?? 'DeleteObjects',
        });
    }
    if (listed?.textOf('IsTruncated') !== 'true') break;
    const key = listed.textOf('NextKeyMarker');
    if (key === undefined) break;
    marker = { key, versionId: listed.textOf('NextVersionIdMarker') ?? '' };
  }
  await c.s3({ method: 'DELETE', bucket, operation: 'DeleteBucket', query: {} });
}

/** A resource type the sweeper knows: its rank (lower deletes first) and how to delete it. */
interface Deleter {
  rank: number;
  remove(clients: Clients, arn: Arn, text: string): Promise<void>;
}

const ec2Deleters: Record<string, Deleter> = {
  instance: { rank: 1, remove: (c, a) => c.ec2('TerminateInstances', { InstanceId: [id(a)] }).then(() => {}) },
  volume: { rank: 2, remove: (c, a) => c.ec2('DeleteVolume', { VolumeId: id(a) }).then(() => {}) },
  snapshot: { rank: 2, remove: (c, a) => c.ec2('DeleteSnapshot', { SnapshotId: id(a) }).then(() => {}) },
  'key-pair': { rank: 2, remove: (c, a) => c.ec2('DeleteKeyPair', { KeyPairId: id(a) }).then(() => {}) },
  'elastic-ip': { rank: 2, remove: (c, a) => c.ec2('ReleaseAddress', { AllocationId: id(a) }).then(() => {}) },
  'security-group': { rank: 3, remove: (c, a) => c.ec2('DeleteSecurityGroup', { GroupId: id(a) }).then(() => {}) },
  'internet-gateway': {
    rank: 4,
    async remove(c, a) {
      const gateway = id(a);
      const described = await c.ec2('DescribeInternetGateways', { InternetGatewayId: [gateway] });
      for (const item of described.items('internetGatewaySet'))
        for (const attachment of item.items('attachmentSet')) {
          const vpcId = attachment.textOf('vpcId');
          if (vpcId) await c.ec2('DetachInternetGateway', { InternetGatewayId: gateway, VpcId: vpcId });
        }
      await c.ec2('DeleteInternetGateway', { InternetGatewayId: gateway });
    },
  },
  // A gateway endpoint holds routes in the VPC's route tables. DeleteVpcEndpoints answers 200 and lists
  // what it could not delete in `unsuccessful`.
  'vpc-endpoint': {
    rank: 4,
    async remove(c, a) {
      const answer = await c.ec2('DeleteVpcEndpoints', { VpcEndpointId: [id(a)] });
      for (const item of answer.items('unsuccessful')) {
        const error = item.child('error');
        const code = error?.textOf('code') ?? 'Unknown';
        throw new ComputeError(code.endsWith('.NotFound') ? 'NOT_FOUND' : 'PROVIDER_ERROR', `DeleteVpcEndpoints: ${error?.textOf('message') ?? code}`, undefined, { code });
      }
    },
  },
  // A subnet's route table and network ACL associations go with it.
  subnet: { rank: 5, remove: (c, a) => c.ec2('DeleteSubnet', { SubnetId: id(a) }).then(() => {}) },
  'route-table': { rank: 6, remove: (c, a) => c.ec2('DeleteRouteTable', { RouteTableId: id(a) }).then(() => {}) },
  'network-acl': { rank: 7, remove: (c, a) => c.ec2('DeleteNetworkAcl', { NetworkAclId: id(a) }).then(() => {}) },
  vpc: { rank: 8, remove: (c, a) => c.ec2('DeleteVpc', { VpcId: id(a) }).then(() => {}) },
};

const serviceDeleters: Record<string, (arn: Arn) => Deleter | undefined> = {
  ec2: (arn) => ec2Deleters[arn.resource.split('/')[0]!],
  cloudformation: (arn) =>
    arn.resource.startsWith('stack/')
      ? { rank: 0, remove: (c, _a, text) => c.query('cloudformation', 'DeleteStack', { StackName: text }).then(() => {}) }
      : undefined,
  // An S3 ARN is `arn:aws:s3:::<bucket>`; the Tagging API lists buckets, never objects.
  s3: (arn) =>
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(arn.resource) ? { rank: 2, remove: (c, a) => emptyAndDeleteBucket(c, a.resource) } : undefined,
  fis: (arn) =>
    /^experiment-template\/[A-Za-z0-9]{1,64}$/.test(arn.resource)
      ? { rank: 2, remove: (c, a) => c.fis('DELETE', `/experimentTemplates/${encodeURIComponent(id(a))}`, 'DeleteExperimentTemplate') }
      : undefined,
  sqs: () => ({
    rank: 2,
    remove: (c, a) =>
      c.json('sqs', 'DeleteQueue', { QueueUrl: `https://sqs.${a.region}.amazonaws.com${a.partition === 'aws-cn' ? '.cn' : ''}/${a.account}/${a.resource}` }).then(() => {}),
  }),
  sns: () => ({ rank: 2, remove: (c, _a, text) => c.query('sns', 'DeleteTopic', { TopicArn: text }).then(() => {}) }),
  events: (arn) => {
    // A bus goes after its rules: EventBridge refuses to delete a bus that still has rules.
    if (/^event-bus\/[A-Za-z0-9._-]{1,256}$/.test(arn.resource) && arn.resource !== 'event-bus/default')
      return { rank: 3, remove: (c, a) => c.json('events', 'DeleteEventBus', { Name: id(a) }).then(() => {}) };
    if (!arn.resource.startsWith('rule/')) return undefined;
    const path = arn.resource.slice('rule/'.length).split('/');
    const rule = path.at(-1)!;
    const bus = path.length > 1 ? path[0] : undefined;
    return {
      rank: 2,
      async remove(c) {
        const where = { Rule: rule, ...(bus ? { EventBusName: bus } : {}) };
        const listed = (await c.json('events', 'ListTargetsByRule', where)) as { Targets?: { Id: string }[] };
        const ids = (listed.Targets ?? []).map((target) => target.Id);
        if (ids.length > 0) await c.json('events', 'RemoveTargets', { ...where, Ids: ids, Force: true });
        await c.json('events', 'DeleteRule', { Name: rule, ...(bus ? { EventBusName: bus } : {}), Force: true });
      },
    };
  },
  secretsmanager: () => ({
    rank: 2,
    remove: (c, _a, text) => c.json('secretsmanager', 'DeleteSecret', { SecretId: text, ForceDeleteWithoutRecovery: true }).then(() => {}),
  }),
  logs: (arn) =>
    arn.resource.startsWith('log-group:')
      ? {
          rank: 2,
          remove: (c, a) => c.json('logs', 'DeleteLogGroup', { logGroupName: a.resource.slice('log-group:'.length).replace(/:\*$/, '') }).then(() => {}),
        }
      : undefined,
  kms: (arn) =>
    arn.resource.startsWith('key/')
      ? {
          rank: 2,
          async remove(c, _a, text) {
            try {
              await c.json('kms', 'ScheduleKeyDeletion', { KeyId: text, PendingWindowInDays: 7 });
            } catch (error) {
              // An earlier pass already scheduled it: the key stays listed until its window ends.
              if (error instanceof ComputeError && error.details?.code === 'KMSInvalidStateException') return;
              throw error;
            }
          },
        }
      : undefined,
};

function id(arn: Arn): string {
  return arn.resource.split('/').at(-1)!;
}

const jsonTargets = {
  sqs: { jsonVersion: '1.0', targetPrefix: 'AmazonSQS' },
  events: { jsonVersion: '1.1', targetPrefix: 'AWSEvents' },
  secretsmanager: { jsonVersion: '1.1', targetPrefix: 'secretsmanager' },
  logs: { jsonVersion: '1.1', targetPrefix: 'Logs_20140328' },
  kms: { jsonVersion: '1.1', targetPrefix: 'TrentService' },
} as const;

/** The S3 URL of a bucket: virtual-hosted on AWS, path-style for an endpoint override or a dotted name (TLS). */
export function bucketUrl(transport: Transport, bucket: string, query: Readonly<Record<string, string>> = {}): URL {
  const base = serviceEndpoint('s3', transport.region, transport.endpointOverride);
  const url =
    transport.endpointOverride !== undefined || bucket.includes('.')
      ? new URL(`${base.origin}/${bucket}/`)
      : new URL(`${base.protocol}//${bucket}.${base.host}/`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

function clients(transport: Transport, account: string): Clients {
  // EC2 speaks its own query flavour (`Name.N` lists), so it gets a request of its own.
  const ec2Url = serviceEndpoint('ec2', transport.region, transport.endpointOverride);
  return {
    async ec2(action, params) {
      const response = await transport.send({
        method: 'POST',
        url: ec2Url,
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: serializeEc2Query(action, '2016-11-15', params),
        service: 'ec2',
        operation: action,
        protocol: 'query',
      });
      return parseXml(await response.text());
    },
    json(service, operation, body) {
      const target = jsonTargets[service];
      return jsonClient(transport, { hostPrefix: service, jsonVersion: target.jsonVersion, targetPrefix: target.targetPrefix }).call(operation, body);
    },
    query(service, action, params) {
      return queryClient(transport, { hostPrefix: service, version: service === 'sns' ? '2010-03-31' : '2010-05-15' }).call(action, params);
    },
    async s3(input) {
      const response = await transport.send({
        method: input.method,
        url: bucketUrl(transport, input.bucket, input.query),
        headers: { ...(input.headers ?? {}), 'x-amz-expected-bucket-owner': account },
        ...(input.body !== undefined ? { body: input.body } : {}),
        service: 's3',
        operation: input.operation,
        protocol: 'rest-xml',
        s3: true,
      });
      const text = await response.text();
      return text.trim() === '' ? undefined : parseXml(text);
    },
    async fis(method, path, operation) {
      const base = serviceEndpoint('fis', transport.region, transport.endpointOverride);
      const response = await transport.send({ method, url: new URL(path, base), service: 'fis', operation, protocol: 'json' });
      await response.body?.cancel();
    },
  };
}

interface Queued {
  text: string;
  arn: Arn;
  deleter: Deleter;
  order: number;
}

/** The deleter for an ARN of the sandbox account, or why the sweeper leaves it alone. */
function place(text: string, config: LiveConfig): { arn: Arn; deleter: Deleter } | { reason: string } {
  const arn = parseArn(text);
  const deleter = arn ? serviceDeleters[arn.service]?.(arn) : undefined;
  if (!arn || !deleter)
    return { reason: `no sweeper for ${arn ? `${arn.service}:${arn.resource.split(/[/:]/)[0]}` : 'this ARN'}; delete it by hand` };
  // S3 ARNs carry no account; S3 enforces the owner instead (x-amz-expected-bucket-owner). EC2 snapshot
  // ARNs carry none either, and DeleteSnapshot refuses a snapshot the caller's account does not own.
  const accountless = arn.account === '' && (arn.service === 's3' || (arn.service === 'ec2' && arn.resource.startsWith('snapshot/')));
  if (arn.account !== config.account && !accountless)
    return { reason: `belongs to another account (${arn.account || 'none'})` };
  return { arn, deleter };
}

/** Checks the credentials are the sandbox account's and builds the transport. */
async function sandboxTransport(config: LiveConfig, deps: LiveDeps): Promise<Transport> {
  const { account } = await liveIdentity(config, deps);
  if (account !== config.account)
    throw new ComputeError('ACCESS_DENIED', `the credentials are for account ${account}, not the sandbox account ${config.account}`);
  return createTransport({
    region: config.region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
}

interface Failure {
  entry: Queued;
  code: string;
  reason: string;
}

const inRankOrder = (queue: readonly Queued[]) => [...queue].sort((a, b) => a.deleter.rank - b.deleter.rank || a.order - b.order);

/** Deletes `queue` in rank order; one already gone counts as deleted. Returns what failed. */
async function attemptDeletes(api: Clients, queue: readonly Queued[], deleted: string[]): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const entry of inRankOrder(queue)) {
    try {
      await entry.deleter.remove(api, entry.arn, entry.text);
      deleted.push(entry.text);
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'NOT_FOUND') {
        deleted.push(entry.text);
        continue;
      }
      const code = error instanceof ComputeError ? String(error.details?.code ?? error.code) : 'error';
      failures.push({ entry, code, reason: `${code}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` });
    }
  }
  return failures;
}

/** Deletes `queue` in rank order; one already gone counts as deleted, one that fails is pending. */
async function runDeletes(api: Clients, queue: Queued[], report: Pick<SweepReport, 'deleted' | 'pending'>): Promise<void> {
  for (const failure of await attemptDeletes(api, queue, report.deleted)) report.pending.push({ arn: failure.entry.text, reason: failure.reason });
}

/** Codes that mean "still in use": the delete can succeed once whatever holds the resource is gone. */
const stillInUse = new Set([
  'DependencyViolation',
  'InvalidGroup.InUse',
  'InvalidIPAddress.InUse',
  'VolumeInUse',
  'IncorrectState',
  'ResourceInUse',
  'ResourceInUseException',
]);

/** How long a live file's cleanup waits for terminations and in-use resources before leaving them to the sweeper. */
export const cleanUpSettleMs = 5 * 60_000;
const cleanUpPollMs = 10_000;

/**
 * Polls DescribeInstances until every instance is `terminated` (or gone), or until the deadline.
 * TerminateInstances returns while instances are still shutting-down and holding their network
 * interfaces. Any other answer stops the wait; the in-use retries still cover what follows.
 */
async function untilTerminated(api: Clients, ids: readonly string[], wait: { deadline: number; pollMs: number; clock: Clock; sleep: (ms: number) => Promise<void> }) {
  for (;;) {
    let running: number;
    try {
      const described = await api.ec2('DescribeInstances', { InstanceId: [...ids] });
      running = described
        .items('reservationSet')
        .flatMap((reservation) => reservation.items('instancesSet'))
        .filter((instance) => instance.child('instanceState')?.textOf('name') !== 'terminated').length;
    } catch {
      return;
    }
    if (running === 0 || wait.clock.now() + wait.pollMs > wait.deadline) return;
    await wait.sleep(wait.pollMs);
  }
}

/** One sweep pass over the sandbox account's test-run resources. */
export async function sweepTestRuns(options: SweepOptions): Promise<SweepReport> {
  const { config } = options;
  const deps = options.deps ?? {};
  const olderThanMs = options.olderThanMs ?? sweepAfterMs;
  const transport = await sandboxTransport(config, deps);
  const now = (deps.clock ?? systemClock).now();
  const tagging = jsonClient(transport, { hostPrefix: 'tagging', jsonVersion: '1.1', targetPrefix: 'ResourceGroupsTaggingAPI_20170126' });

  const report: SweepReport = { found: 0, deleted: [], wouldDelete: [], pending: [], skipped: [] };
  const queue: Queued[] = [];
  let token = '';
  for (let page = 0; page < 1000; page++) {
    const response = await tagging.call<{
      ResourceTagMappingList?: { ResourceARN: string; Tags?: { Key: string; Value: string }[] }[];
      PaginationToken?: string;
    }>('GetResources', { TagFilters: [{ Key: testRunTagKey }], ResourcesPerPage: 100, ...(token ? { PaginationToken: token } : {}) });
    for (const mapping of response.ResourceTagMappingList ?? []) {
      report.found += 1;
      const text = mapping.ResourceARN;
      const run = mapping.Tags?.find((tag) => tag.Key === testRunTagKey)?.Value ?? '';
      const placed = place(text, config);
      if ('reason' in placed) {
        report.skipped.push({ arn: text, reason: placed.reason });
        continue;
      }
      const started = testRunStartedAt(run);
      if (started === undefined) {
        report.skipped.push({ arn: text, reason: `${JSON.stringify(run.slice(0, 40))} is not a test-run id` });
        continue;
      }
      if (now - started < olderThanMs) {
        report.skipped.push({ arn: text, reason: `its run is younger than ${Math.round(olderThanMs / 60_000)} minutes` });
        continue;
      }
      queue.push({ text, ...placed, order: queue.length });
    }
    token = response.PaginationToken ?? '';
    if (!token) break;
  }

  if (!options.apply) {
    report.wouldDelete = [...queue].sort((a, b) => a.deleter.rank - b.deleter.rank || a.order - b.order).map((entry) => entry.text);
    return report;
  }
  await runDeletes(clients(transport, config.account), queue, report);
  return report;
}

/**
 * A live file's `afterAll`: deletes the resources it created, by ARN, right away (the Tagging API
 * lags by minutes, so a fresh resource may not be listed yet), with the sweeper's deleters, order
 * and account rules. Unlike one sweep pass, it waits (up to `settleMs`, default five minutes) for
 * the instances it terminated to reach `terminated` before deleting the security groups, addresses,
 * subnets and VPCs their network interfaces hold, and retries a delete that is still in use
 * (DependencyViolation and the like) every `pollMs` until then. What it cannot delete stays tagged
 * for the scheduled sweep.
 */
export async function deleteLiveResources(options: {
  config: LiveConfig;
  deps?: LiveDeps;
  arns: readonly string[];
  settleMs?: number;
  pollMs?: number;
}): Promise<Pick<SweepReport, 'deleted' | 'pending' | 'skipped'>> {
  const deps = options.deps ?? {};
  const transport = await sandboxTransport(options.config, deps);
  const report: Pick<SweepReport, 'deleted' | 'pending' | 'skipped'> = { deleted: [], pending: [], skipped: [] };
  const queue: Queued[] = [];
  for (const text of options.arns) {
    const placed = place(text, options.config);
    if ('reason' in placed) report.skipped.push({ arn: text, reason: placed.reason });
    else queue.push({ text, ...placed, order: queue.length });
  }
  const api = clients(transport, options.config.account);
  const clock = deps.clock ?? systemClock;
  const wait = {
    deadline: clock.now() + (options.settleMs ?? cleanUpSettleMs),
    pollMs: options.pollMs ?? cleanUpPollMs,
    clock,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };

  // Stacks and instances first; then wait for the instances to let go of their network interfaces.
  const instanceRank = ec2Deleters.instance!.rank;
  const isInstance = (entry: Queued) => entry.arn.service === 'ec2' && entry.arn.resource.startsWith('instance/');
  const first = queue.filter((entry) => entry.deleter.rank <= instanceRank);
  const rest = queue.filter((entry) => entry.deleter.rank > instanceRank);
  const failures = await attemptDeletes(api, first, report.deleted);
  const terminating = first.filter((entry) => isInstance(entry) && report.deleted.includes(entry.text)).map((entry) => id(entry.arn));
  if (terminating.length > 0 && rest.length > 0) await untilTerminated(api, terminating, wait);
  failures.push(...(await attemptDeletes(api, rest, report.deleted)));

  // Whatever is still in use gets retried, in rank order, until the deadline.
  let retry = failures.filter((failure) => stillInUse.has(failure.code));
  const final = failures.filter((failure) => !stillInUse.has(failure.code));
  while (retry.length > 0 && clock.now() + wait.pollMs <= wait.deadline) {
    await wait.sleep(wait.pollMs);
    const again = await attemptDeletes(
      api,
      retry.map((failure) => failure.entry),
      report.deleted,
    );
    final.push(...again.filter((failure) => !stillInUse.has(failure.code)));
    retry = again.filter((failure) => stillInUse.has(failure.code));
  }
  const left = [...final, ...retry].sort((a, b) => a.entry.deleter.rank - b.entry.deleter.rank || a.entry.order - b.entry.order);
  for (const failure of left) report.pending.push({ arn: failure.entry.text, reason: failure.reason });
  return report;
}
