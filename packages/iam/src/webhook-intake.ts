// Remote-mode event intake, fallback (PLAN.md §12.8): when compute cannot read the IAM database's
// `compute_inbox`, the IAM deployment's root creates a subtree webhook (`webhooks.create({ scope: 'subtree' })`)
// to compute, and this handler turns its signed deliveries into `iam_inbox` rows. The inbox dedupes on the audit
// event id, so better-iam's at-least-once redeliveries (the same `X-Better-IAM-Delivery`) land once.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { systemClock, type Clock } from '@better-compute/core';
import {
  inboxReactions,
  isInboxEvent,
  toInboxEvent,
  type AuditEventLike,
  type InboxWriter,
} from './inbox.js';

/**
 * The audit-event patterns compute reacts to (§12.8), for the subscription's `events`: anything else would be
 * delivered only to be ignored.
 */
export const computeIamEventPatterns: readonly string[] = Object.freeze([
  'identity:*',
  'iam:identities:*',
  'auth:session:*',
  'tenant:revoke-sessions',
  'iam:roles:*',
  'agent:*',
  'delegation:revoke',
  'binding:*',
  'iam:bindings:*',
  'iam:tenants:*',
  'iam:policies:*',
  'iam:relationships:*',
  'feature:*',
  'billing:budget-alert',
]);

export interface IamWebhookHandlerOptions {
  /** The subscription's signing secret (returned once by `webhooks.create`). */
  secret: string;
  /** Where verified events go: `sqlInbox(computeSql)`. */
  inbox: InboxWriter;
  clock?: Clock;
  /** Accepted clock difference, seconds. Default 300 (better-iam's `verifyWebhookSignature` default). */
  toleranceSeconds?: number;
  /** Largest accepted body. Default 1 MiB. */
  maxBytes?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** better-iam's webhook signature: `v1=<hex hmac-sha256(secret, "<timestamp>.<body>")>`, timestamp in seconds. */
function verified(
  options: IamWebhookHandlerOptions,
  timestamp: string,
  body: string,
  signature: string,
) {
  const seconds = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(seconds)) return false;
  const now = Math.floor((options.clock ?? systemClock).now() / 1000);
  if (Math.abs(now - seconds) > (options.toleranceSeconds ?? 300)) return false;
  const provided = signature
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith('v1='))
    ?.slice(3);
  if (!provided || !/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac('sha256', options.secret).update(`${seconds}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

/**
 * compute's endpoint for better-iam webhook deliveries (mount it, e.g. `POST /iam/events`). 401 on a bad or stale
 * signature, 400 on a body that is not an audit event, 200 otherwise: `{ accepted: 1 }` for an event compute
 * reacts to, `{ accepted: 0 }` for one it ignores (a denial, an unrelated action), so better-iam never retries it.
 */
export function createIamWebhookHandler(
  options: IamWebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  if (typeof options.secret !== 'string' || options.secret.length < 16)
    throw new TypeError('The webhook secret must be the one webhooks.create returned');
  const maxBytes = options.maxBytes ?? 1 << 20;
  return async (request) => {
    if (request.method !== 'POST')
      return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
    const body = await request.text();
    if (Buffer.byteLength(body) > maxBytes)
      return json(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large' } });
    if (
      !verified(
        options,
        request.headers.get('x-better-iam-timestamp') ?? '',
        body,
        request.headers.get('x-better-iam-signature') ?? '',
      )
    )
      return json(401, { error: { code: 'UNAUTHENTICATED', message: 'Bad signature' } });
    let event: AuditEventLike;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.tenantId !== 'string' ||
        typeof parsed.type !== 'string' ||
        (parsed.outcome !== 'allow' && parsed.outcome !== 'deny') ||
        typeof parsed.timestamp !== 'number'
      )
        throw new Error('not an audit event');
      // The webhook body names the action `type`; the inbox keeps the audit event's own shape.
      const { type, ...rest } = parsed;
      event = { ...rest, action: type } as AuditEventLike;
    } catch (error) {
      return json(400, { error: { code: 'INVALID_INPUT', message: (error as Error).message } });
    }
    if (!isInboxEvent(event) || inboxReactions(event.action).length === 0)
      return json(200, { accepted: 0 });
    await options.inbox.put([toInboxEvent(event)]);
    return json(200, { accepted: 1 });
  };
}
