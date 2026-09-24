// `GET /watch` (PLAN.md §9.1, §9.3): a tenant's events as Server-Sent Events, read from the outbox. Each
// event's `id:` is its outbox cursor, so a reconnecting client's `Last-Event-ID` resumes exactly after it;
// without one the stream starts at the current tail. The host mounts the handler and supplies the
// authorizer (the server's IAM decision on `compute:events:read @ compute-tenant/{t}`).

import {
  ComputeError,
  isComputeError,
  type ComputeEvent,
  type SqlExecutor,
} from '@better-compute/core';
import {
  formatCursor,
  matchesEventType,
  outboxTail,
  parseCursor,
  readOutbox,
  type OutboxCursor,
} from './outbox.js';

export interface WatchOptions {
  sql: SqlExecutor;
  /**
   * Authenticates and authorizes the request (the host's IAM decision) and names the tenant whose events it
   * may read. Throw a `ComputeError` to refuse.
   */
  authorize(request: Request): Promise<{ tenantId: string }>;
  /** How often to look for new events. Default 1000 ms. */
  pollMs?: number;
  /** Comment lines that keep proxies from closing an idle stream. Default 15 s. */
  heartbeatMs?: number;
  /** Events per read. Default 200. */
  batch?: number;
  /** Reconnect delay the client is told (`retry:`). Default 2000 ms. */
  retryMs?: number;
  /** Close the stream after this long (clients reconnect with Last-Event-ID). Default 1 h. */
  maxDurationMs?: number;
}

function errorResponse(error: unknown): Response {
  const known = isComputeError(error)
    ? error
    : new ComputeError('INTERNAL_ERROR', 'Internal error');
  return new Response(JSON.stringify({ error: known.toBody() }), {
    status: known.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Formats one SSE event. Data is JSON on one line, so it never needs splitting. */
export function sseEvent(event: ComputeEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Handles `GET /watch[?types=reservation.*,node.connected][&lastEventId=…]`. `Last-Event-ID` (header or
 * query) resumes after that cursor.
 */
export async function handleWatch(request: Request, options: WatchOptions): Promise<Response> {
  if (request.method !== 'GET')
    return errorResponse(new ComputeError('METHOD_NOT_ALLOWED', 'GET only'));
  let tenantId: string;
  let after: OutboxCursor;
  let types: string[];
  try {
    ({ tenantId } = await options.authorize(request));
    const url = new URL(request.url);
    types = (url.searchParams.get('types') ?? '*')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean);
    if (types.length === 0 || types.length > 20 || types.some((type) => type.length > 128))
      throw new ComputeError('INVALID_INPUT', 'types must list 1-20 event type patterns');
    const resume = request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId');
    after = resume ? parseCursor(resume) : await outboxTail(options.sql);
  } catch (error) {
    return errorResponse(error);
  }

  const pollMs = options.pollMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const batch = options.batch ?? 200;
  const deadline = Date.now() + (options.maxDurationMs ?? 3_600_000);
  const encoder = new TextEncoder();
  let closed = false;
  const stop = () => {
    closed = true;
  };
  request.signal?.addEventListener('abort', stop, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      send(`retry: ${options.retryMs ?? 2000}\n\n`);
      let lastBeat = Date.now();
      try {
        while (!closed && Date.now() < deadline) {
          const page = await readOutbox(options.sql, { after, limit: batch, tenantId });
          after = page.cursor;
          for (const event of page.events)
            if (types.some((pattern) => matchesEventType(pattern, event.type)))
              send(sseEvent(event));
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(`: keep-alive ${formatCursor(after)}\n\n`);
            lastBeat = Date.now();
          }
          if (!page.more) await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
        send(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`);
      } finally {
        closed = true;
        request.signal?.removeEventListener('abort', stop);
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
