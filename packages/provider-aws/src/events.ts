import {
  ComputeError,
  type CallContext,
  type Logger,
  type ProviderEvent,
  type ProviderEventBatch,
} from '@better-compute/core';
import {
  partitionOf,
  type JsonClient,
  type QueryParams,
  type XmlElement,
} from '@better-compute/aws-core';

// AWS A4 event intake (AD12). A customer-owned EventBridge rule set feeds an SQS queue; `pollEvents`
// long-polls it and maps each EventBridge envelope to a ProviderEvent. An envelope counts only when
// its `account` is the account's verified AWS id, its `region` the account's region, and its
// `source` on the allow-list; anything else is dropped, and deleted with the batch on ack, so a
// forged message is read once and never loops. Events only wake reconcilers: polling stays the
// source of truth, so the worst a forged message can do is cause an early, harmless re-read.

/** The EventBridge sources an account may take events from. */
export const awsEventSources = ['aws.ec2', 'aws.health', 'aws.guardduty'] as const;
export type AwsEventSource = (typeof awsEventSources)[number];
/** Without `eventSources`: EC2 itself (state, Spot, rebalance, reservations, CloudTrail) and Health. */
export const defaultEventSources: readonly AwsEventSource[] = ['aws.ec2', 'aws.health'];

/** How long before a Spot interruption EC2 sends the warning. */
export const spotWarningMs = 120_000;

const instancePattern = /^i-[0-9a-f]{8,17}$/;
const reservationPattern = /^cr-[0-9a-f]{8,17}$/;
const eventIdPattern = /^[\w.:/-]{1,128}$/;

/** The EC2 API calls (CloudTrail) that change an instance out of band: each wakes its reconcile. */
const instanceCalls: ReadonlySet<string> = new Set([
  'TerminateInstances',
  'StopInstances',
  'StartInstances',
  'RebootInstances',
  'ModifyInstanceAttribute',
  'ModifyInstanceMetadataOptions',
  'CreateTags',
  'DeleteTags',
]);

export interface EnvelopeFilter {
  /** The account's verified AWS account id. */
  account: string;
  region: string;
  sources: ReadonlySet<string>;
}

export type DropReason = 'foreignAccount' | 'otherRegion' | 'unknownSource' | 'unknownType' | 'malformed';

const text = (value: unknown, max = 256): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A short provider fact for `details`: printable and bounded, never a nested value. */
const fact = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const found = text(value, 128);
  return found !== undefined && /^[\x20-\x7e]+$/.test(found) ? found : undefined;
};

function details(entries: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    const found = fact(value);
    if (found !== undefined) out[key] = found;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function event(
  base: { id: string; at: number },
  kind: ProviderEvent['kind'],
  extra: Omit<ProviderEvent, 'id' | 'kind' | 'at'> & { idSuffix?: string } = {},
): ProviderEvent {
  const { idSuffix, details: facts, ...rest } = extra;
  return {
    id: idSuffix === undefined ? base.id : `${base.id}/${idSuffix}`,
    kind,
    ...(rest.machineId !== undefined ? { machineId: rest.machineId } : {}),
    ...(rest.reservationId !== undefined ? { reservationId: rest.reservationId } : {}),
    at: base.at,
    ...(rest.deadline !== undefined ? { deadline: rest.deadline } : {}),
    ...(facts !== undefined ? { details: facts } : {}),
  };
}

/** `cr-…` from the detail or a capacity-reservation ARN among the resources. */
function reservationOf(detail: Record<string, unknown>, resources: unknown): string | undefined {
  for (const key of ['capacity-reservation-id', 'capacityReservationId', 'capacity-block-id']) {
    const found = text(detail[key], 64);
    if (found && reservationPattern.test(found)) return found;
  }
  if (Array.isArray(resources))
    for (const resource of resources) {
      const match = /:capacity-reservation\/(cr-[0-9a-f]{8,17})$/.exec(text(resource, 512) ?? '');
      if (match) return match[1];
    }
  return undefined;
}

/** The instance ids a CloudTrail EC2 call names (request, then response). */
function trailInstances(detail: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const side of ['requestParameters', 'responseElements']) {
    const set = record(record(record(detail[side])?.instancesSet))?.items;
    if (Array.isArray(set))
      for (const item of set.slice(0, 100)) {
        const id = text(record(item)?.instanceId, 32);
        if (id && instancePattern.test(id)) ids.add(id);
      }
    const resources = record(detail[side])?.resourcesSet;
    const items = record(resources)?.items;
    if (Array.isArray(items))
      for (const item of items.slice(0, 100)) {
        const id = text(record(item)?.resourceId, 32);
        if (id && instancePattern.test(id)) ids.add(id);
      }
  }
  return [...ids];
}

