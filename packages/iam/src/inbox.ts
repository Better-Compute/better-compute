// Event intake (PLAN.md §12.8): better-iam audit events compute reacts to, written to `iam_inbox` by the
// plugin's `afterAudit` and drained per tenant in `sequence` order by the IamInbox worker.

import { ComputeError, type Json, type SqlTx } from '@better-compute/core';

/** The audit event fields the inbox needs; better-iam's `AuditEvent` satisfies it. */
export interface AuditEventLike {
  id: string;
  tenantId: string;
  action: string;
  outcome: 'allow' | 'deny';
  timestamp: number;
  sequence?: number;
  actorId?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One `iam_inbox` row. */
export interface InboxEvent {
  eventId: string;
  tenantId: string;
  /** The tenant chain position; 0 when the event has none. */
  sequence: number;
  /** Epoch milliseconds (`event.timestamp`). */
  occurredAt: number;
  action: string;
  /** The audit event as recorded. */
  body: Record<string, Json>;
}

/** Where the plugin puts events. Must dedupe on `eventId`: `dispatch()` is at-least-once. */
export interface InboxWriter {
  put(events: readonly InboxEvent[]): Promise<void>;
}

/** What compute does with an event (§12.8 table); an action can call for several. */
export type InboxReaction =
  | 'identity'
  | 'sessions'
  | 'agent'
  | 'binding'
  | 'tenant'
  | 'authz'
  | 'features'
  | 'budget';

const reactions: readonly (readonly [RegExp, readonly InboxReaction[]])[] = [
  [/^identity:(offboard|expire|delete)$/, ['identity', 'sessions']],
  [/^iam:identities:(delete|update)$/, ['identity', 'authz']],
  [
    /^(auth:session:revoke(-others)?|identity:revoke-sessions|tenant:revoke-sessions)$/,
    ['sessions'],
  ],
  [/^iam:roles:revoke-sessions$/, ['sessions']],
  [/^(agent:suspend(-all)?|delegation:revoke)$/, ['agent', 'sessions']],
  [/^(binding:(activate|deactivate)|iam:bindings:activate)$/, ['binding', 'authz']],
  [/^iam:tenants:(update|delete)$/, ['tenant', 'authz']],
  [/^iam:(policies|roles|bindings|relationships):(create|update|delete|approve)$/, ['authz']],
  [/^feature:[a-z-]+$/, ['features', 'authz']],
  [/^billing:budget-alert$/, ['budget']],
];

/** The reactions an action calls for; empty when compute ignores it. */
export function inboxReactions(action: string): InboxReaction[] {
  const found = new Set<InboxReaction>();
  for (const [pattern, kinds] of reactions)
    if (pattern.test(action)) for (const kind of kinds) found.add(kind);
  return [...found];
}

/** Whether the plugin forwards the event: an allowed action compute reacts to. Denials change nothing. */
export function isInboxEvent(event: Pick<AuditEventLike, 'action' | 'outcome'>): boolean {
  return event.outcome === 'allow' && inboxReactions(event.action).length > 0;
}

/** The inbox row for an audit event. */
export function toInboxEvent(event: AuditEventLike): InboxEvent {
  return {
    eventId: event.id,
    tenantId: event.tenantId,
    sequence: typeof event.sequence === 'number' ? event.sequence : 0,
    occurredAt: event.timestamp,
    action: event.action,
    body: JSON.parse(JSON.stringify(event)) as Record<string, Json>,
  };
}

/** A bounded FIFO that drops its oldest entries when full. */
export interface BoundedSpill<T> {
  readonly capacity: number;
  readonly size: number;
  /** Entries dropped because the spill was full, since creation. */
  readonly dropped: number;
  push(...items: T[]): void;
  /** Puts items back at the front (a failed flush), dropping the oldest beyond capacity. */
  unshift(items: readonly T[]): void;
  /** Removes and returns everything, oldest first. */
  drain(): T[];
}

export function boundedSpill<T>(capacity: number): BoundedSpill<T> {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new ComputeError('INVALID_CONFIG', 'spill capacity must be a positive integer');
  let items: T[] = [];
  let dropped = 0;
  const trim = () => {
    if (items.length > capacity) {
      dropped += items.length - capacity;
      items = items.slice(items.length - capacity);
    }
  };
  return {
    capacity,
    get size() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
    push(...more) {
      items.push(...more);
      trim();
    },
    unshift(more) {
      items = [...more, ...items];
      trim();
    },
    drain() {
      const out = items;
      items = [];
      return out;
    },
  };
}

/** An in-memory inbox that dedupes on `eventId`, for tests and single-process development. */
export interface MemoryInbox extends InboxWriter {
  readonly events: readonly InboxEvent[];
  clear(): void;
}

export function memoryInbox(): MemoryInbox {
  const byId = new Map<string, InboxEvent>();
  return {
    get events() {
      return [...byId.values()];
    },
    async put(events) {
      for (const event of events) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
    },
    clear() {
      byId.clear();
    },
  };
}

/** Writes `iam_inbox` rows in one statement, ignoring event ids it already has. */
export function sqlInbox(sql: SqlTx): InboxWriter {
  return {
    async put(events) {
      if (events.length === 0) return;
      await sql.query(
        `INSERT INTO iam_inbox (event_id, tenant_id, sequence, occurred_at, action, body, received_at)
         SELECT e.event_id, e.tenant_id, e.sequence, to_timestamp(e.occurred_ms / 1000.0), e.action,
                e.body::jsonb, compute_now()
           FROM unnest($1::text[], $2::text[], $3::bigint[], $4::float8[], $5::text[], $6::text[])
             AS e(event_id, tenant_id, sequence, occurred_ms, action, body)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          events.map((event) => event.eventId),
          events.map((event) => event.tenantId),
          events.map((event) => event.sequence),
          events.map((event) => event.occurredAt),
          events.map((event) => event.action),
          events.map((event) => JSON.stringify(event.body)),
        ],
      );
    },
  };
}
