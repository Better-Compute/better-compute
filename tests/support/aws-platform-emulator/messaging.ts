// EventBridge, SNS, SQS, Kinesis and Firehose fakes. Each records what it accepted and can refuse
// entries a test picks (`refuse(entry) → error code | undefined`), as a partial batch failure.
import { AwsEmulator, EmuError, escapeXml, jsonResponse, xmlResponse } from './index.js';

type Refuse = (entry: Record<string, unknown>) => string | undefined;

const json = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;

export function eventBridgeFake(emu: AwsEmulator) {
  const state = { entries: [] as Record<string, unknown>[], batches: [] as number[], refuse: (() => undefined) as Refuse };
  emu.register('events', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'PutEvents') throw new EmuError('UnknownOperationException', request.operation);
      const entries = json(request.body).Entries as Record<string, unknown>[];
      if (entries.length > 10) throw new EmuError('ValidationException', 'too many entries');
      state.batches.push(entries.length);
      let failed = 0;
      const results = entries.map((entry) => {
        const code = state.refuse(entry);
        if (code) {
          failed++;
          return { ErrorCode: code, ErrorMessage: 'refused' };
        }
        state.entries.push(entry);
        return { EventId: `ev-${state.entries.length}` };
      });
      return jsonResponse({ FailedEntryCount: failed, Entries: results });
    },
  });
  return state;
}

/** Decodes an awsQuery form body into nested objects (lists keyed by `member.N`). */
function formOf(body: Uint8Array): Map<string, string> {
  return new Map(new URLSearchParams(Buffer.from(body).toString('utf8')));
}

export function snsFake(emu: AwsEmulator) {
  const state = { messages: [] as Record<string, string>[], batches: [] as number[], refuse: (() => undefined) as Refuse };
  emu.register('sns', {
    protocol: 'query',
    handle(request) {
      if (request.operation !== 'PublishBatch') throw new EmuError('InvalidAction', request.operation);
      const form = formOf(request.body);
      const entries: Record<string, string>[] = [];
      for (let n = 1; form.has(`PublishBatchRequestEntries.member.${n}.Id`); n++) {
        const prefix = `PublishBatchRequestEntries.member.${n}.`;
        const entry: Record<string, string> = { TopicArn: form.get('TopicArn')! };
        for (const [key, value] of form) if (key.startsWith(prefix)) entry[key.slice(prefix.length)] = value;
        entries.push(entry);
      }
      if (entries.length > 10) throw new EmuError('TooManyEntriesInBatchRequest', 'too many');
      state.batches.push(entries.length);
      const ok: string[] = [];
      const failed: string[] = [];
      for (const entry of entries) {
        const code = state.refuse(entry);
        if (code)
          failed.push(`<member><Id>${escapeXml(entry.Id!)}</Id><Code>${code}</Code><Message>refused</Message><SenderFault>false</SenderFault></member>`);
        else {
          state.messages.push(entry);
          ok.push(`<member><Id>${escapeXml(entry.Id!)}</Id><MessageId>m-${state.messages.length}</MessageId></member>`);
        }
      }
      return xmlResponse(
        `<PublishBatchResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishBatchResult><Successful>${ok.join('')}</Successful><Failed>${failed.join('')}</Failed></PublishBatchResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></PublishBatchResponse>`,
      );
    },
  });
  return state;
}

export function sqsFake(emu: AwsEmulator) {
  const state = { messages: [] as Record<string, unknown>[], batches: [] as number[], refuse: (() => undefined) as Refuse };
  emu.register('sqs', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'SendMessageBatch') throw new EmuError('UnsupportedOperation', request.operation);
      const body = json(request.body);
      const entries = body.Entries as Record<string, unknown>[];
      if (entries.length > 10) throw new EmuError('TooManyEntriesInBatchRequest', 'too many');
      state.batches.push(entries.length);
      const Successful: unknown[] = [];
      const Failed: unknown[] = [];
      for (const entry of entries) {
        const code = state.refuse(entry);
        if (code) Failed.push({ Id: entry.Id, Code: code, Message: 'refused', SenderFault: false });
        else {
          state.messages.push({ ...entry, QueueUrl: body.QueueUrl });
          Successful.push({ Id: entry.Id, MessageId: `m-${state.messages.length}` });
        }
      }
      return jsonResponse({ Successful, Failed });
    },
  });
  return state;
}

export function kinesisFake(emu: AwsEmulator) {
  const state = { records: [] as { data: string; partitionKey: string; stream: string }[], batches: [] as number[], refuse: (() => undefined) as Refuse };
  emu.register('kinesis', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'PutRecords') throw new EmuError('UnknownOperationException', request.operation);
      const body = json(request.body);
      const records = body.Records as Record<string, unknown>[];
      if (records.length > 500) throw new EmuError('ValidationException', 'too many');
      state.batches.push(records.length);
      let failed = 0;
      const results = records.map((record) => {
        const code = state.refuse(record);
        if (code) {
          failed++;
          return { ErrorCode: code, ErrorMessage: 'refused' };
        }
        state.records.push({
          data: Buffer.from(String(record.Data), 'base64').toString('utf8'),
          partitionKey: String(record.PartitionKey),
          stream: String(body.StreamName ?? body.StreamARN),
        });
        return { SequenceNumber: String(state.records.length), ShardId: 'shardId-000000000000' };
      });
      return jsonResponse({ FailedRecordCount: failed, Records: results });
    },
  });
  return state;
}

export function firehoseFake(emu: AwsEmulator) {
  const state = { records: [] as { data: string; stream: string }[], batches: [] as number[], refuse: (() => undefined) as Refuse };
  emu.register('firehose', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'PutRecordBatch') throw new EmuError('UnknownOperationException', request.operation);
      const body = json(request.body);
      const records = body.Records as Record<string, unknown>[];
      if (records.length > 500) throw new EmuError('ValidationException', 'too many');
      state.batches.push(records.length);
      let failed = 0;
      const results = records.map((record) => {
        const code = state.refuse(record);
        if (code) {
          failed++;
          return { ErrorCode: code, ErrorMessage: 'refused' };
        }
        state.records.push({ data: Buffer.from(String(record.Data), 'base64').toString('utf8'), stream: String(body.DeliveryStreamName) });
        return { RecordId: `rec-${state.records.length}` };
      });
      return jsonResponse({ FailedPutCount: failed, Encrypted: false, RequestResponses: results });
    },
  });
  return state;
}