/**
 * Maps one EventBridge envelope (already JSON-parsed) to events, or says why it is dropped. Pure.
 *
 * | detail-type | kind |
 * |---|---|
 * | EC2 Instance State-change Notification | machine-changed |
 * | EC2 Spot Instance Interruption Warning | interruption-warning (deadline = time + 2 min) |
 * | EC2 Instance Rebalance Recommendation | rebalance-recommended |
 * | AWS Health Event (service EC2, naming instances) | maintenance-scheduled per instance (deadline = startTime) |
 * | AWS Health Event (otherwise) | health |
 * | any aws.ec2 type naming a Capacity Reservation, Capacity Block or ODCR | reservation-changed |
 * | AWS API Call via CloudTrail (EC2 instance calls that succeeded) | api-call per instance |
 * | GuardDuty Finding (aws.guardduty, when allowed) | health |
 */
export function mapEventBridgeEnvelope(
  raw: unknown,
  filter: EnvelopeFilter,
): { events: ProviderEvent[] } | { dropped: DropReason } {
  const envelope = record(raw);
  const id = text(envelope?.id, 128);
  const detailType = text(envelope?.['detail-type'], 128);
  const source = text(envelope?.source, 64);
  const at = Date.parse(text(envelope?.time, 64) ?? '');
  const detail = record(envelope?.detail);
  if (!envelope || !id || !eventIdPattern.test(id) || !detailType || !source || !detail || !Number.isFinite(at))
    return { dropped: 'malformed' };
  if (envelope.account !== filter.account) return { dropped: 'foreignAccount' };
  if (envelope.region !== filter.region) return { dropped: 'otherRegion' };
  if (!filter.sources.has(source)) return { dropped: 'unknownSource' };
  const base = { id, at };
  const instance = (): string | undefined => {
    const found = text(detail['instance-id'], 32);
    return found && instancePattern.test(found) ? found : undefined;
  };

  if (source === 'aws.ec2') {
    switch (detailType) {
      case 'EC2 Instance State-change Notification': {
        const machineId = instance();
        if (!machineId) return { dropped: 'malformed' };
        const facts = details({ state: detail.state });
        return { events: [event(base, 'machine-changed', { machineId, ...(facts ? { details: facts } : {}) })] };
      }
      case 'EC2 Spot Instance Interruption Warning': {
        const machineId = instance();
        if (!machineId) return { dropped: 'malformed' };
        const facts = details({ action: detail['instance-action'] });
        return {
          events: [
            event(base, 'interruption-warning', {
              machineId,
              deadline: at + spotWarningMs,
              ...(facts ? { details: facts } : {}),
            }),
          ],
        };
      }
      case 'EC2 Instance Rebalance Recommendation': {
        const machineId = instance();
        if (!machineId) return { dropped: 'malformed' };
        return { events: [event(base, 'rebalance-recommended', { machineId })] };
      }
      case 'AWS API Call via CloudTrail': {
        const name = text(detail.eventName, 128);
        if (detail.eventSource !== 'ec2.amazonaws.com' || !name) return { dropped: 'unknownType' };
        // A failed call changed nothing; a call outside the instance set is not ours to wake.
        if (detail.errorCode !== undefined || !instanceCalls.has(name)) return { events: [] };
        return {
          events: trailInstances(detail).map((machineId) =>
            event(base, 'api-call', { machineId, idSuffix: machineId, details: { eventName: name } }),
          ),
        };
      }
      default:
        if (/capacity (block|reservation)|odcr/i.test(detailType)) {
          const reservationId = reservationOf(detail, envelope.resources);
          if (!reservationId) return { dropped: 'malformed' };
          return { events: [event(base, 'reservation-changed', { reservationId })] };
        }
        return { dropped: 'unknownType' };
    }
  }

  if (source === 'aws.health') {
    if (detailType !== 'AWS Health Event') return { dropped: 'unknownType' };
    const facts = details({ code: detail.eventTypeCode, status: detail.statusCode });
    const machines = Array.isArray(detail.affectedEntities)
      ? detail.affectedEntities
          .slice(0, 500)
          .map((entity) => text(record(entity)?.entityValue, 32))
          .filter((value): value is string => value !== undefined && instancePattern.test(value))
      : [];
    if (detail.service === 'EC2' && machines.length > 0) {
      const start = Date.parse(text(detail.startTime, 64) ?? '');
      return {
        events: [...new Set(machines)].map((machineId) =>
          event(base, 'maintenance-scheduled', {
            machineId,
            idSuffix: machineId,
            ...(Number.isFinite(start) ? { deadline: start } : {}),
            ...(facts ? { details: facts } : {}),
          }),
        ),
      };
    }
    const general = details({ service: detail.service, code: detail.eventTypeCode, status: detail.statusCode });
    return { events: [event(base, 'health', general ? { details: general } : {})] };
  }

  if (source === 'aws.guardduty') {
    if (detailType !== 'GuardDuty Finding') return { dropped: 'unknownType' };
    const machineId = text(record(record(detail.resource)?.instanceDetails)?.instanceId, 32);
    const facts = details({ source, type: detail.type, severity: detail.severity });
    return {
      events: [
        event(base, 'health', {
          ...(machineId && instancePattern.test(machineId) ? { machineId } : {}),
          ...(facts ? { details: facts } : {}),
        }),
      ],
    };
  }
  return { dropped: 'unknownSource' };
}

