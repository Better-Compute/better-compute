// Fixtures a live file creates for itself (A12): an S3 bucket, SQS queues, an EventBridge bus and
// rule, and tags on what an adapter created. Every one carries the run's `liveTags`, and its ARN is
// recorded the moment it exists (before tagging), so `cleanUp` deletes it in `afterAll` even when a
// later step fails; what `cleanUp` cannot delete stays tagged for scripts/aws-live-sweep.mjs.
// tests/aws-live-resources.test.ts pins the requests on the emulator.
import { createHash, randomUUID } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import { parseXml, serializeEc2Query, type QueryParams, type XmlElement } from '@better-compute/aws-core';
import { createTransport, jsonClient, serviceEndpoint, type Transport } from '../../../../packages/aws/src/internal/transport.js';
import { liveEc2Fetch, liveMaxLaunches, liveTags, type LiveConfig, type LiveCreated, type LiveDeps } from './live.js';
import { bucketUrl, deleteLiveResources, type SweepReport } from './sweep.js';

type JsonService = 'sqs' | 'events' | 'secretsmanager';

const jsonTargets = {
  sqs: { jsonVersion: '1.0', targetPrefix: 'AmazonSQS' },
  events: { jsonVersion: '1.1', targetPrefix: 'AWSEvents' },
  secretsmanager: { jsonVersion: '1.1', targetPrefix: 'secretsmanager' },
} as const;

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`);

export interface LiveQueue {
  url: string;
  arn: string;
}

export interface LiveMessage {
  body: string;
  attributes: Record<string, string>;
}

export interface LiveAws {
  readonly config: LiveConfig;
  readonly runId: string;
  readonly transport: Transport;
  /** ARNs created so far, in creation order. */
  readonly created: readonly string[];
  /** Records a resource made some other way (an adapter's), for `cleanUp`. */
  track(arn: string): void;
  json<T = Record<string, unknown>>(service: JsonService, operation: string, body: Record<string, unknown>): Promise<T>;
  /** A general-purpose bucket in the run's region, tagged. */
  createBucket(name: string): Promise<string>;
  createQueue(name: string): Promise<LiveQueue>;
  /** Lets EventBridge send to `queue`, only from `ruleArn`. */
  allowEventBridge(queue: LiveQueue, ruleArn: string): Promise<void>;
  createBus(name: string): Promise<string>;
  /** A rule on `bus` matching `pattern`, targeting `targetArn`. */
  createRule(bus: string, name: string, pattern: Record<string, unknown>, targetArn: string): Promise<string>;
  /** Tags a secret an adapter created and records its ARN. */
  tagSecret(secretId: string): Promise<string>;
  /** Long-polls `queue` until a message satisfies `match`, deleting what it reads. */
  receive(queue: LiveQueue, match: (message: LiveMessage) => boolean, timeoutMs: number): Promise<LiveMessage>;
  /** A raw EC2 query call (the run's own checks and fixtures). */
  ec2(action: string, params: QueryParams): Promise<XmlElement>;
  /**
   * The fetch to give a provider under test: `liveEc2Fetch`'s checks, and every EC2 resource it
   * creates is recorded at once and then tagged with the run's tags (retried while EC2 catches up).
   */
  ec2Fetch(base?: typeof fetch): typeof fetch;
  /**
   * A FIS experiment template that sends a Spot interruption (two minutes' notice) to one
   * instance, run as `roleArn` (made by hand: FIS needs ec2:SendSpotInstanceInterruptions).
   * Returns the template id; the template is tagged and recorded.
   */
  createSpotInterruptionTemplate(instanceArn: string, roleArn: string): Promise<string>;
  /** Starts an experiment from a template (experiments cannot be deleted, so they are not tagged). */
  startExperiment(templateId: string): Promise<string>;
  /** Created resources the run could not tag (they are still recorded for `cleanUp`). */
  readonly untagged: readonly string[];
  /** Deletes everything recorded, dependency order. */
  cleanUp(): Promise<Pick<SweepReport, 'deleted' | 'pending' | 'skipped'>>;
}

export interface LiveAwsDeps extends LiveDeps {
  /** Wait between CreateTags attempts on a just-created resource (default 2000 ms). */
  tagRetryMs?: number;
}

const partitionOf = (region: string) => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');

export function liveAws(config: LiveConfig, runId: string, deps: LiveAwsDeps = {}): LiveAws {
  const transport = createTransport({
    region: config.region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
  const created: string[] = [];
  // One launch budget for the whole run, however many provider fetches it hands out.
  const launchBudget = { launches: liveMaxLaunches };
  const tags = liveTags(runId);
  const tagMap = Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]));
  const track = (arn: string) => {
    if (!created.includes(arn)) created.push(arn);
  };
  const json = <T>(service: JsonService, operation: string, body: Record<string, unknown>) =>
    jsonClient(transport, { hostPrefix: service, ...jsonTargets[service] }).call<T>(operation, body);
  const untagged: string[] = [];
  const tagRetryMs = deps.tagRetryMs ?? 2_000;
  const ec2Url = serviceEndpoint('ec2', transport.region, transport.endpointOverride);

  async function ec2(action: string, params: QueryParams): Promise<XmlElement> {
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
  }

  /** FIS is rest-json: POST a JSON body to a path. */
  async function fis<T>(path: string, operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await transport.send({
      method: 'POST',
      url: new URL(path, serviceEndpoint('fis', transport.region, transport.endpointOverride)),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      service: 'fis',
      operation,
      protocol: 'json',
    });
    return (await response.json()) as T;
  }

  /** Tags what a create made; EC2 may not see a fresh id yet, so NotFound is retried a few times. */
  async function tagCreated(created: LiveCreated[]): Promise<void> {
    const arns = created.map((item) => `arn:${partitionOf(config.region)}:ec2:${config.region}:${config.account}:${item.kind}/${item.id}`);
    for (const arn of arns) track(arn);
    for (let attempt = 1; ; attempt++) {
      try {
        await ec2('CreateTags', { ResourceId: created.map((item) => item.id), Tag: tags });
        return;
      } catch (error) {
        if (attempt < 5 && error instanceof ComputeError && error.code === 'NOT_FOUND') {
          await new Promise<void>((resolve) => setTimeout(resolve, tagRetryMs));
          continue;
        }
        // The resource is still recorded for cleanUp; the run reports it as untagged.
        untagged.push(...arns);
        return;
      }
    }
  }

  async function s3(method: 'PUT', bucket: string, operation: string, query: Record<string, string>, body?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/xml';
      // PutBucketTagging requires an integrity header; it costs nothing on CreateBucket.
      headers['content-md5'] = createHash('md5').update(body, 'utf8').digest('base64');
    }
    const response = await transport.send({
      method,
      url: bucketUrl(transport, bucket, query),
      headers,
      ...(body !== undefined ? { body } : {}),
      service: 's3',
      operation,
      protocol: 'rest-xml',
      s3: true,
    });
    await response.body?.cancel();
  }

  return {
    config,
    runId,
    transport,
    created,
    track,
    json,

    async createBucket(name) {
      const configuration =
        config.region === 'us-east-1'
          ? undefined
          : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(config.region)}</LocationConstraint></CreateBucketConfiguration>`;
      await s3('PUT', name, 'CreateBucket', {}, configuration);
      const arn = `arn:${partitionOf(config.region)}:s3:::${name}`;
      track(arn);
      await s3(
        'PUT',
        name,
        'PutBucketTagging',
        { tagging: '' },
        `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tags
          .map((tag) => `<Tag><Key>${escapeXml(tag.Key)}</Key><Value>${escapeXml(tag.Value)}</Value></Tag>`)
          .join('')}</TagSet></Tagging>`,
      );
      return arn;
    },

    async createQueue(name) {
      // SQS tags at creation (lower-case `tags` in the JSON protocol), so the queue is never untagged.
      const { QueueUrl } = await json<{ QueueUrl?: string }>('sqs', 'CreateQueue', { QueueName: name, tags: tagMap });
      if (!QueueUrl) throw new ComputeError('PROVIDER_ERROR', 'CreateQueue returned no QueueUrl');
      const { Attributes } = await json<{ Attributes?: { QueueArn?: string } }>('sqs', 'GetQueueAttributes', {
        QueueUrl,
        AttributeNames: ['QueueArn'],
      });
      const arn = Attributes?.QueueArn;
      if (!arn) throw new ComputeError('PROVIDER_ERROR', 'GetQueueAttributes returned no QueueArn');
      track(arn);
      return { url: QueueUrl, arn };
    },

    async allowEventBridge(queue, ruleArn) {
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'EventBridgeRule',
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: queue.arn,
            Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } },
          },
        ],
      };
      await json('sqs', 'SetQueueAttributes', { QueueUrl: queue.url, Attributes: { Policy: JSON.stringify(policy) } });
    },

    async createBus(name) {
      const { EventBusArn } = await json<{ EventBusArn?: string }>('events', 'CreateEventBus', { Name: name, Tags: tags });
      if (!EventBusArn) throw new ComputeError('PROVIDER_ERROR', 'CreateEventBus returned no EventBusArn');
      track(EventBusArn);
      return EventBusArn;
    },

    async createRule(bus, name, pattern, targetArn) {
      const { RuleArn } = await json<{ RuleArn?: string }>('events', 'PutRule', {
        Name: name,
        EventBusName: bus,
        EventPattern: JSON.stringify(pattern),
        State: 'ENABLED',
        Tags: tags,
      });
      if (!RuleArn) throw new ComputeError('PROVIDER_ERROR', 'PutRule returned no RuleArn');
      track(RuleArn);
      const result = await json<{ FailedEntryCount?: number; FailedEntries?: { ErrorCode?: string }[] }>('events', 'PutTargets', {
        Rule: name,
        EventBusName: bus,
        Targets: [{ Id: 'live-target', Arn: targetArn }],
      });
      if ((result.FailedEntryCount ?? 0) > 0)
        throw new ComputeError('PROVIDER_ERROR', `PutTargets failed: ${String(result.FailedEntries?.[0]?.ErrorCode ?? 'unknown')}`);
      return RuleArn;
    },

    async tagSecret(secretId) {
      const { ARN } = await json<{ ARN?: string }>('secretsmanager', 'DescribeSecret', { SecretId: secretId });
      if (!ARN) throw new ComputeError('PROVIDER_ERROR', 'DescribeSecret returned no ARN');
      track(ARN);
      await json('secretsmanager', 'TagResource', { SecretId: ARN, Tags: tags });
      return ARN;
    },

    async receive(queue, match, timeoutMs) {
      const deadline = transport.clock.now() + timeoutMs;
      for (;;) {
        const { Messages } = await json<{
          Messages?: { Body?: string; ReceiptHandle?: string; MessageAttributes?: Record<string, { StringValue?: string }> }[];
        }>('sqs', 'ReceiveMessage', {
          QueueUrl: queue.url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 10,
          MessageAttributeNames: ['All'],
        });
        for (const message of Messages ?? []) {
          if (message.ReceiptHandle) await json('sqs', 'DeleteMessage', { QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle });
          const read: LiveMessage = {
            body: message.Body ?? '',
            attributes: Object.fromEntries(
              Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [name, value.StringValue ?? '']),
            ),
          };
          if (match(read)) return read;
        }
        if (transport.clock.now() >= deadline)
          throw new ComputeError('UNAVAILABLE', `no matching message on the queue within ${Math.round(timeoutMs / 1000)} s`);
      }
    },

    ec2,
    ec2Fetch: (base = deps.fetch ?? fetch) => liveEc2Fetch(base, tagCreated, launchBudget),

    async createSpotInterruptionTemplate(instanceArn, roleArn) {
      if (!/^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(roleArn))
        throw new ComputeError('INVALID_CONFIG', 'the FIS role is not an IAM role ARN');
      if (!/^arn:aws[\w-]*:ec2:[a-z0-9-]+:\d{12}:instance\/i-[0-9a-f]{8,17}$/.test(instanceArn))
        throw new ComputeError('INVALID_INPUT', 'not an EC2 instance ARN');
      const { experimentTemplate } = await fis<{ experimentTemplate?: { id?: string } }>('/experimentTemplates', 'CreateExperimentTemplate', {
        clientToken: randomUUID(),
        description: `better-compute live ${runId}: Spot interruption`,
        roleArn,
        stopConditions: [{ source: 'none' }],
        targets: { spot: { resourceType: 'aws:ec2:spot-instance', resourceArns: [instanceArn], selectionMode: 'ALL' } },
        actions: {
          interrupt: {
            actionId: 'aws:ec2:send-spot-instance-interruptions',
            parameters: { durationBeforeInterruption: 'PT2M' },
            targets: { SpotInstances: 'spot' },
          },
        },
        tags: tagMap,
      });
      const id = experimentTemplate?.id;
      if (!id) throw new ComputeError('PROVIDER_ERROR', 'CreateExperimentTemplate returned no id');
      track(`arn:${partitionOf(config.region)}:fis:${config.region}:${config.account}:experiment-template/${id}`);
      return id;
    },

    async startExperiment(templateId) {
      const { experiment } = await fis<{ experiment?: { id?: string } }>('/experiments', 'StartExperiment', {
        clientToken: randomUUID(),
        experimentTemplateId: templateId,
      });
      if (!experiment?.id) throw new ComputeError('PROVIDER_ERROR', 'StartExperiment returned no id');
      return experiment.id;
    },
    untagged,

    cleanUp: () => deleteLiveResources({ config, deps, arns: created }),
  };
}
