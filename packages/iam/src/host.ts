// Remote mode, IAM-operator side (PLAN.md §12.1, v0.4): what a better-iam deployment that compute does not run
// installs so compute's catalog, resolver and events work there. `computeIamHost` bundles the plugin, the
// resolver over a replica of compute's authz projection, and an inbox:
// - `postgresInbox` (default) writes `compute_inbox` in the IAM database, with IAM's own availability;
//   compute's worker drains it with `pullRemoteInbox`;
// - `httpInbox` posts signed batches to compute (`createInboxHandler` verifies them).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ComputeError, systemClock, type Clock, type SqlExecutor } from '@better-compute/core';
import type { ComputeCatalogOptions } from './catalog.js';
import { sqlInbox, type InboxEvent, type InboxWriter } from './inbox.js';
import { computeIamPlugin, type ComputeIamPlugin } from './iam-plugin.js';
import {
  createAuthzProjection,
  sqlProjectionSource,
  type AuthzProjection,
  type AuthzProjectionOptions,
} from './projection.js';
import { computeResolver, type ResourceResolver } from './resolver.js';

const tablePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/** An inbox writer that also owns its storage. */
export interface ManagedInbox extends InboxWriter {
  /** Creates what the inbox needs (idempotent). */
  ensure?(): Promise<void>;
}

export interface PostgresInboxOptions {
  /** An executor on the IAM database (its role needs CREATE for `ensure`). */
  sql: SqlExecutor;
  /** Default `compute_inbox`. */
  table?: string;
  clock?: Clock;
}

/**
 * The default remote-mode inbox: rows in the IAM database, written in the IAM host's `afterAudit`, so a compute
 * outage never blocks IAM. The table is created on first use (or by `ensure()`, which `computeIamHost`'s
 * plugin calls from `migrate` during `iam.initialize()`), under an advisory lock so hosts starting together
 * don't race.
 */
export function postgresInbox(options: PostgresInboxOptions): ManagedInbox {
  const table = options.table ?? 'compute_inbox';
  if (!tablePattern.test(table)) throw new ComputeError('INVALID_CONFIG', `Invalid table ${table}`);
  const clock = options.clock ?? systemClock;
  let ensured: Promise<void> | undefined;
  const ensure = () => {
    ensured ??= options.sql
      .transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('better-compute:' || $1))", [table]);
        await tx.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             event_id text PRIMARY KEY,
             tenant_id text NOT NULL,
             sequence bigint NOT NULL,
             occurred_at timestamptz NOT NULL,
             action text NOT NULL,
             body jsonb NOT NULL,
             received_at timestamptz NOT NULL
           )`,
        );
        await tx.query(`CREATE INDEX IF NOT EXISTS ${table}_received ON ${table} (received_at)`);
      })
      .catch((error: unknown) => {
        ensured = undefined;
        throw error;
      });
    return ensured;
  };
  return {
    ensure,
    async put(events) {
      if (events.length === 0) return;
      await ensure();
      await options.sql.query(
        `INSERT INTO ${table} (event_id, tenant_id, sequence, occurred_at, action, body, received_at)
         SELECT e.event_id, e.tenant_id, e.sequence, to_timestamp(e.occurred_ms / 1000.0), e.action,
                e.body::jsonb, to_timestamp($7::float8 / 1000.0)
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
          clock.now(),
        ],
      );
    },
  };
}

export interface PullRemoteInboxOptions {
  /** Default `compute_inbox`. */
  table?: string;
  /** Rows per pass. Default 500. */
  limit?: number;
}

/**
 * Moves rows from the IAM database's `compute_inbox` into compute's `iam_inbox` (which dedupes on event
 * id), then deletes them there, holding them `FOR UPDATE SKIP LOCKED` meanwhile. At-least-once: a crash
 * between the two leaves rows that the next pass copies again harmlessly.
 */