/** `{ account, name }` of an SQS queue URL in `region`; INVALID_CONFIG otherwise. */
export function parseEventQueueUrl(url: string, region: string): { account: string; name: string } {
  const suffix = partitionOf(region).dnsSuffix.replace(/\./g, '\\.');
  const escaped = region.replace(/-/g, '\\-');
  const match = new RegExp(`^https://sqs\\.${escaped}\\.${suffix}/(\\d{12})/([A-Za-z0-9_-]{1,75}(?:\\.fifo)?)$`).exec(
    String(url),
  );
  if (!match || String(url).length > 256)
    throw new ComputeError(
      'INVALID_CONFIG',
      `eventQueueUrl must be an SQS queue URL in ${region} (https://sqs.${region}.${partitionOf(region).dnsSuffix}/<account>/<name>)`,
      undefined,
      { provider: 'aws', reason: 'eventQueueUrl' },
    );
  return { account: match[1]!, name: match[2]! };
}

interface SqsMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
}

export interface QueueIntakeDeps {
  sqs: JsonClient;
  queueUrl: string;
  region: string;
  sources: readonly string[];
  /** The account's verified AWS id (runs the identity checks first). */
  account(signal: AbortSignal): Promise<string>;
  log: Logger;
}

/** The longest SQS long poll `pollEvents` asks for (the plan's 10 s; SQS allows 20). */
const maxWaitSeconds = 10;

