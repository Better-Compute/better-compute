import {
  ComputeError,
  defineSink,
  type AuditRecord,
  type AuditSink,
  type ComputeEvent,
  type EventSink,
} from '@better-compute/core';
import { transportFor, type AwsServiceOptions } from './common.js';
import { deliverInChunks } from './internal/batches.js';
import { jsonClient, type JsonClient } from './internal/transport.js';

const KiB = 1024;
const MiB = 1024 * KiB;

export interface KinesisSinkOptions extends AwsServiceOptions {
  id?: string;
  /** One of streamName or streamArn. */
  streamName?: string;
  streamArn?: string;
  /** The partition key: the event's tenant (default) or subject. */
  partitionKey?: 'tenant' | 'subject';
}

/** PutRecords: one JSON line per event, partitioned by tenant or subject; 500 records / 5 MiB per call. */
export function kinesisSink(options: KinesisSinkOptions): EventSink {
  if ((options.streamName === undefined) === (options.streamArn === undefined))
    throw new ComputeError('INVALID_CONFIG', 'kinesisSink takes one of streamName or streamArn');
  if (options.streamName !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(options.streamName))
    throw new ComputeError('INVALID_CONFIG', 'not a Kinesis stream name');
  if (options.streamArn !== undefined && !/^arn:aws(-cn|-us-gov)?:kinesis:[a-z0-9-]+:\d{12}:stream\/[A-Za-z0-9_.-]{1,128}$/.test(options.streamArn))
    throw new ComputeError('INVALID_CONFIG', 'not a Kinesis stream ARN');
  const by = options.partitionKey ?? 'tenant';
  if (by !== 'tenant' && by !== 'subject') throw new ComputeError('INVALID_CONFIG', 'partitionKey is tenant or subject');
  const client = jsonClient(transportFor(options), { hostPrefix: 'kinesis', jsonVersion: '1.1', targetPrefix: 'Kinesis_20131202' });
  const target = options.streamName !== undefined ? { StreamName: options.streamName } : { StreamARN: options.streamArn };
  const keyOf = (event: ComputeEvent) => (by === 'tenant' ? event.tenantId : event.subject).slice(0, 256) || '-';
  const dataOf = (event: ComputeEvent) => Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  return defineSink({
    kind: 'events',
    id: options.id ?? 'aws-kinesis',
    deliver: (events) =>
      deliverInChunks(
        'kinesis',
        events,
        { maxCount: 500, maxBytes: 5 * MiB, maxItemBytes: MiB, size: (event) => dataOf(event).length + Buffer.byteLength(keyOf(event)) },
        async (chunk) => {
          const result = await client.call<{ FailedRecordCount?: number; Records?: { ErrorCode?: string }[] }>('PutRecords', {
            ...target,
            Records: chunk.map((event) => ({ Data: dataOf(event).toString('base64'), PartitionKey: keyOf(event) })),
          });
          return perRecordFailures(result.FailedRecordCount, result.Records, chunk.length, 'Kinesis PutRecords');
        },
      ),
  });
}

function perRecordFailures(
  count: number | undefined,
  records: readonly { ErrorCode?: string }[] | undefined,
  sent: number,
  what: string,
): { index: number; code?: string }[] {
  const failed = (records ?? []).flatMap((record, index) => (record.ErrorCode ? [{ index, code: record.ErrorCode }] : []));
  if ((count ?? 0) > 0 && failed.length === 0) return Array.from({ length: sent }, (_, index) => ({ index, code: 'unknown' }));
  if ((records?.length ?? 0) !== sent && failed.length === 0)
    throw new ComputeError('PROVIDER_ERROR', `${what} returned ${records?.length ?? 0} results for ${sent} records`);
  return failed;
}

export interface FirehoseSinkOptions extends AwsServiceOptions {
  id?: string;
  deliveryStreamName: string;
}

function firehose(options: FirehoseSinkOptions): JsonClient {
  if (typeof options.deliveryStreamName !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(options.deliveryStreamName))
    throw new ComputeError('INVALID_CONFIG', 'not a Firehose delivery stream name');
  return jsonClient(transportFor(options), { hostPrefix: 'firehose', jsonVersion: '1.1', targetPrefix: 'Firehose_20150804' });
}

/** PutRecordBatch of newline-terminated JSON records (500 records / 4 MiB per call, 1000 KiB each). */
function firehoseDeliver<T extends { id: string }>(client: JsonClient, streamName: string) {
  const dataOf = (item: T) => Buffer.from(`${JSON.stringify(item)}\n`, 'utf8');
  return (items: readonly T[]) =>
    deliverInChunks(
      'firehose',
      items,
      { maxCount: 500, maxBytes: 4 * MiB, maxItemBytes: 1000 * KiB, size: (item) => dataOf(item).length },
      async (chunk) => {
        const result = await client.call<{ FailedPutCount?: number; RequestResponses?: { ErrorCode?: string }[] }>(
          'PutRecordBatch',
          { DeliveryStreamName: streamName, Records: chunk.map((item) => ({ Data: dataOf(item).toString('base64') })) },
        );
        return perRecordFailures(result.FailedPutCount, result.RequestResponses, chunk.length, 'Firehose PutRecordBatch');
      },
    );
}

/** Events into a Firehose delivery stream (to S3, OpenSearch, Splunk, …). */
export function firehoseSink(options: FirehoseSinkOptions): EventSink {
  const deliver = firehoseDeliver<ComputeEvent>(firehose(options), options.deliveryStreamName);
  return defineSink({ kind: 'events', id: options.id ?? 'aws-firehose', deliver });
}

/** Audit records into a Firehose delivery stream (e.g. OpenSearch for audit search). */
export function firehoseAuditSink(options: FirehoseSinkOptions): AuditSink {
  const write = firehoseDeliver<AuditRecord>(firehose(options), options.deliveryStreamName);
  return defineSink({ kind: 'audit', id: options.id ?? 'aws-firehose-audit', write });
}
