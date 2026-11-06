// Fixtures a live file creates for itself (A12): an S3 bucket, SQS queues, an EventBridge bus and
// rule, and tags on what an adapter created. Every one carries the run's `liveTags`, and its ARN is
// recorded the moment it exists (before tagging), so `cleanUp` deletes it in `afterAll` even when a
// later step fails; what `cleanUp` cannot delete stays tagged for scripts/aws-live-sweep.mjs.
// tests/aws-live-resources.test.ts pins the requests on the emulator.
import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import { createTransport, jsonClient, type Transport } from '../../../../packages/aws/src/internal/transport.js';
import { liveTags, type LiveConfig, type LiveDeps } from './live.js';
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
  /** Deletes everything recorded, dependency order. */
  cleanUp(): Promise<Pick<SweepReport, 'deleted' | 'pending' | 'skipped'>>;
}

const partitionOf = (region: string) => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');

export function liveAws(config: LiveConfig, runId: string, deps: LiveDeps = {}): LiveAws {
  const transport = createTransport({
    region: config.region,
    credentials: config.credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
  });
  const created: string[] = [];
  const tags = liveTags(runId);
  const tagMap = Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]));
  const track = (arn: string) => {
    if (!created.includes(arn)) created.push(arn);
  };
  const json = <T>(service: JsonService, operation: string, body: Record<string, unknown>) =>
    jsonClient(transport, { hostPrefix: service, ...jsonTargets[service] }).call<T>(operation, body);

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

    cleanUp: () => deleteLiveResources({ config, deps, arns: created }),
  };
}