/** Reads one batch from the intake queue: ReceiveMessage, map and filter; `ack` is DeleteMessageBatch. */
export async function pollQueue(
  deps: QueueIntakeDeps,
  context: CallContext,
  options: { waitMs: number; max: number },
): Promise<ProviderEventBatch> {
  const account = await deps.account(context.signal);
  const queue = parseEventQueueUrl(deps.queueUrl, deps.region);
  // Fail closed: the rendered stack puts the queue in the account itself; a queue elsewhere could
  // be fed by anyone who controls that other account.
  if (queue.account !== account)
    throw new ComputeError(
      'INVALID_CONFIG',
      `eventQueueUrl names AWS account ${queue.account}, but the account's identity is in ${account}`,
      undefined,
      { provider: 'aws', reason: 'eventQueueAccount' },
    );
  const wait = Math.max(0, Math.min(maxWaitSeconds, Math.floor(options.waitMs / 1000)));
  const max = Math.max(1, Math.min(10, Math.floor(options.max)));
  const answer = await deps.sqs.call<{ Messages?: SqsMessage[] }>(
    'ReceiveMessage',
    { QueueUrl: deps.queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: wait },
    { signal: context.signal },
  );
  const messages = Array.isArray(answer?.Messages) ? answer.Messages.slice(0, 10) : [];
  const filter: EnvelopeFilter = { account, region: deps.region, sources: new Set(deps.sources) };
  const events: ProviderEvent[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const receipts: string[] = [];
  for (const message of messages) {
    if (typeof message.ReceiptHandle === 'string' && message.ReceiptHandle.length <= 8192)
      receipts.push(message.ReceiptHandle);
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(message.Body ?? ''));
    } catch {
      parsed = undefined;
    }
    const mapped = mapEventBridgeEnvelope(parsed, filter);
    if ('dropped' in mapped) dropped[mapped.dropped] = (dropped[mapped.dropped] ?? 0) + 1;
    else events.push(...mapped.events);
  }
  // Counts only: a dropped message's body may be anything, so none of it is logged.
  if (Object.keys(dropped).length > 0)
    deps.log.warn('provider-aws: dropped event-intake messages', { provider: 'aws', ...dropped });
  let acked = false;
  return {
    events,
    async ack() {
      if (acked || receipts.length === 0) return;
      acked = true;
      const failed: string[] = [];
      for (let start = 0; start < receipts.length; start += 10) {
        const entries = receipts
          .slice(start, start + 10)
          .map((receipt, index) => ({ Id: `m${start + index}`, ReceiptHandle: receipt }));
        const result = await deps.sqs.call<{ Failed?: { Code?: string }[] }>(
          'DeleteMessageBatch',
          { QueueUrl: deps.queueUrl, Entries: entries },
          { signal: context.signal },
        );
        for (const entry of result?.Failed ?? []) failed.push(String(entry.Code ?? 'unknown').slice(0, 64));
      }
      // A stale receipt (the message was redelivered meanwhile) is not an error: the redelivery's
      // ack deletes it, and vps drops the duplicate id.
      if (failed.length > 0)
        deps.log.warn('provider-aws: some event-intake messages were not deleted', {
          provider: 'aws',
          failed: failed.length,
          codes: [...new Set(failed)].join(','),
        });
    },
  };
}

// --- Without a queue: DescribeInstanceStatus scheduled events --------------------------------------

/** How often an account without an intake queue reads its scheduled events. */
export const scheduledEventScanMs = 5 * 60_000;

/** The scheduled-event codes EC2 reports (DescribeInstanceStatus `event.code`). */
const scheduledCodes = [
  'instance-reboot',
  'system-reboot',
  'system-maintenance',
  'instance-retirement',
  'instance-stop',
];

/** `scheduled`, or `completed` / `canceled` from EC2's `[Completed]` / `[Canceled]` description prefix. */
function scheduledStatus(description: string): 'scheduled' | 'completed' | 'canceled' {
  if (/^\[completed\]/i.test(description)) return 'completed';
  if (/^\[cancell?ed\]/i.test(description)) return 'canceled';
  return 'scheduled';
}

/**
 * Every instance's scheduled events, as `maintenance-scheduled` events. The id carries the event's
 * status, so a completion or cancellation is a new event while an unchanged one stays a duplicate.
 */
export async function scanScheduledEvents(
  call: (action: string, params: QueryParams, signal: AbortSignal) => Promise<XmlElement>,
  signal: AbortSignal,
  now: number,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const doc = await call(
      'DescribeInstanceStatus',
      {
        Filter: [{ Name: 'event.code', Value: scheduledCodes }],
        MaxResults: 1000,
        NextToken: token,
      },
      signal,
    );
    for (const item of doc.items('instanceStatusSet')) {
      const machineId = item.textOf('instanceId');
      if (!machineId || !instancePattern.test(machineId)) continue;
      for (const scheduled of item.items('eventsSet')) {
        const eventId = scheduled.textOf('instanceEventId');
        const code = scheduled.textOf('code');
        if (!eventId || !/^instance-event-[0-9a-f]{8,17}$/.test(eventId) || !code) continue;
        const status = scheduledStatus(scheduled.textOf('description') ?? '');
        const notBefore = Date.parse(scheduled.textOf('notBefore') ?? '');
        events.push({
          id: `status/${machineId}/${eventId}/${status}`,
          kind: 'maintenance-scheduled',
          machineId,
          at: now,
          ...(Number.isFinite(notBefore) ? { deadline: notBefore } : {}),
          details: { code: code.slice(0, 64), status },
        });
      }
    }
    token = doc.textOf('nextToken') || undefined;
    if (token && seen.has(token))
      throw new ComputeError('PROVIDER_ERROR', 'AWS returned a pagination token twice', undefined, {
        provider: 'aws',
        reason: 'pagination-loop',
      });
    if (token) seen.add(token);
  } while (token);
  return events;
}
