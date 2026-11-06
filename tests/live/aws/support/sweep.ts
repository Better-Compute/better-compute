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
import { ComputeError, systemClock } from '@better-compute/core';
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
      // Virtual-hosted on AWS; path-style for an endpoint override and for dotted names (TLS).
      const base = serviceEndpoint('s3', transport.region, transport.endpointOverride);
      const url =
        transport.endpointOverride !== undefined || input.bucket.includes('.')
          ? new URL(`${base.origin}/${input.bucket}/`)
          : new URL(`${base.protocol}//${input.bucket}.${base.host}/`);
      for (const [name, value] of Object.entries(input.query)) url.searchParams.set(name, value);
      const response = await transport.send({
        method: input.method,
        url,
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

/** One sweep pass over the sandbox account's test-run resources. */
export async function sweepTestRuns(options: SweepOptions): Promise<SweepReport> {
  const { config } = options;
  const deps = options.deps ?? {};
  const olderThanMs = options.olderThanMs ?? sweepAfterMs;
  const { account } = await liveIdentity(config, deps);
  if (account !== config.account)
    throw new ComputeError('ACCESS_DENIED', `the credentials are for account ${account}, not the sandbox account ${config.account}`);
  const transport = createTransport({
    region: config.region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
  const now = (deps.clock ?? systemClock).now();
  const tagging = jsonClient(transport, { hostPrefix: 'tagging', jsonVersion: '1.1', targetPrefix: 'ResourceGroupsTaggingAPI_20170126' });

  const report: SweepReport = { found: 0, deleted: [], wouldDelete: [], pending: [], skipped: [] };
  const queue: { text: string; arn: Arn; deleter: Deleter; order: number }[] = [];
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
      const arn = parseArn(text);
      const deleter = arn ? serviceDeleters[arn.service]?.(arn) : undefined;
      if (!arn || !deleter) {
        report.skipped.push({ arn: text, reason: `no sweeper for ${arn ? `${arn.service}:${arn.resource.split(/[/:]/)[0]}` : 'this ARN'}; delete it by hand` });
        continue;
      }
      // S3 ARNs carry no account; S3 enforces the owner instead (x-amz-expected-bucket-owner).
      if (arn.account !== config.account && !(arn.service === 's3' && arn.account === '')) {
        report.skipped.push({ arn: text, reason: `belongs to another account (${arn.account || 'none'})` });
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
      queue.push({ text, arn, deleter, order: queue.length });
    }
    token = response.PaginationToken ?? '';
    if (!token) break;
  }

  queue.sort((a, b) => a.deleter.rank - b.deleter.rank || a.order - b.order);
  if (!options.apply) {
    report.wouldDelete = queue.map((entry) => entry.text);
    return report;
  }
  const api = clients(transport, config.account);
  for (const entry of queue) {
    try {
      await entry.deleter.remove(api, entry.arn, entry.text);
      report.deleted.push(entry.text);
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'NOT_FOUND') {
        report.deleted.push(entry.text);
        continue;
      }
      const code = error instanceof ComputeError ? String(error.details?.code ?? error.code) : 'error';
      report.pending.push({ arn: entry.text, reason: `${code}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` });
    }
  }
  return report;
}
