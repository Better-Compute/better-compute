import {
  defineMethod,
  type ComputeEvent,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import { toEvent, type OutboxRow } from '../runtime/events.js';
import { fields, limit, page, type Page } from './common.js';
import { parser, v } from './input.js';

// `events` (PLAN.md §9.2-9.3, module server): a tenant's CloudEvents-style events, read from the
// outbox with its (txid, seq) cursor (§8.4), so nothing ever appears behind a cursor already handed
// out. The same cursor is SSE's `Last-Event-ID` (v0.3). Decided on `compute-tenant/{t}`.

export interface ListEventsInput {
  tenantId: string;
  /** Only events whose type starts with this (`node.`, `reservation.`, `security.`). */
  type?: string;
  /** At most 500 (100 by default). */
  limit?: number;
  /** An event's `sequence`: list what came after it. */
  cursor?: string;
}

export type EventsApi = {
  events: { list: MethodDefinition<ListEventsInput, Page<ComputeEvent>> };
};

export const eventTypePrefix = v.string({ pattern: /^[a-z][a-z0-9.-]{0,63}$/, max: 64 });
export const eventCursor = v.string({ pattern: /^\d{1,20}:\d{1,20}$/, max: 41 });

const listInput: (input: unknown) => ListEventsInput = parser({
  tenantId: fields.tenantId,
  type: v.optional(eventTypePrefix),
  limit: limit(500, 100),
  cursor: v.optional(eventCursor),
});

/**
 * One page of a tenant's committed events after `cursor`, oldest first: optionally about one
 * `subject` (`node/<id>`) and of one type prefix.
 */
export async function readEvents(
  tx: SqlTx,
  query: { tenantId: string; subject?: string; type?: string; cursor?: string; limit: number },
): Promise<Page<ComputeEvent>> {
  const [txid, seq] = (query.cursor ?? '0:0').split(':');
  const { rows } = await tx.query<OutboxRow>(
    `SELECT o.txid::text AS txid, o.seq::text AS seq, o.topic, o.payload FROM outbox o
     WHERE o.payload->>'tenantId' = $1
       AND ($2::text IS NULL OR o.payload->>'subject' = $2)
       AND ($3::text IS NULL OR starts_with(o.topic, $3))
       AND o.txid < pg_snapshot_xmin(pg_current_snapshot())
       AND (o.txid, o.seq) > ($4::text::xid8, $5::bigint)
     ORDER BY o.txid, o.seq LIMIT $6`,
    [query.tenantId, query.subject ?? null, query.type ?? null, txid, seq, query.limit + 1],
  );
  return page(rows, query.limit, toEvent, (row) => `${row.txid}:${row.seq}`);
}

export function eventsApi(): EventsApi {
  return {
    events: {
      list: defineMethod<ListEventsInput, Page<ComputeEvent>>({
        action: 'compute:events:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: listInput,
        handler: (context, input) =>
          readEvents(context.sql, {
            tenantId: input.tenantId,
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit ?? 100,
          }),
      }),
    },
  };
}
