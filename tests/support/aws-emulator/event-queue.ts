import type { AwsEmulator } from './index.js';
import { jsonError, requestId } from './xml.js';

// SQS as the A4 event intake uses it (JSON 1.0 protocol, `AmazonSQS.<Operation>`): standard queues
// addressed by QueueUrl, ReceiveMessage with long-poll bounds and a visibility timeout, and
// DeleteMessage / DeleteMessageBatch by receipt handle. A received message that is not deleted
// becomes visible again when its visibility timeout runs out on the emulator clock.

export interface EmuMessage {
  id: string;
  body: string;
  /** Times it was received. */
  receives: number;
  /** Visible again from this time (emulator ms); 0 when visible. */
  invisibleUntil: number;
  receipt?: string;
}

export interface EmuQueue {
  url: string;
  messages: EmuMessage[];
  /** Default visibility timeout in seconds (30). */
  visibilityTimeout: number;
}

let sequence = 0;

export class SqsEmulator {
  readonly queues = new Map<string, EmuQueue>();

  constructor(readonly emu: AwsEmulator) {
    emu.register(/^sqs\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'sqs',
      protocol: 'json',
      handle: (request) => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(request.body || '{}') as Record<string, unknown>;
        } catch {
          return jsonError('InvalidParameterValue', 'body is not JSON');
        }
        if (request.headers.get('content-type') !== 'application/x-amz-json-1.0')
          return jsonError('InvalidParameterValue', 'SQS speaks JSON 1.0 here');
        const queue = this.queues.get(String(body.QueueUrl));
        if (!queue)
          return jsonError('AWS.SimpleQueueService.NonExistentQueue', 'The specified queue does not exist.');
        switch (request.operation) {
          case 'ReceiveMessage':
            return this.#receive(queue, body);
          case 'DeleteMessage':
            this.#delete(queue, String(body.ReceiptHandle));
            return json({});
          case 'DeleteMessageBatch': {
            const entries = (body.Entries as { Id: string; ReceiptHandle: string }[]) ?? [];
            if (entries.length === 0 || entries.length > 10)
              return jsonError('AWS.SimpleQueueService.TooManyEntriesInBatchRequest', 'entries');
            const successful: { Id: string }[] = [];
            const failed: { Id: string; Code: string; SenderFault: boolean; Message: string }[] = [];
            for (const entry of entries) {
              if (this.#delete(queue, entry.ReceiptHandle)) successful.push({ Id: entry.Id });
              else
                failed.push({
                  Id: entry.Id,
                  Code: 'ReceiptHandleIsInvalid',
                  SenderFault: true,
                  Message: 'stale receipt handle',
                });
            }
            return json({ Successful: successful, ...(failed.length ? { Failed: failed } : {}) });
          }
          default:
            return jsonError('InvalidAction', `unsupported ${request.operation}`);
        }
      },
    });
  }

  /** A queue at `https://sqs.<region>.amazonaws.com/<account>/<name>`. */
  createQueue(account: string, name: string, region = 'us-east-1'): EmuQueue {
    const url = `https://sqs.${region}.amazonaws.com/${account}/${name}`;
    const queue: EmuQueue = { url, messages: [], visibilityTimeout: 30 };
    this.queues.set(url, queue);
    return queue;
  }

  /** Puts a message body (an EventBridge envelope, usually) on the queue. */
  send(queue: EmuQueue, body: string | Record<string, unknown>): EmuMessage {
    const message: EmuMessage = {
      id: `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      receives: 0,
      invisibleUntil: 0,
    };
    queue.messages.push(message);
    return message;
  }

  #receive(queue: EmuQueue, body: Record<string, unknown>): Response {
    const max = Number(body.MaxNumberOfMessages ?? 1);
    const wait = Number(body.WaitTimeSeconds ?? 0);
    if (!Number.isInteger(max) || max < 1 || max > 10)
      return jsonError('InvalidParameterValue', 'MaxNumberOfMessages must be 1..10');
    if (!Number.isInteger(wait) || wait < 0 || wait > 20)
      return jsonError('InvalidParameterValue', 'WaitTimeSeconds must be 0..20');
    const now = this.emu.now();
    const visibility = Number(body.VisibilityTimeout ?? queue.visibilityTimeout);
    const out: Record<string, unknown>[] = [];
    for (const message of queue.messages) {
      if (out.length >= max) break;
      if (message.invisibleUntil > now) continue;
      message.receives += 1;
      message.invisibleUntil = now + visibility * 1000;
      message.receipt = `rh-${message.id}-${message.receives}`;
      out.push({ MessageId: message.id, ReceiptHandle: message.receipt, Body: message.body });
    }
    return json(out.length ? { Messages: out } : {});
  }

  #delete(queue: EmuQueue, receipt: string): boolean {
    const index = queue.messages.findIndex((message) => message.receipt === receipt);
    if (index === -1) return false;
    queue.messages.splice(index, 1);
    return true;
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': requestId() },
  });
}
