import { ComputeError, defineSink, type ComputeEvent, type EventSink } from '@better-compute/core';
import type { QueryParams, QueryValue } from '@better-compute/aws-core';
import { transportFor, type AwsServiceOptions } from './common.js';
import { deliverInChunks } from './internal/batches.js';
import { jsonClient, queryClient } from './internal/transport.js';
import { utf8Bytes } from './secret-refs.js';

const KiB = 1024;
const batchMaxBytes = 256 * KiB;

// --- EventBridge ----------------------------------------------------------------------------------

export interface EventBridgeSinkOptions extends AwsServiceOptions {
  id?: string;
  /** Default 'default'. */
  eventBusName?: string;
  /** Default 'better-compute'. */
  source?: string;
}

/** PutEvents: Source, DetailType = event.type, Detail = the event (its `id` is the dedupe key). */
export function eventBridgeSink(options: EventBridgeSinkOptions): EventSink {
  const busName = options.eventBusName ?? 'default';
  const source = options.source ?? 'better-compute';
  if (!/^[A-Za-z0-9/:_.-]{1,1600}$/.test(busName)) throw new ComputeError('INVALID_CONFIG', 'not an event bus name or ARN');
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(source)) throw new ComputeError('INVALID_CONFIG', 'not an EventBridge source');
  const client = jsonClient(transportFor(options), { hostPrefix: 'events', jsonVersion: '1.1', targetPrefix: 'AWSEvents' });
  const entryOf = (event: ComputeEvent) => {
    const time = Date.parse(event.time);
    return {
      Source: source,
      DetailType: event.type,
      Detail: JSON.stringify(event),
      EventBusName: busName,
      ...(Number.isFinite(time) ? { Time: Math.floor(time / 1000) } : {}),
      Resources: [],
    };
  };
  // AWS counts Source, DetailType, Detail, EventBusName, Resources and 14 bytes for Time.
  const size = (event: ComputeEvent) => {
    const entry = entryOf(event);
    return utf8Bytes(entry.Source) + utf8Bytes(entry.DetailType) + utf8Bytes(entry.Detail) + utf8Bytes(busName) + 14;
  };
  return defineSink({
    kind: 'events',
    id: options.id ?? 'aws-eventbridge',
    deliver: (events) =>
      deliverInChunks('events', events, { maxCount: 10, maxBytes: batchMaxBytes, size }, async (chunk) => {
        const result = await client.call<{ FailedEntryCount?: number; Entries?: { EventId?: string; ErrorCode?: string }[] }>(
          'PutEvents',
          { Entries: chunk.map(entryOf) },
        );
        const entries = result.Entries ?? [];
        const failed = entries.flatMap((entry, index) => (entry.ErrorCode ? [{ index, code: entry.ErrorCode }] : []));
        if ((result.FailedEntryCount ?? 0) > 0 && failed.length === 0)
          // A count without per-entry results: the whole chunk is suspect.
          return chunk.map((_, index) => ({ index, code: 'unknown' }));
        if (entries.length !== chunk.length && failed.length === 0)
          throw new ComputeError('PROVIDER_ERROR', 'EventBridge PutEvents returned a result per entry it did not have');
        return failed;
      }),
  });
}

// --- SNS and SQS -----------------------------------------------------------------------------------

const messageAttributes = (event: ComputeEvent) => ({
  type: event.type,
  tenantId: event.tenantId,
  eventId: event.id,
});

/** Message + attribute names, types and values: what SNS and SQS count against 256 KiB. */
function messageSize(event: ComputeEvent): number {
  let bytes = utf8Bytes(JSON.stringify(event));
  for (const [name, value] of Object.entries(messageAttributes(event)))
    bytes += utf8Bytes(name) + utf8Bytes('String') + utf8Bytes(value);
  return bytes;
}

function fifoIds(fifo: boolean, event: ComputeEvent) {
  return fifo ? { MessageGroupId: event.tenantId, MessageDeduplicationId: event.id.slice(0, 128) } : {};
}

export interface SnsSinkOptions extends AwsServiceOptions {
  id?: string;
  topicArn: string;
}

/** PublishBatch to a topic; FIFO (group = tenant, dedupe id = event id) when the ARN ends in .fifo. */
export function snsSink(options: SnsSinkOptions): EventSink {
  if (typeof options.topicArn !== 'string' || !/^arn:aws(-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(\.fifo)?$/.test(options.topicArn))
    throw new ComputeError('INVALID_CONFIG', 'not an SNS topic ARN');
  const fifo = options.topicArn.endsWith('.fifo');
  const client = queryClient(transportFor(options), { hostPrefix: 'sns', version: '2010-03-31' });
  return defineSink({
    kind: 'events',
    id: options.id ?? 'aws-sns',
    deliver: (events) =>
      deliverInChunks('sns', events, { maxCount: 10, maxBytes: batchMaxBytes, size: messageSize }, async (chunk) => {
        const entries: QueryValue[] = chunk.map((event, index) => {
          const attributes: Record<string, QueryValue> = {};
          Object.entries(messageAttributes(event)).forEach(([name, value], n) => {
            // SNS spells its attribute map entry.N.Name / entry.N.Value.
            attributes[`entry.${n + 1}.Name`] = name;
            attributes[`entry.${n + 1}.Value`] = { DataType: 'String', StringValue: value };
          });
          return { Id: String(index), Message: JSON.stringify(event), MessageAttributes: attributes, ...fifoIds(fifo, event) };
        });
        const params: QueryParams = { TopicArn: options.topicArn, PublishBatchRequestEntries: entries };
        const root = await client.call('PublishBatch', params);
        const result = root.child('PublishBatchResult');
        return (result?.items('Failed') ?? []).map((member) => ({
          index: Number(member.textOf('Id')),
          code: member.textOf('Code'),
        }));
      }),
  });
}

export interface SqsSinkOptions extends AwsServiceOptions {
  id?: string;
  queueUrl: string;
}

/** SendMessageBatch to a queue; FIFO (group = tenant, dedupe id = event id) when the URL ends in .fifo. */
export function sqsSink(options: SqsSinkOptions): EventSink {
  let queue: URL;
  try {
    queue = new URL(options.queueUrl);
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'not an SQS queue URL');
  }
  if (!/^\/\d{12}\/[A-Za-z0-9_-]{1,80}(\.fifo)?$/.test(queue.pathname) || (queue.protocol !== 'https:' && !options.endpoint))
    throw new ComputeError('INVALID_CONFIG', 'not an SQS queue URL');
  const fifo = queue.pathname.endsWith('.fifo');
  const client = jsonClient(transportFor(options), { hostPrefix: 'sqs', jsonVersion: '1.0', targetPrefix: 'AmazonSQS' });
  return defineSink({
    kind: 'events',
    id: options.id ?? 'aws-sqs',
    deliver: (events) =>
      deliverInChunks('sqs', events, { maxCount: 10, maxBytes: batchMaxBytes, size: messageSize }, async (chunk) => {
        const result = await client.call<{ Failed?: { Id: string; Code?: string }[] }>('SendMessageBatch', {
          QueueUrl: options.queueUrl,
          Entries: chunk.map((event, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(event),
            MessageAttributes: Object.fromEntries(
              Object.entries(messageAttributes(event)).map(([name, value]) => [name, { DataType: 'String', StringValue: value }]),
            ),
            ...fifoIds(fifo, event),
          })),
        });
        return (result.Failed ?? []).map((entry) => ({ index: Number(entry.Id), code: entry.Code }));
      }),
  });
}