export async function pullRemoteInbox(
  iamDatabase: SqlExecutor,
  compute: SqlExecutor,
  options: PullRemoteInboxOptions = {},
): Promise<{ moved: number; more: boolean }> {
  const table = options.table ?? 'compute_inbox';
  if (!tablePattern.test(table)) throw new ComputeError('INVALID_CONFIG', `Invalid table ${table}`);
  const limit = options.limit ?? 500;
  const exists = await iamDatabase.query<{ found: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS found',
    [table],
  );
  if (!exists.rows[0]?.found) return { moved: 0, more: false };
  return iamDatabase.transaction(async (tx) => {
    const { rows } = await tx.query<{
      event_id: string;
      tenant_id: string;
      sequence: string | number;
      occurred_ms: string | number;
      action: string;
      body: unknown;
    }>(
      `SELECT event_id, tenant_id, sequence, extract(epoch FROM occurred_at) * 1000 AS occurred_ms,
              action, body
         FROM ${table} ORDER BY received_at, event_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return { moved: 0, more: false };
    const events: InboxEvent[] = rows.map((row) => ({
      eventId: row.event_id,
      tenantId: row.tenant_id,
      sequence: Number(row.sequence),
      occurredAt: Math.round(Number(row.occurred_ms)),
      action: row.action,
      body: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as InboxEvent['body'],
    }));
    await sqlInbox(compute).put(events);
    await tx.query(`DELETE FROM ${table} WHERE event_id = ANY($1::text[])`, [
      rows.map((row) => row.event_id),
    ]);
    return { moved: rows.length, more: rows.length === limit };
  });
}

/** A projection that reads compute's `authz_projection` through a (read-only) replica connection. */
export function replicaProjection(
  options: { sql: SqlExecutor } & Omit<AuthzProjectionOptions, 'source'>,
): AuthzProjection {
  const { sql, ...rest } = options;
  return createAuthzProjection({ ...rest, source: sqlProjectionSource(sql) });
}

const signatureHeader = 'x-better-compute-signature';

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface HttpInboxOptions {
  /** compute's inbox endpoint (mounted with `createInboxHandler`). */
  url: string;
  /** Shared secret, at least 32 characters. */
  secret: string;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
}

function checkSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 32)
    throw new ComputeError('INVALID_CONFIG', 'The inbox secret must be at least 32 characters');
}

/** Posts batches to compute, signed `t=<ms>,v1=<hmac-sha256(t.body)>`; any non-2xx rejects (the plugin spills). */
export function httpInbox(options: HttpInboxOptions): InboxWriter {
  checkSecret(options.secret);
  const clock = options.clock ?? systemClock;
  const send = options.fetch ?? globalThis.fetch;
  return {
    async put(events) {
      if (events.length === 0) return;
      const body = JSON.stringify({ events });
      const timestamp = clock.now();
      const response = await send(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [signatureHeader]: `t=${timestamp},v1=${sign(options.secret, timestamp, body)}`,
        },
        body,
      });
      if (!response.ok)
        throw new ComputeError('DRIVER_ERROR', `The compute inbox answered ${response.status}`);
    },
  };
}

export interface InboxHandlerOptions {
  secret: string;
  /** Where verified events go: `sqlInbox(computeSql)`. */
  inbox: InboxWriter;
  clock?: Clock;
  /** Accepted clock difference. Default 5 minutes. */
  toleranceMs?: number;
  /** Largest accepted body. Default 1 MiB. */
  maxBytes?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** compute's side of `httpInbox`: verifies the signature and timestamp, then writes the events. */
export function createInboxHandler(
  options: InboxHandlerOptions,
): (request: Request) => Promise<Response> {
  checkSecret(options.secret);
  const clock = options.clock ?? systemClock;
  const toleranceMs = options.toleranceMs ?? 300_000;
  const maxBytes = options.maxBytes ?? 1 << 20;
  const unauthorized = () =>
    json(401, { error: { code: 'UNAUTHENTICATED', message: 'Bad signature' } });
  return async (request) => {
    if (request.method !== 'POST')
      return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
    const body = await request.text();
    if (Buffer.byteLength(body) > maxBytes)
      return json(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body too large' } });
    const match = /^t=(\d{1,16}),v1=([0-9a-f]{64})$/.exec(
      request.headers.get(signatureHeader) ?? '',
    );
    if (!match) return unauthorized();
    const timestamp = Number(match[1]);
    if (Math.abs(clock.now() - timestamp) > toleranceMs) return unauthorized();
    const expected = Buffer.from(sign(options.secret, timestamp, body), 'hex');
    const given = Buffer.from(match[2]!, 'hex');
    if (!timingSafeEqual(expected, given)) return unauthorized();
    let events: InboxEvent[];
    try {
      const parsed = JSON.parse(body) as { events?: unknown };
      if (!Array.isArray(parsed.events)) throw new Error('events must be an array');
      events = parsed.events.map((item) => {
        const event = item as Partial<InboxEvent>;
        if (
          typeof event.eventId !== 'string' ||
          typeof event.tenantId !== 'string' ||
          typeof event.sequence !== 'number' ||
          typeof event.occurredAt !== 'number' ||
          typeof event.action !== 'string' ||
          typeof event.body !== 'object' ||
          event.body === null
        )
          throw new Error('malformed event');
        return event as InboxEvent;
      });
    } catch (error) {
      return json(400, { error: { code: 'INVALID_INPUT', message: (error as Error).message } });
    }
    await options.inbox.put(events);
    return json(200, { accepted: events.length });
  };
}

export interface ComputeIamHostOptions extends ComputeCatalogOptions {
  /** A replica of compute's authz projection (`replicaProjection({ sql })`). */
  projection: AuthzProjection;
  /** Where events go (`postgresInbox`, `httpInbox`). */
  inbox: ManagedInbox;
  /** The IAM root tenant: `compute-fleet/global` resolves only there. */
  rootTenantId: string | (() => string | undefined);
  /** The host's own resource types. */
  hostFallback?: ResourceResolver;
  timeoutMs?: number;
  spill?: number;
}

export interface ComputeIamHost {
  /** For `betterIam({ plugins })`; its `migrate` creates the inbox's storage during `iam.initialize()`. */
  plugin: ComputeIamPlugin;
  /** For `betterIam({ resolveResource })`. */
  resolveResource: ResourceResolver;
  projection: AuthzProjection;
  /** Loads the projection and starts tailing; until then compute decisions on this host deny. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * Everything an IAM deployment compute does not run installs (§12.1 remote column). Every process that
 * constructs `betterIam()` on that IAM database must install it (failure modes a and b).
 */
export function computeIamHost(options: ComputeIamHostOptions): ComputeIamHost {
  const plugin = computeIamPlugin({
    ...options,
    inbox: options.inbox,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.spill === undefined ? {} : { spill: options.spill }),
  });
  if (options.inbox.ensure) {
    const ensure = options.inbox.ensure.bind(options.inbox);
    plugin.migrate = async () => {
      await ensure();
    };
  }
  return {
    plugin,
    resolveResource: computeResolver(options.projection, {
      ...(options.typePrefix ? { typePrefix: options.typePrefix } : {}),
      rootTenantId: options.rootTenantId,
      ...(options.hostFallback ? { hostFallback: options.hostFallback } : {}),
    }),
    projection: options.projection,
    start: () => options.projection.start(),
    stop: () => options.projection.stop(),
  };
}
