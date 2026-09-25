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

/** Who opened a watch stream, as far as revocation needs to know. */
export interface WatchSubject {
  identityId?: string;
  sessionId?: string;
  /** The agent acting in a delegated session, and its delegation. */
  agentId?: string;
  delegationId?: string;
}

/** What `authorize` grants: the tenant, and optionally who asked and how to re-check them. */
export interface WatchGrant {
  tenantId: string;
  subject?: WatchSubject;
  /**
   * Re-decides whether the caller may still read (every `reauthorizeMs`, like tunnels): false closes the
   * stream; a throw counts as IAM unreachable, and after `iamOutageMs` of that it closes. Hosts use
   * `IamPort.authorizeSession` with the caller's recorded session.
   */
  reauthorize?: () => Promise<boolean>;
}

/** Which open streams `closeWhere` closes: every given field must match. */
export interface WatchFilter {
  tenantId?: string;
  identityId?: string;
  sessionId?: string;
  agentId?: string;
  delegationId?: string;
  /** With `tenantId`: every stream an agent opened in that tenant (`agent:suspend-all`). */
  anyAgent?: true;
}

/**
 * The open watch streams of one process, so a revocation closes them at once instead of at the next
 * re-authorization: `delegation:revoke` / `agent:suspend` by agent or delegation, session ends by session,
 * offboarding by identity. Pass the same registry to every `handleWatch` call.
 */
export interface WatchRegistry {
  readonly size: number;
  /** Closes matching streams and returns how many. A tenant alone (without `anyAgent`) narrows nothing and throws. */
  closeWhere(filter: WatchFilter, reason: string): number;
  /** @internal Used by `handleWatch`. */
  add(entry: { tenantId: string; subject: WatchSubject; close(reason: string): void }): () => void;
}

export function createWatchRegistry(): WatchRegistry {
  const entries = new Set<{
    tenantId: string;
    subject: WatchSubject;
    close(reason: string): void;
  }>();
  return {
    get size() {
      return entries.size;
    },
    add(entry) {
      entries.add(entry);
      return () => entries.delete(entry);
    },
    closeWhere(filter, reason) {
      const narrowed =
        filter.identityId !== undefined ||
        filter.sessionId !== undefined ||
        filter.agentId !== undefined ||
        filter.delegationId !== undefined ||
        (filter.anyAgent === true && filter.tenantId !== undefined);
      if (!narrowed)
        throw new ComputeError(
          'INVALID_INPUT',
          'closeWhere needs an identity, session, agent or delegation (or a tenant with anyAgent)',
        );
      let closed = 0;
      for (const entry of [...entries]) {
        const { subject } = entry;
        if (
          (filter.tenantId === undefined || entry.tenantId === filter.tenantId) &&
          (filter.identityId === undefined || subject.identityId === filter.identityId) &&
          (filter.sessionId === undefined || subject.sessionId === filter.sessionId) &&
          (filter.agentId === undefined || subject.agentId === filter.agentId) &&
          (filter.delegationId === undefined || subject.delegationId === filter.delegationId) &&
          (filter.anyAgent === undefined || subject.agentId !== undefined)
        ) {
          entries.delete(entry);
          entry.close(reason);
          closed++;
        }
      }
      return closed;
    },
  };
}

export interface WatchOptions {
  sql: SqlExecutor;
  /**
   * Authenticates and authorizes the request (the host's IAM decision) and names the tenant whose events it
   * may read. Throw a `ComputeError` to refuse. Return `subject` (with a `registry`) so revocations close the
   * stream at once, and `reauthorize` so it is re-checked while open.
   */
  authorize(request: Request): Promise<WatchGrant>;
  /** Where open streams register so revocations can close them. */
  registry?: WatchRegistry;
  /** How often `reauthorize` runs. Default 60 s. */
  reauthorizeMs?: number;
  /** How long `reauthorize` may keep failing (IAM unreachable) before the stream closes. Default 2 min. */
  iamOutageMs?: number;
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
  let grant: WatchGrant;
  let after: OutboxCursor;
  let types: string[];
  try {
    grant = await options.authorize(request);
    ({ tenantId } = grant);
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
  const reauthorizeMs = options.reauthorizeMs ?? 60_000;
  const iamOutageMs = options.iamOutageMs ?? 120_000;
  const encoder = new TextEncoder();
  let closed = false;
  /** Why the stream was ended by a revocation or a failed re-check (sent to the client as an error event). */
  let revoked: string | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    closed = true;
    wake?.();
  };
  request.signal?.addEventListener('abort', stop, { once: true });
  const unregister = options.registry?.add({
    tenantId,
    subject: grant.subject ?? {},
    close(reason) {
      revoked ??= reason;
      stop();
    },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      send(`retry: ${options.retryMs ?? 2000}\n\n`);
      let lastBeat = Date.now();
      let lastCheck = Date.now();
      let failingSince: number | undefined;
      try {
        while (!closed && Date.now() < deadline) {
          if (grant.reauthorize && Date.now() - lastCheck >= reauthorizeMs) {
            lastCheck = Date.now();
            try {
              if (!(await grant.reauthorize())) revoked ??= 'access revoked';
              failingSince = undefined;
            } catch {
              failingSince ??= Date.now();
              if (Date.now() - failingSince >= iamOutageMs)
                revoked ??= 'authorization could not be re-checked';
            }
            if (revoked) break;
          }
          const page = await readOutbox(options.sql, { after, limit: batch, tenantId });
          // A revocation that landed during the read wins over the events it returned.
          if (closed) break;
          after = page.cursor;
          for (const event of page.events)
            if (types.some((pattern) => matchesEventType(pattern, event.type)))
              send(sseEvent(event));
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(`: keep-alive ${formatCursor(after)}\n\n`);
            lastBeat = Date.now();
          }
          if (!page.more && !closed)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, pollMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          wake = undefined;
        }
        if (revoked) {
          // Sent past `closed`: the client learns why, and a reconnect is authorized afresh.
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ code: 'ACCESS_DENIED', message: revoked })}\n\n`,
            ),
          );
        }
      } catch (error) {
        send(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`);
      } finally {
        closed = true;
        unregister?.();
        request.signal?.removeEventListener('abort', stop);
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      stop();
      unregister?.();
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
